import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

// How a multi-file run is scheduled. Two properties matter and they pull in
// opposite directions, so both are pinned here:
//
//   1. Files upload ONE AT A TIME. Uploading them concurrently doesn't create
//      bandwidth - it just makes every file finish at the same late moment,
//      leaving the GPU idle for the whole upload.
//   2. Each file is dispatched to the server's job queue the instant its OWN
//      upload finishes, NOT after the batch. The server queues behind a
//      one-at-a-time GPU lock, so dispatching early means scan 1 is already
//      segmenting while scan 2 is still going up.

const CHUNK_SIZE = 512 * 1024;
const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "pro" };

// Comfortably more chunks than the uploader's in-flight concurrency (6), so a
// concurrent schedule would visibly interleave the two files rather than
// happening to drain one before the other.
const CHUNKS_PER_FILE = 10;
const makeFile = (name: string) =>
  new File([new Uint8Array(CHUNK_SIZE * CHUNKS_PER_FILE)], name, {
    type: "application/gzip",
  });

/** Ordered log of the upload-relevant requests, tagged with their session. */
let log: { kind: "chunk" | "finalize" | "infer"; sid: string }[] = [];

// Uploads now start the moment a file is picked, not on Run - so with a fixed,
// short per-chunk delay both files can easily finish uploading before the test
// even gets to clicking Run, leaving nothing in flight for that click to race
// against. Gating the SECOND session's chunks behind this (resolved only once
// the test has clicked Run) makes "scan 1 dispatches while scan 2 is still
// uploading" a guaranteed scenario instead of a coin flip against real timers.
let secondSessionGate: Promise<void> | null = null;
let releaseSecondSession: (() => void) | null = null;
let firstSid: string | null = null;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const sessionOf = (body: unknown): string => {
  if (body instanceof FormData) return String(body.get("session_id"));
  if (body instanceof URLSearchParams) return String(body.get("session_id"));
  return "";
};

beforeEach(() => {
  log = [];
  firstSid = null;
  releaseSecondSession = null;
  secondSessionGate = new Promise((res) => {
    releaseSecondSession = res;
  });
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const sid = sessionOf(init?.body);

    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });

    if (u.includes("/api/upload-inference-chunk")) {
      // The first session to reach a chunk claims that slot; every other
      // session's chunks wait on the gate below, holding it "in flight" until
      // the test explicitly releases it (after clicking Run).
      if (firstSid === null) firstSid = sid;
      if (sid !== firstSid) await secondSessionGate;
      log.push({ kind: "chunk", sid });
      return json({ ok: true });
    }
    if (u.includes("/api/finalize-upload")) {
      log.push({ kind: "finalize", sid });
      return json({ uploaded_filename: "ct.nii.gz" });
    }
    if (u.includes("/api/run-epai-inference")) {
      log.push({ kind: "infer", sid });
      return json({ message: "Segmentation started", session_id: sid });
    }
    if (u.includes("/api/inference-status/")) return json({ status: "queued" });

    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;

  localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

const runTwoFiles = async () => {
  const user = userEvent.setup();
  const { container } = render(
    <AuthProvider>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );
  // Inference requires an account; wait for the session probe to land first.
  await waitFor(() =>
    expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
  );

  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, [makeFile("scan-a.nii.gz"), makeFile("scan-b.nii.gz")]);

  // The first file's upload starts immediately on selection (before a model is
  // even picked) - wait for it to fully land so scan A is the one holding
  // firstSid, then let the model-picking clicks happen. Scan B's chunks stay
  // parked on the gate this whole time, so it's still uploading when Run is
  // clicked below - the scenario the second test needs.
  await waitFor(() => expect(log.some((e) => e.kind === "finalize")).toBe(true));

  // Default model becomes "ePAI" once the account's plan is known to allow
  // it (this test's USER is "pro") - by now auth has long since settled and
  // an upload round-trip has happened, so no dropdown click is needed before
  // Run.
  await user.click(screen.getByRole("button", { name: "Run" }));

  // Only now let scan B's upload proceed - mirrors it still being on the wire
  // at the moment the user clicks Run, which is the realistic case now that
  // uploads start at selection time instead of waiting for Run.
  releaseSecondSession?.();

  await waitFor(
    () => expect(log.filter((e) => e.kind === "infer")).toHaveLength(2),
    { timeout: 5000 },
  );
};

describe("multi-file upload scheduling", () => {
  it("uploads one file at a time instead of interleaving them", async () => {
    await runTwoFiles();

    const chunks = log.filter((e) => e.kind === "chunk");
    expect(chunks).toHaveLength(CHUNKS_PER_FILE * 2);

    // Serialized means the session id changes exactly once across the whole
    // chunk stream; an interleaved schedule would flip back and forth.
    const switches = chunks.filter((e, i) => i > 0 && e.sid !== chunks[i - 1].sid);
    expect(switches).toHaveLength(1);
  });

  it("dispatches each file to the GPU queue without waiting for the batch", async () => {
    await runTwoFiles();

    const firstSid = log[0].sid;
    const secondSid = log.find((e) => e.sid !== firstSid)!.sid;
    const firstInfer = log.findIndex((e) => e.kind === "infer" && e.sid === firstSid);
    const secondFinalize = log.findIndex((e) => e.kind === "finalize" && e.sid === secondSid);

    expect(firstInfer).toBeGreaterThan(-1);
    // Uploads now start the moment a file is picked (not on Run), so scan 2's
    // chunks can already be on the wire by the time scan 1 dispatches - that's
    // the point, not a bug. What still must never happen is the barrier
    // alternative, where nothing dispatches until every file has fully
    // uploaded: scan 1's dispatch has to land before scan 2 even *finishes*.
    expect(firstInfer).toBeLessThan(secondFinalize);
  });

  it("gives each file its own session so results don't collide", async () => {
    await runTwoFiles();

    const infers = log.filter((e) => e.kind === "infer").map((e) => e.sid);
    expect(new Set(infers).size).toBe(2);
    // Every file that uploaded also got dispatched - nothing stranded on the
    // server without a job.
    expect(new Set(log.filter((e) => e.kind === "finalize").map((e) => e.sid)))
      .toEqual(new Set(infers));
  });
});
