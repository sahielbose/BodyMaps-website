import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// The holds that keep one tab from starting a session twice only see that
// tab, but the IndexedDB upload and the run list are shared by every tab open
// on /upload. A Web Lock per session says which tab is carrying it: another
// tab leaves that session alone (and takes it up when the lock goes, which
// includes the holder closing), so a resumable upload is never sent twice.

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

// jsdom has no navigator.locks either. This is the part of the spec the page
// uses: exclusive locks by name, ifAvailable, and a queued request that an
// AbortSignal can withdraw. The lock is held until the callback's promise
// settles.
type LockCallback = (lock: { name: string } | null) => unknown;
type LockOptions = { ifAvailable?: boolean; signal?: AbortSignal };
const makeLockManager = () => {
  const held = new Set<string>();
  const waiting: { name: string; grant: () => void }[] = [];
  const request = (name: string, a: LockOptions | LockCallback, b?: LockCallback): Promise<unknown> => {
    const options = typeof a === "function" ? {} : a;
    const callback = (typeof a === "function" ? a : b)!;
    return new Promise((resolve, reject) => {
      const grant = () => {
        held.add(name);
        Promise.resolve(callback({ name }))
          .then(resolve, reject)
          .finally(() => {
            held.delete(name);
            const next = waiting.findIndex((w) => w.name === name);
            if (next >= 0) waiting.splice(next, 1)[0].grant();
          });
      };
      if (!held.has(name)) {
        grant();
      } else if (options.ifAvailable) {
        Promise.resolve(callback(null)).then(resolve, reject);
      } else {
        const entry = { name, grant };
        waiting.push(entry);
        options.signal?.addEventListener("abort", () => {
          const at = waiting.indexOf(entry);
          if (at < 0) return;
          waiting.splice(at, 1);
          reject(new DOMException("Aborted", "AbortError"));
        });
      }
    });
  };
  /** Another tab takes a lock; the returned function is that tab letting go (or closing). */
  const holdAsOtherTab = (name: string) => {
    let release!: () => void;
    void request(name, () => new Promise<void>((resolve) => (release = resolve)));
    return () => release();
  };
  return { request, held, holdAsOtherTab };
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

type Call = { url: string; sid: string };
let calls: Call[] = [];
/** Chunk uploads wait on this until the test opens it. */
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
  locks = makeLockManager();
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const sid = sessionOf(init?.body);
    calls.push({ url: u, sid });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      await gate;
      return json({ ok: true });
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

/** Lets queued promise chains and effects run. */
const flush = () => new Promise((r) => setTimeout(r, 60));

const entry = (sessionId: string, label: string, status: RecentUpload["status"] = "Processing"): RecentUpload => ({
  sessionId,
  label,
  model: "ePAI",
  status,
  timestamp: Date.now(),
  ownerId: "u1",
});

const seedRecent = (...entries: RecentUpload[]) =>
  localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(entries));

const statusOf = (sid: string) =>
  (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).find(
    (u) => u.sessionId === sid,
  )?.status;

/** A half-sent upload in this browser's IndexedDB. */
const halfSent = (sessionId: string): PendingUpload => ({
  sessionId,
  file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
  filename: `${sessionId}.nii.gz`,
  model: "ePAI",
  bdmapId: "",
  totalChunks: 2,
  nextChunk: 0,
  chunkSize: CHUNK_SIZE,
});

const cardOf = (label: string) => screen.getByText(label).closest<HTMLElement>(".upload-proc-card")!;

describe("a session another tab is carrying", () => {
  it("is not resumed by this tab, which says it is uploading elsewhere", async () => {
    seedRecent(entry("sid-x", "Scan X"));
    store.pending = [halfSent("sid-x")];
    locks.holdAsOtherTab(lockOf("sid-x"));

    renderUpload();
    await settledSignedIn();
    await flush();
    await flush();

    expect(callsTo("/api/upload-inference-chunk", "sid-x")).toHaveLength(0);
    expect(callsTo("/api/finalize-upload", "sid-x")).toHaveLength(0);
    expect(within(cardOf("Scan X")).getByText("Uploading in another tab…")).toBeInTheDocument();
    // This tab is not sending anything, so it is free to close.
    expect(within(cardOf("Scan X")).getByText(/safe to close$/)).toBeInTheDocument();
  });

  it("is taken over from IndexedDB when the other tab closes without finishing it", async () => {
    seedRecent(entry("sid-x", "Scan X"));
    store.pending = [halfSent("sid-x")];
    const otherTabCloses = locks.holdAsOtherTab(lockOf("sid-x"));

    renderUpload();
    await settledSignedIn();
    await flush();
    expect(callsTo("/api/upload-inference-chunk", "sid-x")).toHaveLength(0);

    openGate();
    otherTabCloses();

    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-x")).toHaveLength(2));
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-x")).toHaveLength(1));
    expect(callsTo("/api/finalize-upload", "sid-x")).toHaveLength(1);
    expect(await screen.findByText("#1 in queue")).toBeInTheDocument();
  });

  it("is left as the other tab ended it when that tab finishes", async () => {
    seedRecent(entry("sid-x", "Scan X"));
    store.pending = [halfSent("sid-x")];
    const otherTabFinishes = locks.holdAsOtherTab(lockOf("sid-x"));

    renderUpload();
    await settledSignedIn();
    await flush();

    // The other tab uploaded it, was cancelled from there, and let go.
    store.pending = [];
    seedRecent(entry("sid-x", "Scan X", "Cancelled"));
    otherTabFinishes();
    await waitFor(() => expect(screen.queryByText("Uploading in another tab…")).not.toBeInTheDocument());
    await flush();

    expect(callsTo("/api/upload-inference-chunk", "sid-x")).toHaveLength(0);
    expect(callsTo("/api/inference-status/", "sid-x")).toHaveLength(0);
    expect(statusOf("sid-x")).toBe("Cancelled");
  });

  it("is not polled for before the other tab has dispatched it", async () => {
    // Run in another tab: the run is listed, but its upload lives only in that
    // tab (no IndexedDB copy), and the server has no job for it yet.
    seedRecent(entry("sid-x", "Scan X"));
    const otherTabDispatches = locks.holdAsOtherTab(lockOf("sid-x"));

    renderUpload();
    await settledSignedIn();
    await flush();
    await flush();
    expect(callsTo("/api/inference-status/", "sid-x")).toHaveLength(0);
    expect(statusOf("sid-x")).toBe("Processing");

    dispatched.add("sid-x");
    otherTabDispatches();
    await waitFor(() => expect(callsTo("/api/inference-status/", "sid-x").length).toBeGreaterThan(0));
    expect(await screen.findByText("#1 in queue")).toBeInTheDocument();
  });
});

describe("a session this tab is carrying", () => {
  it("holds the session's lock for as long as it uploads and dispatches it", async () => {
    seedRecent(entry("sid-y", "Scan Y"));
    store.pending = [halfSent("sid-y")];

    renderUpload();
    await settledSignedIn();
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk", "sid-y")).toHaveLength(2));
    expect(locks.held.has(lockOf("sid-y"))).toBe(true);

    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-y")).toHaveLength(1));
    await waitFor(() => expect(locks.held.has(lockOf("sid-y"))).toBe(false));
  });
});

describe("a run started on this page", () => {
  it("holds its session's lock from Run until its job is dispatched", async () => {
    const user = userEvent.setup();
    const page = renderUpload();
    await settledSignedIn();
    const input = page.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], "scan.nii.gz", { type: "application/gzip" }));
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk")).toHaveLength(2));
    const sid = callsTo("/api/upload-inference-chunk")[0].sid;

    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(locks.held.has(lockOf(sid))).toBe(true));

    openGate();
    await waitFor(() => expect(callsTo("/api/run-epai-inference", sid)).toHaveLength(1));
    await waitFor(() => expect(locks.held.has(lockOf(sid))).toBe(false));
  });
});

describe("a browser without Web Locks", () => {
  it("still resumes the upload, as before", async () => {
    Reflect.deleteProperty(navigator, "locks");
    seedRecent(entry("sid-z", "Scan Z"));
    store.pending = [halfSent("sid-z")];
    openGate();

    renderUpload();
    await settledSignedIn();

    await waitFor(() => expect(callsTo("/api/run-epai-inference", "sid-z")).toHaveLength(1));
    expect(callsTo("/api/upload-inference-chunk", "sid-z")).toHaveLength(2);
  });
});
