import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import { queuedDiscards } from "../helpers/discardAfterSignIn";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import { deletePendingUpload, type PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// A run request answered 409 run_in_progress means another request for the
// session is still starting the run (copying and checking the CT, no job yet).
// The page follows the run without giving up on it while the server says it is
// starting, keeps the record of the upload until the job is seen, and, if that
// other request was refused and never made a job, asks for the dispatch again
// once from the record so the real answer comes through.

const store = vi.hoisted(() => ({
  pending: [] as PendingUpload[],
  /** While set, reading the stored records waits for it. */
  gate: null as Promise<void> | null,
}));
vi.mock("../helpers/pendingUploads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/pendingUploads")>();
  return {
    ...actual,
    loadPendingUploads: vi.fn(async () => {
      if (store.gate) await store.gate;
      return store.pending;
    }),
    deletePendingUpload: vi.fn(async (sid: string) => {
      store.pending = store.pending.filter((p) => p.sessionId !== sid);
    }),
    savePendingUpload: vi.fn(async () => true),
    setPendingNextChunk: vi.fn(async () => {}),
    setPendingUploaded: vi.fn(async () => {}),
  };
});

const USER = { id: "u1", email: "one@example.com", name: null, plan: "free" };
const OTHER = { id: "u2", email: "two@example.com", name: null, plan: "free" };
const SID = "sid-c";

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

type Reply = ReturnType<typeof json>;
const missing = (): Reply => json({ status: "not_found" }, false, 404);
const starting = (): Reply => json({ status: "starting", session_id: SID });
const running = (): Reply => json({ status: "running" });
const alreadyRunning = (): Reply => json({ error: "A run for this session is already going.", code: "run_in_progress" }, false, 409);

let calls: { method: string; url: string }[];
/** The n-th (from 1) status request for the session. */
let statusScript: (n: number) => Reply;
/** The n-th (from 1) run request. */
let runScript: (n: number) => Reply;
let statusCount: number;
let runCount: number;
/** What POST /api/discard-upload answers. */
let discardReply: () => Reply;

const stored = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
const seed = () =>
  localStorage.setItem(
    RECENT_UPLOADS_KEY,
    JSON.stringify([
      { sessionId: SID, label: "Scan", model: "ePAI", status: "Processing", timestamp: Date.now() - 60_000, ownerId: "u1" } satisfies RecentUpload,
    ]),
  );
const uploaded = (): PendingUpload => ({
  sessionId: SID,
  file: new Blob([]),
  filename: "ct.nii.gz",
  model: "ePAI",
  bdmapId: "",
  totalChunks: 2,
  nextChunk: 2,
  chunkSize: 512 * 1024,
  uploadedFilename: "ct.nii.gz",
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  __resetUploadTabState();
  calls = [];
  statusCount = 0;
  runCount = 0;
  store.pending = [];
  store.gate = null;
  statusScript = missing;
  discardReply = () => json({ status: "discarded" });
  runScript = () => json({ message: "started" });
  localStorage.clear();
  vi.mocked(deletePendingUpload).mockClear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/login")) return json({ user: OTHER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/run-epai-inference")) return runScript(++runCount);
    if (u.includes("/api/inference-status/")) return statusScript(++statusCount);
    if (u.includes("/api/cancel-inference/")) return json({ error: "Job not found" }, false, 404);
    if (u.includes("/api/discard-upload/")) return discardReply();
    return json({ items: [], total: 0, ids: [], runs: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A stand-in for signing in as somebody else.
const SwitchAccount = () => {
  const { signIn } = useAuth();
  return (
    <button type="button" onClick={() => void signIn("two@example.com", "pw")}>
      test switch account
    </button>
  );
};

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <SwitchAccount />
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const discards = () => calls.filter((c) => c.url.includes("/api/discard-upload/"));
const runRequests = () => calls.filter((c) => c.url.includes("/api/run-epai-inference"));

describe("a run followed after a 409 (another request is starting it)", () => {
  beforeEach(() => {
    seed();
    store.pending = [uploaded()];
  });

  it("is not given up on while the server says it is starting, keeps its record, and drops it once the job is seen", async () => {
    let jobMade = false;
    // The first look is the resume's own question (no job): the run request is
    // then sent and answered 409. The requests after are the follow's.
    statusScript = (n) => (n === 1 ? missing() : jobMade ? running() : starting());
    runScript = alreadyRunning;

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    // Far past the three looks that end a run the server has lost.
    await advance(20000);

    expect(stored()[0].status).toBe("Processing");
    expect(screen.queryByText(/did not start|no longer exists/i)).not.toBeInTheDocument();
    expect(runRequests()).toHaveLength(1);
    expect(deletePendingUpload).not.toHaveBeenCalled();
    expect(store.pending).toHaveLength(1);
    expect(discards()).toHaveLength(0);

    jobMade = true;
    await advance(3000);

    expect(deletePendingUpload).toHaveBeenCalledWith(SID);
    expect(store.pending).toHaveLength(0);
    expect(stored()[0].status).toBe("Processing");
  });

  it("asks for the dispatch again, once, from the record when the other request never made a job, and shows the real answer", async () => {
    statusScript = missing;
    // The other request was refused by the plan; this one meets the same refusal.
    runScript = (n) =>
      n === 1
        ? alreadyRunning()
        : json({ error: "Used up", code: "plan_limit", reason: "daily_scans", plan: "free", limit: 1, used: 1 }, false, 402);

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    await advance(10000);

    expect(runRequests()).toHaveLength(2);
    await waitFor(() => expect(stored()[0].status).toBe("Cancelled"));
    expect(store.pending).toHaveLength(0);
    expect(screen.queryByText(/did not start/i)).not.toBeInTheDocument();
  });

  it("asks for it only once: a second time round the run is failed as not started and its upload deleted", async () => {
    statusScript = missing;
    runScript = alreadyRunning;

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    await advance(20000);

    expect(runRequests()).toHaveLength(2);
    await waitFor(() => expect(stored()[0].status).toBe("Failed"));
    expect(await screen.findByText(/This run did not start/)).toBeInTheDocument();
    expect(discards()).toHaveLength(1);
    // Nothing will replay it now, and it holds the whole CT: not left behind.
    expect(store.pending).toHaveLength(0);
  });
});

describe("Cancel while the server says a request is starting the run", () => {
  it("cancels the card and hands the upload's deletion to the server, which the page takes as done", async () => {
    seed();
    store.pending = [uploaded()];
    statusScript = (n) => (n === 1 ? missing() : starting());
    runScript = alreadyRunning;
    // The server holds the deletion for the request that is copying the CT
    // (202): it removes the upload itself once that request ends without a job
    // (see test_run_dispatch_reservation.py), so the page has nothing to retry.
    discardReply = () => json({ status: "discarding" }, true, 202);

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    await advance(3000);
    const card = (await screen.findByText("Scan")).closest<HTMLElement>(".upload-proc-card")!;
    fireEvent.click(within(card).getByRole("button", { name: /^Cancel\b/ }));
    await advance(500);

    expect(stored()[0].status).toBe("Cancelled");
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/api/cancel-inference/"))).toHaveLength(1);
    expect(discards()).toHaveLength(1);
    expect(queuedDiscards()).toEqual([]);
    expect(store.pending).toHaveLength(0);
    // Stopped for good: no more looks at a run that was cancelled.
    const looks = statusCount;
    await advance(10000);
    expect(statusCount).toBe(looks);
    expect(runRequests()).toHaveLength(1);
  });
});

describe("a followed run whose record is being read when the page moves to another account", () => {
  it("is neither asked for again nor failed under the new account, and its record is kept", async () => {
    seed();
    store.pending = [uploaded()];
    statusScript = missing;
    runScript = alreadyRunning;

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    let open: () => void = () => {};
    store.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // The third look ends the follow, which then waits for the stored record.
    await advance(10000);
    fireEvent.click(screen.getByRole("button", { name: "test switch account" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/auth/login"))).toBe(true));
    await advance(500);
    store.gate = null;
    open();
    await advance(3000);

    // A request under the other account's cookie would be refused 403, and that
    // answer deletes the record the first account will need when it returns.
    expect(runRequests()).toHaveLength(1);
    expect(deletePendingUpload).not.toHaveBeenCalled();
    expect(discards()).toHaveLength(0);
    expect(stored()[0].status).toBe("Processing");
  });
});

describe("a followed run that another tab finished while its record was being read", () => {
  it("is not asked for again or failed: the card already says how it ended", async () => {
    seed();
    store.pending = [uploaded()];
    statusScript = missing;
    runScript = alreadyRunning;

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    let open: () => void = () => {};
    store.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await advance(10000);
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(stored().map((u) => ({ ...u, status: "Completed" }))));
    store.gate = null;
    open();
    await advance(3000);

    expect(runRequests()).toHaveLength(1);
    expect(discards()).toHaveLength(0);
    expect(stored()[0].status).toBe("Completed");
    // And this tab shows it: no Processing card left saying "Running" for a run
    // that nobody is following any more.
    expect(screen.queryByRole("button", { name: /^Cancel\b/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
  });

  it("shows a Cancel another tab made too, without a channel to tell it", async () => {
    seed();
    store.pending = [uploaded()];
    statusScript = missing;
    runScript = alreadyRunning;

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    let open: () => void = () => {};
    store.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await advance(10000);
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(stored().map((u) => ({ ...u, status: "Cancelled" }))));
    store.gate = null;
    open();
    await advance(3000);

    expect(runRequests()).toHaveLength(1);
    expect(discards()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Cancel\b/ })).not.toBeInTheDocument();
  });
});

describe("a run followed after a 409 whose record is gone", () => {
  beforeEach(() => {
    seed();
    store.pending = [uploaded()];
  });

  it("is failed as not started, and its upload deleted, when the server never made a job for it", async () => {
    statusScript = missing;
    runScript = alreadyRunning;

    renderUpload();
    await waitFor(() => expect(runRequests()).toHaveLength(1));
    // Another tab that saw the run through has taken the record away.
    store.pending = [];
    await advance(10000);

    await waitFor(() => expect(stored()[0].status).toBe("Failed"));
    expect(await screen.findByText(/This run did not start/)).toBeInTheDocument();
    expect(discards()).toHaveLength(1);
    expect(runRequests()).toHaveLength(1);
    expect(deletePendingUpload).toHaveBeenCalledWith(SID);
  });
});

describe("a run resumed while the server says a request is starting it", () => {
  beforeEach(() => {
    seed();
    store.pending = [uploaded()];
  });

  it("is followed like a 409: asked for again from its record when no job ever comes", async () => {
    // The question before the resume and the first look say "starting"; then
    // the request that was making the job is gone without one.
    statusScript = (n) => (n <= 2 ? starting() : missing());
    runScript = () => json({ error: "Used up", code: "plan_limit", reason: "daily_scans", plan: "free", limit: 1, used: 1 }, false, 402);

    renderUpload();
    await waitFor(() => expect(statusCount).toBeGreaterThanOrEqual(2));
    await advance(15000);

    await waitFor(() => expect(runRequests()).toHaveLength(1));
    await waitFor(() => expect(stored()[0].status).toBe("Cancelled"));
    expect(screen.queryByText(/no longer exists/i)).not.toBeInTheDocument();
  });
});

describe("a card resumed after a reload, or merged in from the server, with no record of its upload", () => {
  beforeEach(() => seed());

  it("is reported as lost, and nothing is deleted, when the server has no job for it", async () => {
    // Nothing says a request was starting it: the run may well have been going
    // before the server lost it, so it is not told it never started.
    statusScript = missing;

    renderUpload();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/inference-status/"))).toBe(true));
    await advance(10000);

    await waitFor(() => expect(stored()[0].status).toBe("Failed"));
    expect(await screen.findByText(/no longer exists on the server/)).toBeInTheDocument();
    expect(screen.queryByText(/did not start/i)).not.toBeInTheDocument();
    expect(discards()).toHaveLength(0);
    expect(runRequests()).toHaveLength(0);
    expect(deletePendingUpload).not.toHaveBeenCalled();
  });

  it("is reported as lost, and nothing is deleted, when the job was seen and then went", async () => {
    statusScript = (n) => (n === 1 ? running() : missing());

    renderUpload();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/inference-status/"))).toBe(true));
    await advance(15000);

    await waitFor(() => expect(stored()[0].status).toBe("Failed"));
    expect(await screen.findByText(/no longer exists on the server/)).toBeInTheDocument();
    expect(discards()).toHaveLength(0);
  });
});
