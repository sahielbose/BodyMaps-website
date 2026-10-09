import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// Only the tab carrying a session (the one holding its Web Lock) has its
// upload's abort controller and its place in the upload line, so a Cancel
// pressed in another tab, on the card that says "Uploading in another tab…",
// used to stop nothing: that tab went on to finalize and dispatch the run.
// The tab that cancels now announces it on a BroadcastChannel; the holder
// stops the upload and refreshes its cards.

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

// jsdom has no navigator.locks either: exclusive locks by name with
// ifAvailable, held until the callback's promise settles.
type LockCallback = (lock: { name: string } | null) => unknown;
type LockOptions = { ifAvailable?: boolean; signal?: AbortSignal };
const makeLockManager = () => {
  const held = new Set<string>();
  const request = (name: string, a: LockOptions | LockCallback, b?: LockCallback): Promise<unknown> => {
    const options = typeof a === "function" ? {} : a;
    const callback = (typeof a === "function" ? a : b)!;
    return new Promise((resolve, reject) => {
      if (!held.has(name)) {
        held.add(name);
        Promise.resolve(callback({ name }))
          .then(resolve, reject)
          .finally(() => held.delete(name));
      } else if (options.ifAvailable) {
        Promise.resolve(callback(null)).then(resolve, reject);
      } else {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }
    });
  };
  /** Another tab takes a lock and keeps it. */
  const holdAsOtherTab = (name: string) => {
    void request(name, () => new Promise<void>(() => {}));
  };
  return { request, holdAsOtherTab };
};
let locks: ReturnType<typeof makeLockManager>;
const lockOf = (sid: string) => `bodymaps-upload:${sid}`;

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
/** What the server answers to finalizing an upload, and to cancelling a run. */
let finalizeReply: () => ReturnType<typeof json>;
let cancelReply: () => ReturnType<typeof json>;
/** While set, finalizing an upload waits until the request is aborted or finalizeGate opens. */
let holdFinalize: boolean;
let finalizeGate: Promise<void>;
let openFinalize: () => void;
/** While set, chunk uploads are refused (as when the server rejects a file). */
let refuseChunks: boolean;
/** While set, the request to start the run waits (until aborted, or dispatchGate opens). */
let holdDispatch: boolean;
let dispatchGate: Promise<void>;
let openDispatch: () => void;
/** Chunk uploads wait on this until the test opens it (or they are aborted). */
let gate: Promise<void>;
let openGate: () => void;

const callsTo = (path: string, sid?: string) =>
  calls.filter((c) => c.url.includes(path) && (sid === undefined || c.sid === sid || c.url.endsWith(`/${sid}`)));

/** What the other tabs on /upload would hear and say. */
const CANCEL_CHANNEL = "bodymaps-upload-cancel";
let otherTab: BroadcastChannel;
let heard: unknown[];

beforeEach(() => {

  __resetUploadTabState();
  calls = [];
  heard = [];
  finalizeReply = () => json({ uploaded_filename: "ct.nii.gz" });
  cancelReply = () => json({ error: "No such run" }, false, 404);
  holdFinalize = false;
  refuseChunks = false;
  finalizeGate = new Promise((resolve) => {
    openFinalize = resolve;
  });
  holdDispatch = false;
  dispatchGate = new Promise((resolve) => {
    openDispatch = resolve;
  });
  store.pending = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  localStorage.clear();
  locks = makeLockManager();
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  otherTab = new BroadcastChannel(CANCEL_CHANNEL);
  otherTab.addEventListener("message", (e: MessageEvent) => heard.push(e.data));
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, sid: sessionOf(init?.body), signal: init?.signal });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-dicom-slice")) return json({ ok: true });
    if (u.includes("/api/finalize-dicom")) {
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        void finalizeGate.then(() => resolve(json({ uploaded_filename: "ct.nii.gz" })));
      });
    }
    if (u.includes("/api/upload-inference-chunk")) {
      if (refuseChunks) return json({ error: "Refused" }, false, 400);
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        void gate.then(() => resolve(json({ ok: true })));
      });
    }
    if (u.includes("/api/upload-status")) return json({ received: [] });
    if (u.includes("/api/finalize-upload")) {
      if (!holdFinalize) return finalizeReply();
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        void finalizeGate.then(() => resolve(finalizeReply()));
      });
    }
    if (u.includes("/api/run-epai-inference")) {
      if (!holdDispatch) return json({ message: "Segmentation started" });
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        void dispatchGate.then(() => resolve(json({ message: "Segmentation started" })));
      });
    }
    if (u.includes("/api/inference-status/")) return json({ status: "not_found" }, false, 404);
    if (u.includes("/api/cancel-inference/")) return cancelReply();
    if (u.includes("/api/discard-upload/")) return json({ status: "discarded" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  openGate();
  openDispatch();
  openFinalize();
  otherTab.close();
  Reflect.deleteProperty(navigator, "locks");
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

/** Lets queued promise chains, effects and channel messages run. */
const flush = () => new Promise((r) => setTimeout(r, 60));

const entry = (sessionId: string, label: string): RecentUpload => ({
  sessionId,
  label,
  model: "ePAI",
  status: "Processing",
  timestamp: Date.now(),
  ownerId: "u1",
});

const seedRun = (sessionId: string, label: string) => {
  localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([entry(sessionId, label)]));
  store.pending = [
    {
      sessionId,
      file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
      filename: `${sessionId}.nii.gz`,
      model: "ePAI",
      bdmapId: "",
      totalChunks: 2,
      nextChunk: 0,
      chunkSize: CHUNK_SIZE,
    },
  ];
};

const statusOf = (sid: string) =>
  (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).find(
    (u) => u.sessionId === sid,
  )?.status;

const cardOf = (label: string) => screen.getByText(label).closest<HTMLElement>(".upload-proc-card")!;

/** What the tab that pressed Cancel does before it says so: the card is Cancelled. */
const cancelInOtherTab = (sid: string) => {
  const list = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
  localStorage.setItem(
    RECENT_UPLOADS_KEY,
    JSON.stringify(list.map((u) => (u.sessionId === sid ? { ...u, status: "Cancelled" } : u))),
  );
  otherTab.postMessage({ sid });
};

describe("cancelling a run that another tab is carrying", () => {
  it("stops the upload in the tab that carries it, so it is never dispatched", async () => {
    seedRun("sid-c", "Scan C");
    renderUpload();
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-c")).toHaveLength(2));
    const inFlight = callsTo("/api/upload-inference-chunk", "sid-c");
    expect(inFlight.every((c) => c.signal && !c.signal.aborted)).toBe(true);

    cancelInOtherTab("sid-c");

    await waitFor(() => expect(inFlight.every((c) => c.signal?.aborted)).toBe(true));
    // Its card goes too, instead of saying "Uploading…" until the page is reopened.
    await waitFor(() => expect(document.querySelector(".upload-proc-card")).toBeNull());
    openGate();
    await flush();
    await flush();
    expect(callsTo("/api/finalize-upload", "sid-c")).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference", "sid-c")).toHaveLength(0);
    expect(statusOf("sid-c")).toBe("Cancelled");
  });

  it("is announced to the other tabs when Cancel is pressed on a card that says uploading elsewhere", async () => {
    const user = userEvent.setup();
    seedRun("sid-e", "Scan E");
    locks.holdAsOtherTab(lockOf("sid-e"));
    renderUpload();
    await settledSignedIn();
    expect(await within(cardOf("Scan E")).findByText("Uploading in another tab…")).toBeInTheDocument();

    await user.click(within(cardOf("Scan E")).getByRole("button", { name: /^Cancel\b/ }));
    await flush();

    expect(statusOf("sid-e")).toBe("Cancelled");
    expect(heard).toEqual([{ sid: "sid-e" }]);
    // It never uploaded anything itself.
    expect(callsTo("/api/upload-inference-chunk", "sid-e")).toHaveLength(0);
    // No job existed to cancel, so what the other tab uploaded is deleted.
    expect(callsTo("/api/discard-upload/", "sid-e")).toHaveLength(1);
  });

  it("stops the job when the cancel reaches the carrying tab while its run is being started", async () => {
    holdDispatch = true;
    seedRun("sid-h", "Scan H");
    renderUpload();
    await settledSignedIn();
    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-h")).toHaveLength(1));

    // The request is on its way, and the cancel found no job yet.
    cancelInOtherTab("sid-h");
    await flush();

    // The request had already reached the server, so the tab that sent it stops the job.
    expect(callsTo("/api/cancel-inference/", "sid-h")).toHaveLength(1);
    expect(callsTo("/api/inference-status/", "sid-h")).toHaveLength(0);
    expect(statusOf("sid-h")).toBe("Cancelled");
  });

  it("stops the job when the response to starting a run arrives after it was cancelled", async () => {
    holdDispatch = true;
    seedRun("sid-i", "Scan I");
    renderUpload();
    await settledSignedIn();
    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-i")).toHaveLength(1));

    // No announcement reached this tab: only the card says Cancelled.
    const list = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(list.map((u) => ({ ...u, status: "Cancelled" }))));
    openDispatch();
    await flush();
    await flush();

    expect(callsTo("/api/cancel-inference/", "sid-i")).toHaveLength(1);
    expect(callsTo("/api/inference-status/", "sid-i")).toHaveLength(0);
    expect(statusOf("sid-i")).toBe("Cancelled");
  });

  it("does not delete an upload when the run it cancelled had a job", async () => {
    const user = userEvent.setup();
    cancelReply = () => json({ status: "cancelled" });
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([entry("sid-j", "Scan J")]));
    locks.holdAsOtherTab(lockOf("sid-j"));
    renderUpload();
    await settledSignedIn();

    await user.click(within(cardOf("Scan J")).getByRole("button", { name: /^Cancel\b/ }));
    await flush();

    expect(callsTo("/api/cancel-inference/", "sid-j")).toHaveLength(1);
    expect(callsTo("/api/discard-upload/", "sid-j")).toHaveLength(0);
  });

  it("is still not dispatched by the carrying tab when nothing announced it", async () => {
    seedRun("sid-f", "Scan F");
    renderUpload();
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-f")).toHaveLength(2));

    // No BroadcastChannel message: the other tab could only write the card.
    const list = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(list.map((u) => ({ ...u, status: "Cancelled" }))));
    openGate();
    await flush();
    await flush();

    expect(callsTo("/api/run-epai-inference", "sid-f")).toHaveLength(0);
    expect(statusOf("sid-f")).toBe("Cancelled");
    // Finalizing had already assembled the file on the server by then.
    expect(callsTo("/api/finalize-upload", "sid-f")).toHaveLength(1);
    expect(callsTo("/api/discard-upload/", "sid-f")).toHaveLength(1);
  });

  it("does not turn a run cancelled in another tab into Failed when its upload then errors", async () => {
    seedRun("sid-g", "Scan G");
    renderUpload();
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-g")).toHaveLength(2));

    // The other tab cancelled it, and its discard took the staged chunks.
    finalizeReply = () => json({ error: "Upload session not found" }, false, 404);
    const list = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(list.map((u) => ({ ...u, status: "Cancelled" }))));
    openGate();
    await flush();
    await flush();

    expect(callsTo("/api/finalize-upload", "sid-g")).toHaveLength(1);
    expect(statusOf("sid-g")).toBe("Cancelled");
  });
});

// The page has one status line, and a foreground run writes "Finalizing
// upload..." (or "Converting DICOM series...") into it. A run that ends without
// a word of its own, because it was cancelled from another tab, left it there.
describe("the status line of a run cancelled from another tab", () => {
  /** Picks a file whose background upload is refused, so Run starts a run of its own for it. */
  const runFromPickedFile = async (page: ReturnType<typeof renderUpload>) => {
    const user = userEvent.setup();
    refuseChunks = true;
    await settledSignedIn();
    const input = page.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    openGate();
    await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBeGreaterThan(0));
    await flush();
    refuseChunks = false;
    holdFinalize = true;
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Finalizing upload...")).toBeInTheDocument();
    return (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[])[0].sessionId;
  };

  it("no longer says the upload is being finalized once it was stopped", async () => {
    const sid = await runFromPickedFile(renderUpload());

    cancelInOtherTab(sid);

    await waitFor(() => expect(screen.queryByText("Finalizing upload...")).not.toBeInTheDocument());
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(0);
  });

  it("no longer says the upload is being finalized once it was skipped at dispatch", async () => {
    const sid = await runFromPickedFile(renderUpload());

    // No announcement reached this tab, so its upload carries on to the end.
    const list = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(list.map((u) => ({ ...u, status: "Cancelled" }))));
    openFinalize();

    await waitFor(() => expect(screen.queryByText("Finalizing upload...")).not.toBeInTheDocument());
    expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(0);
  });

  it("no longer says a DICOM series is being converted once it was stopped", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: () =>
        Promise.resolve({
          kind: "directory" as const,
          async *values() {
            yield { kind: "file" as const, getFile: async () => new File([new Uint8Array([0, 1, 2])], "slice-001.dcm") };
          },
        }),
    });
    renderUpload();
    await settledSignedIn();
    await user.click(screen.getByRole("button", { name: "Select DICOM" }));
    await screen.findByText("DICOM series (1 slice)");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Converting DICOM series to NIfTI...")).toBeInTheDocument();
    const sid = (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[])[0].sessionId;

    cancelInOtherTab(sid);

    await waitFor(() => expect(screen.queryByText("Converting DICOM series to NIfTI...")).not.toBeInTheDocument());
    Reflect.deleteProperty(window, "showDirectoryPicker");
  });
});
