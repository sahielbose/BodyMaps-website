import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// Leaving /upload unmounts the page but not its uploads: they carry on in the
// old page's closures. Coming back mid-transfer must not start the same
// session a second time (two copies racing to finalize, the loser marking a
// healthy run Failed), nor poll for a job that doesn't exist yet (three misses
// and the card went Failed while the first page was still uploading).

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

type Call = { url: string; sid: string; signal?: AbortSignal | null };
let calls: Call[] = [];
/** Chunk uploads wait on this until the test opens it (or they are aborted). */
let gate: Promise<void>;
let openGate: () => void;
/** Sessions the server has a job for; any other one is not_found. */
let dispatched: Set<string>;

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

beforeEach(() => {

  __resetUploadTabState();
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
    calls.push({ url: u, sid, signal: init?.signal });
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
    if (u.includes("/api/cancel-inference/")) return json({ status: "cancelled" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  // Let anything a test left waiting finish, then drop the mocks.
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

const statusOf = (sid: string) =>
  (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).find(
    (u) => u.sessionId === sid,
  )?.status;

describe("leaving /upload mid-transfer and coming back", () => {
  it("does not start a resumable upload a second time, and picks up its outcome", async () => {
    const sid = "sid-resuming";
    localStorage.setItem(
      RECENT_UPLOADS_KEY,
      JSON.stringify([
        { sessionId: sid, label: "Scan", model: "ePAI", status: "Processing", timestamp: Date.now(), ownerId: "u1" },
      ]),
    );
    store.pending = [
      {
        sessionId: sid,
        file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
        filename: "a.nii.gz",
        model: "ePAI",
        bdmapId: "",
        totalChunks: 2,
        nextChunk: 0,
        chunkSize: CHUNK_SIZE,
      },
    ];

    // The page resumes the upload; its chunks are on the wire.
    const first = renderUpload();
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(2));

    // Leave and come back while they are still going.
    first.unmount();
    renderUpload();
    await settledSignedIn();
    await flush();
    await flush();

    expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(2);
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(0);
    expect(screen.getByText("Uploading…")).toBeInTheDocument();

    // The first copy finishes: one finalize, one dispatch, and the page that
    // is showing now polls the job it created.
    openGate();
    await waitFor(() => expect(callsTo("/api/inference-status/", sid).length).toBeGreaterThan(0));
    expect(callsTo("/api/finalize-upload", sid)).toHaveLength(1);
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1);
    expect(await screen.findByText("#1 in queue")).toBeInTheDocument();
    expect(statusOf(sid)).toBe("Processing");
  });

  it("waits for a pre-upload that Run handed on instead of polling a job that isn't there yet", async () => {
    const user = userEvent.setup();
    const first = renderUpload();
    await settledSignedIn();

    const input = first.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(2));
    const sid = callsTo("/api/upload-inference-chunk")[0].sid;
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(statusOf(sid)).toBe("Processing"));

    first.unmount();
    renderUpload();
    await settledSignedIn();
    await flush();
    await flush();

    // Nothing polled the server for a job it doesn't have yet.
    expect(callsTo("/api/inference-status/", sid)).toHaveLength(0);
    expect(statusOf(sid)).toBe("Processing");

    openGate();
    await waitFor(() => expect(callsTo("/api/inference-status/", sid).length).toBeGreaterThan(0));
    expect(callsTo("/api/upload-inference-chunk", sid)).toHaveLength(2);
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1);
    expect(await screen.findByText("#1 in queue")).toBeInTheDocument();
    expect(statusOf(sid)).toBe("Processing");
  });

  it("lets Cancel on the returned page stop the upload the earlier page started", async () => {
    const user = userEvent.setup();
    const first = renderUpload();
    await settledSignedIn();

    const input = first.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(2));
    const inFlight = callsTo("/api/upload-inference-chunk");
    const sid = inFlight[0].sid;
    await user.click(screen.getByRole("button", { name: "Run" }));

    first.unmount();
    renderUpload();
    await settledSignedIn();
    await user.click(await screen.findByRole("button", { name: /^Cancel\b/ }));

    expect(inFlight.every((c) => c.signal?.aborted)).toBe(true);
    await flush();
    expect(statusOf(sid)).toBe("Cancelled");
    expect(callsTo("/api/finalize-upload", sid)).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(0);
  });

  it("keeps saying the tab is needed, and warns before unload, while the earlier page is still sending", async () => {
    const user = userEvent.setup();
    const first = renderUpload();
    await settledSignedIn();

    // A pre-upload has no IndexedDB copy, so closing the tab would lose it.
    const input = first.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(2));
    await user.click(screen.getByRole("button", { name: "Run" }));

    first.unmount();
    renderUpload();
    await settledSignedIn();

    // The close note refreshes once a second.
    expect(await screen.findByText(/keep tab open/, {}, { timeout: 2500 })).toBeInTheDocument();
    expect(screen.queryByText(/safe to close$/)).not.toBeInTheDocument();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    // Once the bytes land the tab is free again.
    openGate();
    expect(await screen.findByText(/safe to close$/, {}, { timeout: 2500 })).toBeInTheDocument();
    // The warning comes off in an effect's cleanup, which can trail the text
    // it is derived from, so it is asked again until it has gone.
    await waitFor(() => {
      const after = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
    });
  });
});
