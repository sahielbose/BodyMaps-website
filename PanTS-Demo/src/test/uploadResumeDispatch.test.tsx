import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import { deletePendingUpload, type PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// A CT that finished uploading but whose run request may or may not have got
// to the server is resumed by asking the server whether it has the job before
// the request is sent again. And a run that only becomes the account's after
// the page opened (saved before entries carried an owner, taken up by the
// server's word) is resumed the same way as one that was the account's from
// the start.

const store = vi.hoisted(() => ({ pending: [] as PendingUpload[] }));
vi.mock("../helpers/pendingUploads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/pendingUploads")>();
  return {
    ...actual,
    loadPendingUploads: vi.fn(async () => store.pending),
    deletePendingUpload: vi.fn(async () => {}),
    savePendingUpload: vi.fn(async () => true),
    setPendingNextChunk: vi.fn(async () => {}),
    setPendingUploaded: vi.fn(async () => {}),
  };
});

const USER = { id: "u1", email: "one@example.com", name: null, plan: "free" };
const OTHER = { id: "u2", email: "two@example.com", name: null, plan: "free" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

let calls: { method: string; url: string; sid: string }[];
/** What GET /api/inference-status/<sid> answers (or throws). */
let statusReply: (sid: string) => ReturnType<typeof json>;
/** While set, GET /api/inference-status waits for it before answering. */
let statusGate: Promise<void> | null;
/** The sessions POST /api/me/runs/owned says are the account's. */
let serverOwns: string[];

const stored = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
const seed = (list: Partial<RecentUpload>[]) =>
  localStorage.setItem(
    RECENT_UPLOADS_KEY,
    JSON.stringify(
      list.map((u) => ({ label: `Scan ${u.sessionId}`, model: "ePAI", status: "Processing", timestamp: Date.now() - 60_000, ...u })),
    ),
  );
const uploaded = (sessionId: string): PendingUpload => ({
  sessionId,
  file: new Blob([]),
  filename: "ct.nii.gz",
  model: "ePAI",
  bdmapId: "",
  totalChunks: 2,
  nextChunk: 2,
  chunkSize: 512 * 1024,
  uploadedFilename: "ct.nii.gz",
});

const missing = () => json({ status: "not_found" }, false, 404);

beforeEach(() => {
  __resetUploadTabState();
  calls = [];
  store.pending = [];
  serverOwns = [];
  statusGate = null;
  statusReply = () => json({ status: "running" });
  localStorage.clear();
  vi.mocked(deletePendingUpload).mockClear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body;
    calls.push({ method: init?.method ?? "GET", url: u, sid: body instanceof FormData ? String(body.get("session_id") ?? "") : "" });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/login")) return json({ user: OTHER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/me/runs/owned")) {
      const asked = JSON.parse(String(init?.body)).session_ids as string[];
      return json({ owned: asked.filter((id) => serverOwns.includes(id)) });
    }
    if (u.includes("/api/run-epai-inference")) return json({ message: "started" });
    if (u.includes("/api/inference-status/")) {
      if (statusGate) await statusGate;
      return statusReply(u.split("/api/inference-status/")[1]);
    }
    return json({ items: [], total: 0, ids: [], runs: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

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

const dispatched = (sid: string) =>
  calls.some((c) => c.method === "POST" && c.url.includes("/api/run-epai-inference") && c.sid === sid);
const statusChecks = (sid: string) => calls.filter((c) => c.url.includes(`/api/inference-status/${sid}`));
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("an upload that finished before the tab was closed", () => {
  beforeEach(() => {
    seed([{ sessionId: "sid-a", ownerId: "u1" }]);
    store.pending = [uploaded("sid-a")];
  });

  it("is followed, not sent again, when the server already made its job", async () => {
    // The tab closed while the run request was on its way; the server carried on.
    statusReply = () => json({ status: "running" });

    renderUpload();

    await waitFor(() => expect(statusChecks("sid-a").length).toBeGreaterThan(0));
    await waitFor(() => expect(deletePendingUpload).toHaveBeenCalledWith("sid-a"));
    await settle();
    expect(dispatched("sid-a")).toBe(false);
    expect(stored()[0].status).toBe("Processing");
  });

  it("is sent when the server has no job for it", async () => {
    statusReply = missing;

    renderUpload();

    await waitFor(() => expect(dispatched("sid-a")).toBe(true));
  });

  it("is left alone, not sent or followed, when the page has moved to another account while the server was asked", async () => {
    // The answer (and any 403 it would have got) was for whichever cookie was
    // current: the run is not the new account's, and its record is kept for
    // when its own account is back.
    let open: () => void = () => {};
    statusGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    statusReply = missing;
    const user = userEvent.setup();
    renderUpload();
    await waitFor(() => expect(statusChecks("sid-a").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "test switch account" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/auth/login"))).toBe(true));
    await settle();
    open();
    await settle();

    expect(dispatched("sid-a")).toBe(false);
    expect(deletePendingUpload).not.toHaveBeenCalledWith("sid-a");
    expect(stored()[0].status).toBe("Processing");
  });

  it("is sent when the server cannot be asked", async () => {
    statusReply = () => {
      throw new TypeError("Failed to fetch");
    };

    renderUpload();

    await waitFor(() => expect(dispatched("sid-a")).toBe(true));
  });
});

describe("a run that becomes the account's after the page opened", () => {
  beforeEach(() => {
    // Saved before entries carried an owner: nobody's until the server says so.
    seed([{ sessionId: "sid-b" }]);
    serverOwns = ["sid-b"];
    statusReply = missing;
  });

  it("is resumed from its pending record, not polled into a failure, when its upload finished but no job was made", async () => {
    store.pending = [uploaded("sid-b")];

    renderUpload();

    await waitFor(() => expect(stored()[0].ownerId).toBe("u1"));
    await waitFor(() => expect(dispatched("sid-b")).toBe(true));
    await settle();
    expect(stored()[0].status).not.toBe("Failed");
  });

  it("is followed when there is no pending record", async () => {
    statusReply = () => json({ status: "running" });

    renderUpload();

    await waitFor(() => expect(stored()[0].ownerId).toBe("u1"));
    await waitFor(() => expect(statusChecks("sid-b").length).toBeGreaterThan(0));
    expect(dispatched("sid-b")).toBe(false);
  });
});
