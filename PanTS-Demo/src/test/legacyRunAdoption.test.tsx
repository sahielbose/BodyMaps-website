import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { RUNS_ADOPTED_EVENT, type RunsAdopted } from "../helpers/adoptLegacyRuns";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import SettingsPage from "../routes/Settings";
import HistorySettings from "../routes/Settings/HistorySettings";
import PrivacySettings from "../routes/Settings/PrivacySettings";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// Runs saved before entries carried an owner have none, so the account rule
// hides them from everyone signed in until the server says whose they are
// (POST /api/me/runs/owned, exact for the ids asked about, however many runs the
// account has). That used to be a guess from the newest 50 runs, and only the
// Upload page did it. It is done once sign-in settles (the auth provider), and
// again by Delete scan history just before it removes the server's records.

const USER = {
  id: "u1",
  email: "one@example.com",
  name: null,
  plan: "pro",
  email_verified: true,
  roles: [] as string[],
};
const USAGE = {
  plan: "pro",
  limits: { daily_scans: 10, daily_ai_messages: 10 },
  scans: { used: 0, limit: 10, in_flight: 0, resets_at: null },
  ai_messages: { used: 0, limit: 10, resets_at: null },
};

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const DAY = 24 * 60 * 60 * 1000;
const legacy = (sessionId: string, label: string, extra: Partial<RecentUpload> = {}): RecentUpload => ({
  sessionId,
  label,
  model: "ePAI",
  status: "Completed",
  timestamp: Date.now() - 3 * DAY,
  ...extra,
});
const stored = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
const seed = (list: RecentUpload[]) => localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(list));

let calls: { method: string; url: string }[];
/** What POST /api/me/runs/owned answers; one reply per request, the last one repeats. */
let ownedReplies: ((asked: string[]) => ReturnType<typeof json>)[];
/** The sessions the server has records for, this account's. */
let serverOwns: string[];

const ownedReply = (asked: string[]) => json({ owned: asked.filter((id) => serverOwns.includes(id)) });
const refused = () => json({ error: "busy" }, false, 503);

beforeEach(() => {
  __resetUploadTabState();
  calls = [];
  serverOwns = ["mine-1"];
  ownedReplies = [ownedReply];
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/me/usage")) return json(USAGE);
    if (u.includes("/api/me/runs/owned")) {
      const asked = JSON.parse(String(init?.body)).session_ids as string[];
      const reply = ownedReplies.length > 1 ? ownedReplies.shift()! : ownedReplies[0];
      return reply(asked);
    }
    if (u.includes("/api/me/runs")) return json({ runs: [] }); // the listing names nothing here
    if (u.includes("/api/me/jobs") && method === "DELETE") {
      // The server's records go with it: nothing is the account's afterwards.
      const removed = serverOwns.length;
      serverOwns = [];
      return json({ deleted: { jobs: 0, files: 0, runs: removed } });
    }
    if (u.includes("/api/inference-status/")) return json({ status: "running" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const ownedRequests = () => calls.filter((c) => c.url.includes("/api/me/runs/owned"));
const deleted = () => calls.some((c) => c.method === "DELETE" && c.url.includes("/api/me/jobs"));

const renderSettings = (path: string) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/account" element={<SettingsPage />}>
            <Route path="history" element={<HistorySettings />} />
            <Route path="privacy" element={<PrivacySettings />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

const confirmDelete = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click((await screen.findByRole("button", { name: "Delete scan history" })));
  await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
  await user.click(screen.getByRole("button", { name: "Confirm" }));
};

describe("earlier runs on a page other than Upload", () => {
  it("History lists the account's own earlier scans without the Upload page ever being opened", async () => {
    seed([legacy("mine-1", "My earlier scan"), legacy("stranger-1", "Someone else's scan")]);

    renderSettings("/account/history");

    expect(await screen.findByText("My earlier scan")).toBeInTheDocument();
    // A run the server does not name for this account is still not theirs.
    expect(screen.queryByText("Someone else's scan")).not.toBeInTheDocument();
    expect(stored().map((u) => [u.sessionId, u.ownerId])).toEqual([
      ["mine-1", "u1"],
      ["stranger-1", undefined],
    ]);
    expect(calls.some((c) => c.url.includes("/api/inference-status/"))).toBe(false);
  });

  it("asks again after a check that failed, so the scans do not stay hidden until the page is reloaded", async () => {
    seed([legacy("mine-1", "My earlier scan")]);
    ownedReplies = [refused, ownedReply];

    renderSettings("/account/history");
    await waitFor(() => expect(ownedRequests()).toHaveLength(1));
    // The first check was refused: nothing to show yet, and nothing says why.
    expect(screen.queryByText("My earlier scan")).not.toBeInTheDocument();

    // The person comes back to the tab.
    window.dispatchEvent(new Event("focus"));

    expect(await screen.findByText("My earlier scan")).toBeInTheDocument();
    expect(stored()[0].ownerId).toBe("u1");
    expect(ownedRequests()).toHaveLength(2);
  });

  it("takes up every earlier scan, not only the account's newest fifty", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `run-${i}`);
    serverOwns = ids;
    seed(ids.map((id, i) => legacy(id, `Scan ${i}`)));

    renderSettings("/account/history");

    await waitFor(() => expect(stored().every((u) => u.ownerId === "u1")).toBe(true));
    // Sent in one check, whatever GET /api/me/runs would have cut off.
    expect(JSON.parse(String((vi.mocked(global.fetch).mock.calls.find(([u]) => String(u).includes("/runs/owned"))![1] as RequestInit).body)).session_ids).toHaveLength(60);
  });

  it("Delete scan history takes an earlier scan up first, so it is deleted rather than left for the next visitor", async () => {
    seed([legacy("mine-1", "My earlier scan"), legacy("stranger-1", "Someone else's scan")]);
    // The provider's own attempt fails (server briefly busy), so nothing has
    // been adopted when Delete is pressed; the server's records are gone after.
    ownedReplies = [refused, ownedReply];
    const user = userEvent.setup();
    renderSettings("/account/privacy");
    await waitFor(() => expect(ownedRequests()).toHaveLength(1));

    await confirmDelete(user);

    expect(await screen.findByText(/Removed 1 scan and their results/i)).toBeInTheDocument();
    // Its copy in this browser went with the server's; the unnamed one is
    // nobody's to delete and stays where it was.
    expect(stored().map((u) => u.sessionId)).toEqual(["stranger-1"]);
    expect(stored()[0].ownerId).toBeUndefined();
  });

  it("Delete scan history deletes nothing, and says so, when the server cannot say which scans are the account's", async () => {
    seed([legacy("mine-1", "My earlier scan")]);
    ownedReplies = [refused];
    const user = userEvent.setup();
    renderSettings("/account/privacy");
    await waitFor(() => expect(ownedRequests()).toHaveLength(1));

    await confirmDelete(user);

    expect(await screen.findByText(/Couldn't check which of the scans saved in this browser are yours/i)).toBeInTheDocument();
    expect(deleted()).toBe(false);
    expect(screen.queryByText(/Removed/i)).not.toBeInTheDocument();
    expect(stored().map((u) => [u.sessionId, u.ownerId])).toEqual([["mine-1", undefined]]);

    // Once the server answers, the same action goes through.
    ownedReplies = [ownedReply];
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Removed 1 scan and their results/i)).toBeInTheDocument();
    expect(deleted()).toBe(true);
    expect(stored()).toEqual([]);
  });

  it("Delete scan history asks nothing of the server about scans that already have an owner", async () => {
    seed([legacy("mine-1", "Mine", { ownerId: "u1" })]);
    ownedReplies = [refused];
    const user = userEvent.setup();
    renderSettings("/account/privacy");
    await screen.findByRole("button", { name: "Delete scan history" });

    await confirmDelete(user);

    expect(await screen.findByText(/Removed 1 scan and their results/i)).toBeInTheDocument();
    expect(ownedRequests()).toHaveLength(0);
  });
});

describe("the Upload page, when earlier runs are adopted while it is open", () => {
  const renderUpload = () =>
    render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );
  const announce = (detail: RunsAdopted) =>
    act(async () => {
      window.dispatchEvent(new CustomEvent(RUNS_ADOPTED_EVENT, { detail }));
    });

  it("shows the adopted card and follows one that is still running", async () => {
    renderUpload();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/me/runs"))).toBe(true));

    const running = legacy("run-1", "Earlier running scan", { status: "Processing", timestamp: Date.now() - 1000, ownerId: "u1" });
    seed([running]);
    await announce({ userId: "u1", adopted: [running] });

    expect(await screen.findByText("Earlier running scan")).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/inference-status/run-1"))).toBe(true),
    );
  });

  it("ignores runs adopted for another account", async () => {
    renderUpload();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/me/runs"))).toBe(true));

    const theirs = legacy("run-2", "Their running scan", { status: "Processing", timestamp: Date.now() - 1000, ownerId: "u2" });
    seed([theirs]);
    await announce({ userId: "u2", adopted: [theirs] });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(calls.some((c) => c.url.includes("/api/inference-status/run-2"))).toBe(false);
  });
});
