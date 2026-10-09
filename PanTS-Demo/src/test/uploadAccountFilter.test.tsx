import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage from "../routes/UploadPage";

// Recent uploads live in one list per browser, and each run in it is stamped
// with the account that started it (or that the server lists it for); a run
// with no owner is a signed-out visitor's. On a shared browser everyone sees,
// and counts against their limit on scans at once, only what is theirs: the
// other runs stay put for their owners' next sign-in, and nothing shows until
// sign-in has settled.

// jsdom has no IndexedDB, so the resumable-upload store is faked.
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
const ONE = { id: "u1", email: "one@example.com", name: null, plan: "pro" };
const TWO = { id: "u2", email: "two@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

let calls: string[] = [];
let me: typeof ONE | null = TWO;
/** What /api/auth/me does: waits for meGate, then answers with `me`, or fails. */
let meFails = false;
let meGate: Promise<void>;
let openMe: () => void;

const callsTo = (path: string) => calls.filter((c) => c.includes(path));

beforeEach(() => {
  calls = [];
  me = TWO;
  meFails = false;
  meGate = new Promise((resolve) => {
    openMe = resolve;
  });
  openMe();
  store.pending = [];
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/api/auth/me")) {
      await meGate;
      return meFails ? json({ error: "Down" }, false, 503) : json({ user: me });
    }
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/me/runs")) return json({ runs: [] });
    if (u.includes("/api/upload-inference-chunk")) return json({ ok: true });
    if (u.includes("/api/upload-status")) return json({ received: [] });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    if (u.includes("/api/run-epai-inference")) return json({ message: "Segmentation started" });
    if (u.includes("/api/inference-status/")) return json({ status: "running" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

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

const run = (sessionId: string, label: string, status: RecentUpload["status"], ownerId?: string): RecentUpload => ({
  sessionId,
  label,
  model: "ePAI",
  status,
  timestamp: Date.now() - 60_000,
  ownerId,
  viewed: false,
});

const seed = (...entries: RecentUpload[]) =>
  localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(entries));

const stored = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];

const pickFile = async (container: HTMLElement) => {
  const user = userEvent.setup();
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, new File([new Uint8Array(CHUNK_SIZE)], "scan.nii.gz", { type: "application/gzip" }));
  return user;
};

/** The plan allows five scans at once. */
const FIVE = ["a", "b", "c", "d", "e"];

describe("a browser shared by two accounts", () => {
  it("shows the signed-in account only its own runs", async () => {
    seed(
      run("sid-a1", "Scan A running", "Processing", "u1"),
      run("sid-a2", "Scan A finished", "Completed", "u1"),
      run("sid-b1", "Scan B finished", "Completed", "u2"),
      run("sid-n1", "Scan from before accounts", "Completed"),
    );
    renderUpload();
    await settledSignedIn();

    expect(await screen.findByText("Scan B finished")).toBeInTheDocument();
    expect(screen.queryByText("Scan A running")).not.toBeInTheDocument();
    expect(screen.queryByText("Scan A finished")).not.toBeInTheDocument();
    expect(screen.queryByText("Scan from before accounts")).not.toBeInTheDocument();
    // Hidden, not deleted: their owners find them when they sign in.
    expect(stored().map((u) => u.sessionId)).toEqual(["sid-a1", "sid-a2", "sid-b1", "sid-n1"]);
    // And nothing was resumed or polled for them.
    await flush();
    expect(callsTo("/api/inference-status/")).toEqual([]);
  });

  it("shows nothing until sign-in has settled, so no account's runs flash up as running", async () => {
    meGate = new Promise((resolve) => {
      openMe = resolve;
    });
    seed(run("sid-a1", "Scan A running", "Processing", "u1"), run("sid-b1", "Scan B running", "Processing", "u2"));
    renderUpload();
    await flush();

    expect(screen.queryByText("Scan A running")).not.toBeInTheDocument();
    expect(screen.queryByText("Scan B running")).not.toBeInTheDocument();

    openMe();
    expect(await screen.findByText("Scan B running")).toBeInTheDocument();
    expect(screen.queryByText("Scan A running")).not.toBeInTheDocument();
  });

  it("shows only the runs nobody owns when sign-in could not be checked", async () => {
    meFails = true;
    seed(run("sid-a1", "Scan A running", "Processing", "u1"), run("sid-n1", "Scan from before accounts", "Processing"));
    renderUpload();

    // The session check asks /me three times, about 1.6 s apart in all, before
    // it settles signed out.
    expect(await screen.findByText("Scan from before accounts", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getAllByText("Paused, sign in to resume")).toHaveLength(1);
    expect(screen.queryByText("Scan A running")).not.toBeInTheDocument();
  });

  it("does not count another account's runs against the scans this account may have at once", async () => {
    seed(...FIVE.map((id) => run(`sid-${id}`, `Scan ${id}`, "Processing", "u1")));
    const page = renderUpload();
    await settledSignedIn();

    // The file is sent the moment it is picked, which a full plan would hold back.
    const user = await pickFile(page.container);
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(callsTo("/api/run-epai-inference")).toHaveLength(1));
    expect(screen.queryByText(/at once/i)).not.toBeInTheDocument();
  });

  it("still counts this account's own runs", async () => {
    seed(...FIVE.map((id) => run(`sid-${id}`, `Scan ${id}`, "Processing", "u2")));
    const page = renderUpload();
    await settledSignedIn();

    const user = await pickFile(page.container);
    await flush();
    expect(callsTo("/api/upload-inference-chunk")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Run" }));
    await flush();

    expect(callsTo("/api/run-epai-inference")).toEqual([]);
  });

  it("does not count or resume the runs nobody owns for a signed-in account", async () => {
    seed(...FIVE.map((id) => run(`sid-${id}`, `Scan ${id}`, "Processing")));
    const page = renderUpload();
    await settledSignedIn();

    const user = await pickFile(page.container);
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(callsTo("/api/run-epai-inference")).toHaveLength(1));
    // Not polled either: no account has taken them up.
    expect(callsTo("/api/inference-status/").filter((c) => /sid-[a-e]$/.test(c))).toEqual([]);
  });

  it("shows a signed-out visitor the runs nobody owns, as paused, and not any account's", async () => {
    me = null;
    seed(run("sid-a1", "Scan A running", "Processing", "u1"), run("sid-n1", "Scan from before accounts", "Processing"));
    renderUpload();

    expect(await screen.findByText("Scan from before accounts")).toBeInTheDocument();
    expect(screen.getAllByText("Paused, sign in to resume")).toHaveLength(1);
    expect(screen.queryByText("Scan A running")).not.toBeInTheDocument();
  });
});
