import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { friendlyScanName, RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import UploadPage from "../routes/UploadPage";

// Recent uploads live in the browser's localStorage, so a signed-in person on
// another browser or device would find an empty list. The account's own runs
// are kept on the server (GET /api/me/runs): the page adds the ones this
// browser lacks, and leaves what it already has alone.

const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

let calls: string[] = [];
/** Who /api/auth/me says is signed in when the page loads. */
let me: typeof USER | null = USER;
/** What /api/me/runs answers. */
let runsReply: () => ReturnType<typeof json>;

const hoursAgo = (h: number) => Date.now() - h * 60 * 60 * 1000;
const serverRun = (sessionId: string, model: string, status: string, ts: number) => ({
  session_id: sessionId,
  model,
  status,
  created_at: new Date(ts).toISOString(),
});

const T_DONE = hoursAgo(2);
const T_FAILED = hoursAgo(3);
const T_RUNNING = hoursAgo(1);
const serverRuns = () => [
  serverRun("srv-running", "MedFormer", "running", T_RUNNING),
  serverRun("srv-done", "ePAI", "completed", T_DONE),
  serverRun("srv-failed", "LesionSegmenter", "failed", T_FAILED),
];

beforeEach(() => {
  calls = [];
  me = USER;
  runsReply = () => json({ runs: serverRuns() });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/api/auth/me")) return json({ user: me });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/me/runs/owned")) {
      // The server names the asked-about ids that are the account's own: here,
      // the ones it has runs for.
      const asked = JSON.parse(String(init?.body)).session_ids as string[];
      return json({ owned: asked.filter((id) => serverRuns().some((r) => r.session_id === id)) });
    }
    if (u.includes("/api/me/runs")) return runsReply();
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

const stored = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
const runsRequests = () => calls.filter((u) => u.endsWith("/api/me/runs"));

describe("Recent uploads for a signed-in account", () => {
  it("fills in the account's runs that this browser lacks", async () => {
    renderUpload();

    // Finished runs wait in Completed uploads, whatever their outcome.
    expect(await screen.findByText(friendlyScanName("ePAI", T_DONE))).toBeInTheDocument();
    expect(screen.getByText(friendlyScanName("LesionSegmenter", T_FAILED))).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    // The one still running is followed like any in-flight run.
    expect(screen.getByText(friendlyScanName("MedFormer", T_RUNNING))).toBeInTheDocument();
    await waitFor(() => expect(calls.some((u) => u.includes("/api/inference-status/srv-running"))).toBe(true));
    expect(await screen.findByText("Running…")).toBeInTheDocument();

    // Kept in this browser, owned by the account, so History sees them too.
    expect(stored().map((u) => [u.sessionId, u.status, u.ownerId])).toEqual([
      ["srv-running", "Processing", "u1"],
      ["srv-done", "Completed", "u1"],
      ["srv-failed", "Failed", "u1"],
    ]);
  });

  it("leaves a run the browser already has as it is, and adds no second copy", async () => {
    localStorage.setItem(
      RECENT_UPLOADS_KEY,
      JSON.stringify([
        {
          sessionId: "srv-done",
          label: "Baseline CT",
          sourceName: "baseline.nii.gz",
          model: "ePAI",
          status: "Completed",
          timestamp: T_DONE,
          ownerId: "u1",
          viewed: false,
        } satisfies RecentUpload,
      ]),
    );

    renderUpload();

    expect(await screen.findByText(friendlyScanName("LesionSegmenter", T_FAILED))).toBeInTheDocument();
    expect(screen.getByText("Baseline CT")).toBeInTheDocument();
    expect(screen.queryByText(friendlyScanName("ePAI", T_DONE))).not.toBeInTheDocument();
    expect(stored().filter((u) => u.sessionId === "srv-done")).toEqual([
      expect.objectContaining({ label: "Baseline CT", sourceName: "baseline.nii.gz" }),
    ]);
  });

  it("gives the account back the runs its browser saved before entries had an owner, when the server says they are its own", async () => {
    // Nothing on these entries says whose they are. The server names the ones
    // that are this account's; the rest could be anyone's and stay out of its list.
    const legacy = (sessionId: string, label: string, status: RecentUpload["status"]): RecentUpload => ({
      sessionId,
      label,
      model: "ePAI",
      status,
      timestamp: hoursAgo(5),
    });
    localStorage.setItem(
      RECENT_UPLOADS_KEY,
      JSON.stringify([
        legacy("srv-done", "Legacy finished", "Completed"),
        legacy("srv-running", "Legacy running", "Processing"),
        legacy("elsewhere", "Legacy of nobody's", "Completed"),
      ]),
    );

    renderUpload();

    expect(await screen.findByText("Legacy finished")).toBeInTheDocument();
    expect(screen.getByText("Legacy running")).toBeInTheDocument();
    expect(screen.queryByText("Legacy of nobody's")).not.toBeInTheDocument();
    // The one still running is followed again, which no account would have done
    // for a run it could not tell was its own.
    await waitFor(() => expect(calls.some((u) => u.includes("/api/inference-status/srv-running"))).toBe(true));
    expect(stored().map((u) => [u.sessionId, u.ownerId])).toEqual(
      expect.arrayContaining([
        ["srv-done", "u1"],
        ["srv-running", "u1"],
        ["elsewhere", undefined],
      ]),
    );
    // Only listed once: adopted in place, not added again as a server run.
    expect(stored().filter((u) => u.sessionId === "srv-done")).toHaveLength(1);
  });

  it("does not bring back a scan that was removed from the list", async () => {
    const user = userEvent.setup();
    const first = renderUpload();
    const doneLabel = friendlyScanName("ePAI", T_DONE);
    await screen.findByText(doneLabel);

    await user.click(screen.getByRole("button", { name: `Remove ${doneLabel}` }));
    expect(screen.queryByText(doneLabel)).not.toBeInTheDocument();
    first.unmount();

    renderUpload();
    expect(await screen.findByText(friendlyScanName("LesionSegmenter", T_FAILED))).toBeInTheDocument();
    await waitFor(() => expect(runsRequests()).toHaveLength(2));
    expect(screen.queryByText(doneLabel)).not.toBeInTheDocument();
    expect(stored().some((u) => u.sessionId === "srv-done")).toBe(false);
  });

  it("keeps the local list when the server can't be reached", async () => {
    runsReply = () => json({ error: "The server is busy" }, false, 503);
    localStorage.setItem(
      RECENT_UPLOADS_KEY,
      JSON.stringify([
        {
          sessionId: "local-only",
          label: "Only here",
          model: "ePAI",
          status: "Completed",
          timestamp: hoursAgo(1),
          ownerId: "u1",
        } satisfies RecentUpload,
      ]),
    );

    renderUpload();

    expect(await screen.findByText("Only here")).toBeInTheDocument();
    await waitFor(() => expect(runsRequests()).toHaveLength(1));
    expect(stored().map((u) => u.sessionId)).toEqual(["local-only"]);
  });
});

describe("Recent uploads signed out", () => {
  it("stay local: the server's list is never asked for", async () => {
    me = null;
    localStorage.setItem(
      RECENT_UPLOADS_KEY,
      JSON.stringify([
        {
          sessionId: "local-only",
          label: "Only here",
          model: "ePAI",
          status: "Completed",
          timestamp: hoursAgo(1),
        } satisfies RecentUpload,
      ]),
    );

    renderUpload();

    expect(await screen.findByText("Only here")).toBeInTheDocument();
    await screen.findByText(/to run inference/);
    expect(runsRequests()).toHaveLength(0);
    expect(stored().map((u) => u.sessionId)).toEqual(["local-only"]);
  });
});
