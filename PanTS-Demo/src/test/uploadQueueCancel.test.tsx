import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// Files upload one at a time, so every scan after the first waits its turn
// ("Waiting to upload…"). Cancelling one that is still waiting has to take it
// out of the line: it used to be marked Cancelled and then start uploading
// anyway once the file in front of it was done, and its unsent bytes kept the
// "safe to close" line saying to keep the tab open.

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

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

beforeEach(() => {

  __resetUploadTabState();
  calls = [];
  store.pending = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, sid: sessionOf(init?.body) });
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
    if (u.includes("/api/run-epai-inference")) return json({ message: "Segmentation started" });
    if (u.includes("/api/inference-status/")) return json({ status: "queued", queue_position: 1 });
    if (u.includes("/api/cancel-inference/")) return json({ status: "cancelled" });
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

const statusOf = (sid: string) =>
  (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).find(
    (u) => u.sessionId === sid,
  )?.status;

/** Two runs a signed-in session left half-sent: the first is next on the wire, the second waits behind it. */
const seedTwoResumableRuns = () => {
  const entry = (sessionId: string, label: string): RecentUpload => ({
    sessionId,
    label,
    model: "ePAI",
    status: "Processing",
    timestamp: Date.now(),
    ownerId: "u1",
  });
  localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([entry("sid-a", "Scan A"), entry("sid-b", "Scan B")]));
  store.pending = ["sid-a", "sid-b"].map((sessionId) => ({
    sessionId,
    file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
    filename: `${sessionId}.nii.gz`,
    model: "ePAI",
    bdmapId: "",
    totalChunks: 2,
    nextChunk: 0,
    chunkSize: CHUNK_SIZE,
  }));
};

const cardOf = (label: string) => screen.getByText(label).closest<HTMLElement>(".upload-proc-card")!;

describe("cancelling an upload that is waiting for its turn", () => {
  it("takes it out of the line, so it never starts", async () => {
    const user = userEvent.setup();
    seedTwoResumableRuns();
    renderUpload();
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-a")).toHaveLength(2));
    expect(within(cardOf("Scan B")).getByText("Waiting to upload…")).toBeInTheDocument();

    await user.click(within(cardOf("Scan B")).getByRole("button", { name: /^Cancel\b/ }));
    expect(statusOf("sid-b")).toBe("Cancelled");

    // The file in front finishes and is dispatched; the line moves on.
    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-a")).toHaveLength(1));
    await flush();
    await flush();

    expect(callsTo("/api/upload-inference-chunk", "sid-b")).toHaveLength(0);
    expect(callsTo("/api/finalize-upload", "sid-b")).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference", "sid-b")).toHaveLength(0);
    expect(statusOf("sid-b")).toBe("Cancelled");
    expect(statusOf("sid-a")).toBe("Processing");

    // Its unsent bytes no longer count: nothing is left to keep the tab open for.
    expect((await screen.findAllByText(/safe to close$/, {}, { timeout: 2500 })).length).toBeGreaterThan(0);
  });

  it("also works from a page mounted after the one that queued it", async () => {
    const user = userEvent.setup();
    seedTwoResumableRuns();
    const first = renderUpload();
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-a")).toHaveLength(2));

    // The waiting upload is on the earlier page's line; the returned page can
    // still cancel it.
    first.unmount();
    renderUpload();
    await settledSignedIn();
    await user.click(within(cardOf("Scan B")).getByRole("button", { name: /^Cancel\b/ }));

    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-a")).toHaveLength(1));
    await flush();
    await flush();

    expect(callsTo("/api/upload-inference-chunk", "sid-b")).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference", "sid-b")).toHaveLength(0);
    expect(statusOf("sid-b")).toBe("Cancelled");
  });
});
