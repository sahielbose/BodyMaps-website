import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// A run the server refuses at dispatch (plan limit, queue full, an error) never
// gets a job, and its resumable record is dropped, so nothing on the page
// points at the CT it uploaded any more. The server keeps that file until
// someone deletes it, so the page asks for it to be deleted (the server refuses
// if a job exists after all).

const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };
const CHUNK_SIZE = 512 * 1024;

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

let calls: { method: string; url: string }[];
let runSessionId: string | null;
let runReply: (sid: string) => ReturnType<typeof json>;
/** What /api/discard-upload answers. */
let discardReply: () => ReturnType<typeof json>;

beforeEach(() => {
  __resetUploadTabState();
  calls = [];
  runSessionId = null;
  runReply = () => json({ message: "started" });
  discardReply = () => json({ status: "discarded" });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/login")) return json({ user: USER });
    if (u.includes("/api/discard-upload/")) return discardReply();
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) return json({ ok: true });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "scan.nii.gz" });
    if (u.includes("/api/run-epai-inference")) {
      runSessionId = String((init?.body as FormData).get("session_id"));
      return runReply(runSessionId);
    }
    if (u.includes("/api/inference-status/")) return json({ status: "running" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const discards = () => calls.filter((c) => c.url.includes("/api/discard-upload/"));
const stored = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];

// A stand-in for the header's sign-in.
const SignIn = () => {
  const { signIn } = useAuth();
  return (
    <button type="button" onClick={() => void signIn("one@example.com", "pw")}>
      test sign in
    </button>
  );
};

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <SignIn />
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const runOneScan = async () => {
  const user = userEvent.setup();
  const { container } = renderUpload();
  await waitFor(() => expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument());
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, new File([new Uint8Array(CHUNK_SIZE)], "scan.nii.gz"));
  await screen.findByText(/ready/);
  await user.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(runSessionId).not.toBeNull());
};

describe("a run refused when it is dispatched", () => {
  it("asks for the uploaded CT to be deleted when the plan refuses it (402)", async () => {
    runReply = () =>
      json({ error: "Used up", code: "plan_limit", reason: "daily_scans", plan: "free", limit: 1, used: 1 }, false, 402);

    await runOneScan();

    await waitFor(() => expect(discards()).toHaveLength(1));
    expect(discards()[0]).toMatchObject({ method: "POST", url: expect.stringContaining(`/api/discard-upload/${runSessionId}`) });
    expect(stored()[0].status).toBe("Cancelled");
  });

  it("asks for it when the queue is full (429)", async () => {
    runReply = () => json({ error: "The queue is full" }, false, 429);

    await runOneScan();

    await waitFor(() => expect(discards()).toHaveLength(1));
    expect(discards()[0].url).toContain(`/api/discard-upload/${runSessionId}`);
    expect(stored()[0].status).toBe("Failed");
  });

  it("asks for it when the server errors (500)", async () => {
    runReply = () => json({ error: "Boom" }, false, 500);

    await runOneScan();

    await waitFor(() => expect(discards()).toHaveLength(1));
    expect(stored()[0].status).toBe("Failed");
  });

  it("asks for it (401, the sign-in lapsed), and again once the person has signed in, when the first ask met the same 401", async () => {
    runReply = () => json({ error: "Sign in" }, false, 401);
    discardReply = () => json({ error: "Sign in" }, false, 401);
    const user = userEvent.setup();

    await runOneScan();
    await waitFor(() => expect(discards()).toHaveLength(1));
    await waitFor(() => expect(stored()[0]?.status).toBe("Cancelled"));

    // The cookie is back with the next sign-in: the deletion is sent then.
    discardReply = () => json({ status: "discarded" });
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await waitFor(() => expect(discards()).toHaveLength(2));
    expect(discards()[1].url).toContain(`/api/discard-upload/${runSessionId}`);

    // Done: a later sign-in does not send it again.
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(discards()).toHaveLength(2);
  });

  // What is waiting to be deleted, in this browser.
  const waiting = () => JSON.parse(localStorage.getItem("bodymaps-discard-after-sign-in") ?? "[]") as string[];

  it.each([
    ["the network fails", () => { throw new TypeError("Failed to fetch"); }],
    ["the server errs (503)", () => json({ error: "busy" }, false, 503)],
    ["the server is busy (429)", () => json({ error: "slow down" }, false, 429)],
  ])("keeps the deletion, and sends it again, when the resend after sign-in meets: %s", async (_name, failure) => {
    runReply = () => json({ error: "Sign in" }, false, 401);
    discardReply = () => json({ error: "Sign in" }, false, 401);
    const user = userEvent.setup();
    await runOneScan();
    await waitFor(() => expect(discards()).toHaveLength(1));

    discardReply = failure;
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await waitFor(() => expect(discards()).toHaveLength(2));
    // Not answered: still waiting, not lost.
    await waitFor(() => expect(waiting()).toEqual([runSessionId]));

    discardReply = () => json({ status: "discarded" });
    await user.click(screen.getByRole("button", { name: "test sign in" }));
    await waitFor(() => expect(discards()).toHaveLength(3));
    await waitFor(() => expect(waiting()).toEqual([]));
  });

  it("keeps a deletion whose first try met a network failure or a server error, whatever the run was refused for", async () => {
    runReply = () => json({ error: "Boom" }, false, 500);
    discardReply = () => {
      throw new TypeError("Failed to fetch");
    };

    await runOneScan();

    await waitFor(() => expect(discards()).toHaveLength(1));
    await waitFor(() => expect(waiting()).toEqual([runSessionId]));
  });

  it.each([
    ["it was deleted", () => json({ status: "discarded" })],
    ["it is already gone (404)", () => json({ error: "gone" }, false, 404)],
    ["it is not this account's (403)", () => json({ error: "no" }, false, 403)],
    ["a job exists (409)", () => json({ error: "running" }, false, 409)],
  ])("stops waiting once the server has answered for good: %s", async (_name, answer) => {
    runReply = () => json({ error: "Sign in" }, false, 401);
    discardReply = () => json({ error: "Sign in" }, false, 401);
    const user = userEvent.setup();
    await runOneScan();
    await waitFor(() => expect(discards()).toHaveLength(1));
    expect(waiting()).toEqual([runSessionId]);

    discardReply = answer;
    await user.click(screen.getByRole("button", { name: "test sign in" }));

    await waitFor(() => expect(waiting()).toEqual([]));
    expect(discards()).toHaveLength(2);
  });

  it("still asks after the page is reloaded before the person signs in again", async () => {
    runReply = () => json({ error: "Sign in" }, false, 401);
    discardReply = () => json({ error: "Sign in" }, false, 401);

    await runOneScan();
    await waitFor(() => expect(discards()).toHaveLength(1));
    cleanup();

    discardReply = () => json({ status: "discarded" });
    renderUpload();

    await waitFor(() => expect(discards()).toHaveLength(2));
    expect(discards()[1].url).toContain(`/api/discard-upload/${runSessionId}`);
  });

  it("follows the run, and does not fail, cancel or delete it, when the server already has a request for it (409 run_in_progress)", async () => {
    // A replay after a reload, or a second tab: the first request made the job.
    runReply = () => json({ error: "A run for this session is already going.", code: "run_in_progress" }, false, 409);

    await runOneScan();

    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/inference-status/"))).toBe(true));
    expect(discards()).toHaveLength(0);
    expect(stored()[0].status).toBe("Processing");
    expect(screen.queryByText(/marked as failed|no longer exists/i)).not.toBeInTheDocument();
  });

  it("still fails a run that is refused with some other 409", async () => {
    runReply = () => json({ error: "This run was cancelled.", code: "cancelled" }, false, 409);

    await runOneScan();

    await waitFor(() => expect(stored()[0]?.status).toBe("Failed"));
    await waitFor(() => expect(discards()).toHaveLength(1));
  });

  it("leaves the file alone when the run started", async () => {
    await runOneScan();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/inference-status/"))).toBe(true));

    expect(discards()).toHaveLength(0);
  });

  it("does not try to delete an upload the server says belongs to another account (403)", async () => {
    runReply = () => json({ error: "Not yours" }, false, 403);

    await runOneScan();
    await waitFor(() => expect(stored()[0]?.status).toBe("Failed"));

    expect(discards()).toHaveLength(0);
  });
});
