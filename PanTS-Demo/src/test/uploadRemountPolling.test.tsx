import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage from "../routes/UploadPage";

// An upload the Run button started carries on after the page is left, and its
// dispatch (the call that creates the server job) can land while no /upload
// page is mounted, or while a returned one is waiting on it. Whoever starts the
// status poller then must be the page that is showing: the old page's closures
// used to start one that ran on with nobody looking, beside the one the
// returned page starts for the same session, so the server was asked about one
// job twice on every round.

// jsdom has no IndexedDB, so the resumable-upload store is faked.
const store = vi.hoisted(() => ({ pending: [] as PendingUpload[] }));
vi.mock("../helpers/pendingUploads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/pendingUploads")>();
  return {
    ...actual,
    loadPendingUploads: vi.fn(async () => store.pending),
    deletePendingUpload: vi.fn(async (sid: string) => {
      store.pending = store.pending.filter((p) => p.sessionId !== sid);
    }),
    savePendingUpload: vi.fn(async () => true),
    setPendingNextChunk: vi.fn(async () => {}),
    setPendingUploaded: vi.fn(async () => {}),
  };
});

const CHUNK_SIZE = 512 * 1024;
const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const sessionOf = (body: unknown): string => {
  if (body instanceof FormData) return String(body.get("session_id") ?? "");
  if (body instanceof URLSearchParams) return String(body.get("session_id") ?? "");
  return "";
};

type Call = { url: string; sid: string };
let calls: Call[] = [];
/** Chunk uploads wait on this until the test opens it (or they are aborted). */
let gate: Promise<void>;
let openGate: () => void;
/** Sessions the server has a job for; any other one is not_found. */
let dispatched: Set<string>;

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

beforeEach(() => {
  calls = [];
  dispatched = new Set();
  store.pending = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const sid = sessionOf(init?.body);
    calls.push({ url: u, sid });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        void gate.then(() => resolve(json({ ok: true })));
      });
    }
    if (u.includes("/api/upload-status")) return json({ received: [] });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    if (u.includes("/api/run-epai-inference")) {
      dispatched.add(sid);
      return json({ message: "Segmentation started" });
    }
    if (u.includes("/api/inference-status/")) {
      const polled = u.split("/").pop()!;
      return dispatched.has(polled)
        ? json({ status: "queued", queue_position: 1 })
        : json({ status: "not_found" }, false, 404);
    }
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  openGate();
  vi.restoreAllMocks();
});

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const settledSignedIn = () => screen.findByRole("button", { name: /^Model ePAI$/ });

/** Lets queued promise chains and effects run. */
const flush = () => new Promise((r) => setTimeout(r, 60));

/** Picks a two-chunk file, waits for its bytes to be on the wire, presses Run. */
const runAPreUpload = async (container: HTMLElement) => {
  const user = userEvent.setup();
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
  await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(2));
  const sid = callsTo("/api/upload-inference-chunk")[0].sid;
  await user.click(screen.getByRole("button", { name: "Run" }));
  return sid;
};

describe("status polling across leaving and returning to /upload", () => {
  it("does not poll for a job the earlier page dispatches while no page is showing", async () => {
    const first = renderUpload();
    await settledSignedIn();
    const sid = await runAPreUpload(first.container);

    // Leave, and let the bytes land while no /upload page is mounted: the
    // earlier page's closures finalize and dispatch on their own.
    first.unmount();
    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1));
    await flush();
    await flush();

    // Nobody is looking at the job, so nothing asks about it.
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(0);

    // Coming back picks the job up, and exactly one poller asks about it.
    renderUpload();
    expect(await screen.findByText("#1 in queue")).toBeInTheDocument();
    await flush();
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(1);
  });

  it("polls a job once when the page returns while the earlier page is still sending it", async () => {
    const first = renderUpload();
    await settledSignedIn();
    const sid = await runAPreUpload(first.container);

    first.unmount();
    renderUpload();
    await settledSignedIn();
    await flush();
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(0);

    // The earlier page finishes the upload and dispatches while the returned
    // page waits on it; only the returned page follows the job from there.
    openGate();
    expect(await screen.findByText("#1 in queue")).toBeInTheDocument();
    await flush();
    await flush();
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1);
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(1);
  });
});
