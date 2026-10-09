import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import { deletePendingUpload, type PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// What may leave the browser, and for whom:
//
//   - "None" is view only. While it is the model, nothing uploads, and
//     choosing it stops a pre-upload a previous choice already started and
//     asks the server to delete what already arrived. Removing a file does
//     the same for its pre-upload.
//   - A guest never uploads, dispatches or polls anything, not even leftovers
//     an earlier session left in this browser.
//   - Signing out stops and forgets the pre-uploads, so the next account's
//     Run starts its own session instead of reusing the old account's one.

// jsdom has no IndexedDB, so the resumable-upload store is faked with a list
// each test can fill.
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

const CHUNK_SIZE = 512 * 1024;
const U1 = { id: "u1", email: "one@example.com", name: null, plan: "pro" };
const U2 = { id: "u2", email: "two@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const makeFile = (name: string) =>
  new File([new Uint8Array(CHUNK_SIZE * 2)], name, { type: "application/gzip" });

const sessionOf = (body: unknown): string => {
  if (body instanceof FormData) return String(body.get("session_id") ?? "");
  if (body instanceof URLSearchParams) return String(body.get("session_id") ?? "");
  return "";
};

type Call = { url: string; sid: string; signal?: AbortSignal | null };
let calls: Call[] = [];
/** Who /api/auth/me says is signed in when the page loads. */
let me: typeof U1 | null = null;
/** Who /api/auth/login signs in. */
let loginAs: typeof U1 = U2;
/** While set, chunk uploads hang until aborted (a pre-upload in flight). */
let holdChunks = false;
/** What /api/run-epai-inference answers. */
let dispatchResponse: () => ReturnType<typeof json> = () => json({ message: "Segmentation started" });
/** What /api/inference-status answers. */
let statusReply: (sid: string) => ReturnType<typeof json> = () => json({ status: "queued" });

const UPLOAD_ENDPOINTS = [
  "/api/upload-inference-chunk",
  "/api/finalize-upload",
  "/api/upload-status",
  "/api/run-epai-inference",
  "/api/inference-status/",
];
const uploadCalls = () => calls.filter((c) => UPLOAD_ENDPOINTS.some((e) => c.url.includes(e)));
const chunkCalls = () => calls.filter((c) => c.url.includes("/api/upload-inference-chunk"));

beforeEach(() => {

  __resetUploadTabState();
  calls = [];
  me = U1;
  loginAs = U2;
  holdChunks = false;
  store.pending = [];
  dispatchResponse = () => json({ message: "Segmentation started" });
  statusReply = () => json({ status: "queued" });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, sid: sessionOf(init?.body), signal: init?.signal });
    if (u.includes("/api/auth/me")) return json({ user: me });
    if (u.includes("/api/auth/login")) return json({ user: loginAs });
    if (u.includes("/api/auth/logout")) return json({ ok: true });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      if (holdChunks) {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal?.aborted) abort();
          signal?.addEventListener("abort", abort);
        });
      }
      return json({ ok: true });
    }
    if (u.includes("/api/upload-status")) return json({ received: [] });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    if (u.includes("/api/run-epai-inference")) return dispatchResponse();
    if (u.includes("/api/inference-status/")) return statusReply(u.split("/api/inference-status/")[1]);
    if (u.includes("/api/discard-upload/")) return json({ status: "discarded" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

// Stand-ins for the header's account menu.
const AuthControls = () => {
  const { signIn, signOut } = useAuth();
  return (
    <>
      <button type="button" onClick={() => void signIn("two@example.com", "pw")}>
        test sign in
      </button>
      <button type="button" onClick={() => void signOut()}>
        test sign out
      </button>
    </>
  );
};

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <AuthControls />
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

/** Signed in and the plan-aware model default has landed. */
const settledSignedIn = async () => {
  await waitFor(() =>
    expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
  );
  await screen.findByRole("button", { name: /^Model ePAI$/ });
};

const pickFile = async (user: ReturnType<typeof userEvent.setup>, container: HTMLElement) => {
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, makeFile("scan.nii.gz"));
};

const chooseModel = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(screen.getByRole("button", { name: /^Model / }));
  const menu = screen.getByRole("menu", { name: "Model" });
  await user.click(within(menu).getByRole("menuitemradio", { name }));
};

/** Lets queued promise chains and effects run. */
const flush = () => new Promise((r) => setTimeout(r, 60));

describe("the None model", () => {
  it("never uploads a file picked while it is selected", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settledSignedIn();

    await chooseModel(user, /^None$/);
    expect(screen.getByRole("button", { name: /^Model None/ })).toBeInTheDocument();
    await pickFile(user, container);
    await flush();

    expect(screen.getByText("scan.nii.gz")).toBeInTheDocument();
    expect(screen.queryByText(/uploading \d+%/)).not.toBeInTheDocument();
    expect(uploadCalls()).toEqual([]);
  });

  it("aborts a pre-upload already in flight when it is chosen", async () => {
    holdChunks = true;
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settledSignedIn();

    await pickFile(user, container);
    await waitFor(() => expect(chunkCalls().length).toBeGreaterThan(0));
    expect(screen.getByText(/uploading \d+%/)).toBeInTheDocument();
    const inFlight = chunkCalls();
    expect(inFlight.every((c) => c.signal && !c.signal.aborted)).toBe(true);

    await chooseModel(user, /^None$/);

    expect(inFlight.every((c) => c.signal?.aborted)).toBe(true);
    await waitFor(() => expect(screen.queryByText(/uploading \d+%/)).not.toBeInTheDocument());
    await flush();
    // Nothing was finalized or dispatched, and no further chunk went out.
    expect(chunkCalls()).toHaveLength(inFlight.length);
    expect(calls.some((c) => c.url.includes("/api/finalize-upload"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/api/run-epai-inference"))).toBe(false);
  });
});

describe("taking a picked file back", () => {
  const finalizedSid = async () => {
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/finalize-upload"))).toBe(true));
    return calls.find((c) => c.url.includes("/api/finalize-upload"))!.sid;
  };
  const discards = () => calls.filter((c) => c.url.includes("/api/discard-upload/"));

  it("deletes a finished pre-upload from the server when None is chosen", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settledSignedIn();

    await pickFile(user, container);
    const sid = await finalizedSid();
    expect(discards()).toEqual([]);

    await chooseModel(user, /^None$/);
    await waitFor(() => expect(discards().map((c) => c.url)).toEqual([expect.stringContaining(`/api/discard-upload/${sid}`)]));
  });

  it("deletes a file's pre-upload from the server when the file is removed", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settledSignedIn();

    await pickFile(user, container);
    const sid = await finalizedSid();

    await user.click(screen.getByRole("button", { name: "Remove scan.nii.gz" }));
    await waitFor(() => expect(discards().map((c) => c.url)).toEqual([expect.stringContaining(`/api/discard-upload/${sid}`)]));
    expect(screen.queryByText("scan.nii.gz")).not.toBeInTheDocument();
  });
});

describe("a guest", () => {
  // Entries written before runs recorded their owner carry no ownerId: they are
  // a signed-out visitor's, and no account takes them up.
  const leftover = (sessionId: string, ownerId?: string): RecentUpload => ({
    sessionId,
    label: `Scan ${sessionId}`,
    model: "ePAI",
    status: "Processing",
    timestamp: Date.now() - 60_000,
    ownerId,
  });
  const seed = (ownerId?: string) =>
    localStorage.setItem(
      RECENT_UPLOADS_KEY,
      JSON.stringify([
        leftover("sid-uploading", ownerId),
        leftover("sid-uploaded", ownerId),
        leftover("sid-running", ownerId),
      ]),
    );

  beforeEach(() => {
    me = null;
    // Three runs a signed-in session left behind in this browser: one still
    // uploading, one uploaded but never dispatched, one already running.
    seed();
    store.pending = [
      {
        sessionId: "sid-uploading",
        file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
        filename: "a.nii.gz",
        model: "ePAI",
        bdmapId: "",
        totalChunks: 2,
        nextChunk: 1,
        chunkSize: CHUNK_SIZE,
      },
      {
        sessionId: "sid-uploaded",
        file: new Blob([]),
        filename: "b.nii.gz",
        model: "ePAI",
        bdmapId: "",
        totalChunks: 2,
        nextChunk: 2,
        chunkSize: CHUNK_SIZE,
        uploadedFilename: "b.nii.gz",
      },
    ];
  });

  it("never resumes, dispatches or polls leftover runs", async () => {
    renderUpload();
    await screen.findByText(/to run inference/);
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/auth/me"))).toBe(true),
    );
    await flush();
    await flush();

    expect(uploadCalls()).toEqual([]);
    // The leftovers say why they are standing still.
    expect(screen.getAllByText("Paused, sign in to resume").length).toBeGreaterThan(0);
  });

  it("can cancel and remove the runs nobody owns, and their unfinished uploads go with them", async () => {
    // Left behind by a build that did not record an owner, and never adopted by
    // an account: they must not sit in the browser with nobody able to clear
    // them, and least of all the copy of a scan kept for resuming.
    const user = userEvent.setup();
    renderUpload();
    await screen.findByText(/to run inference/);
    const card = screen.getByText("Scan sid-uploading").closest<HTMLElement>(".upload-proc-card")!;

    await user.click(within(card).getByRole("button", { name: /^Cancel\b/ }));
    await user.click(await screen.findByRole("button", { name: "Remove Scan sid-uploading" }));

    expect(screen.queryByText("Scan sid-uploading")).not.toBeInTheDocument();
    expect(deletePendingUpload).toHaveBeenCalledWith("sid-uploading");
    expect(
      (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).map((u) => u.sessionId),
    ).not.toContain("sid-uploading");
    expect(uploadCalls()).toEqual([]);
  });

  it("does not resume another account's leftovers after signing in", async () => {
    seed("u1");
    renderUpload();
    await screen.findByText(/to run inference/);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await screen.findByRole("button", { name: /^Model ePAI$/ });
    await flush();
    await flush();

    expect(uploadCalls()).toEqual([]);
    // They are the other account's: kept for it, but not shown to this one.
    expect(screen.queryByText("Scan sid-uploading")).not.toBeInTheDocument();
    expect(screen.queryByText(/Paused/)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]")).toHaveLength(3);
  });

  it("does not resume the runs nobody owns once an account signs in", async () => {
    const user = userEvent.setup();
    renderUpload();
    await screen.findByText(/to run inference/);
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await screen.findByRole("button", { name: /^Model ePAI$/ });
    await flush();
    await flush();

    expect(uploadCalls()).toEqual([]);
    expect(screen.queryByText("Scan sid-uploading")).not.toBeInTheDocument();
  });

  it("resumes them once their account signs in", async () => {
    seed("u2");
    // The server has a job for the running one only: the finished upload never
    // got as far as making one, which is why it is dispatched.
    statusReply = (sid) => (sid === "sid-running" ? json({ status: "running" }) : json({ status: "not_found" }, false, 404));
    const user = userEvent.setup();
    renderUpload();
    await screen.findByText(/to run inference/);
    await flush();
    expect(uploadCalls()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "test sign in" }));

    // The finished upload is dispatched, the half-sent one resumes and the
    // running one is polled again.
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/run-epai-inference") && c.sid === "sid-uploaded")).toBe(true),
    );
    await waitFor(() =>
      expect(chunkCalls().some((c) => c.sid === "sid-uploading")).toBe(true),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/inference-status/sid-running"))).toBe(true),
    );
  });
});

describe("the finished-scan card", () => {
  it("is the account's who ran the scan: signing out or switching account takes it away", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      RECENT_UPLOADS_KEY,
      JSON.stringify([
        {
          sessionId: "sid-done",
          label: "Scan done",
          model: "ePAI",
          status: "Processing",
          timestamp: Date.now() - 60_000,
          ownerId: "u1",
        } satisfies RecentUpload,
      ]),
    );
    statusReply = () => json({ status: "completed" });
    renderUpload();
    expect(await screen.findByText("Inference complete")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "test sign out" }));
    await waitFor(() => expect(screen.queryByText("Inference complete")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await screen.findByRole("button", { name: /^Model ePAI$/ });
    await flush();
    expect(screen.queryByText("Inference complete")).not.toBeInTheDocument();
  });
});

describe("signing out", () => {
  it("aborts and forgets pre-uploads, so the next account's Run uses a new session", async () => {
    holdChunks = true;
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settledSignedIn();

    await pickFile(user, container);
    await waitFor(() => expect(chunkCalls().length).toBeGreaterThan(0));
    const oldSid = chunkCalls()[0].sid;
    const oldCalls = chunkCalls();

    await user.click(screen.getByRole("button", { name: "test sign out" }));

    await waitFor(() => expect(oldCalls.every((c) => c.signal?.aborted)).toBe(true));
    await waitFor(() => expect(screen.queryByText(/uploading \d+%/)).not.toBeInTheDocument());
    await flush();
    expect(chunkCalls()).toHaveLength(oldCalls.length);

    // Another account signs in on the same page with the file still picked.
    holdChunks = false;
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await screen.findByText(/ready/);
    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/run-epai-inference"))).toBe(true),
    );
    const dispatched = calls.filter((c) => c.url.includes("/api/run-epai-inference"));
    expect(dispatched.every((c) => c.sid && c.sid !== oldSid)).toBe(true);
    expect(
      calls.some((c) => c.url.includes("/api/finalize-upload") && c.sid === oldSid),
    ).toBe(false);
  });

  it("explains a session that belongs to another account instead of a bare Failed", async () => {
    dispatchResponse = () =>
      json({ error: "You don't have access to this session/upload." }, false, 403);
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settledSignedIn();

    await pickFile(user, container);
    await screen.findByText(/ready/);
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(
      await screen.findByText(/started under a different account/),
    ).toBeInTheDocument();
  });
});
