import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// A run is polled about every 2.5 seconds, and a poll takes a moment to come
// back. A Cancel pressed in that moment used to be undone by the reply: the
// page put the cancelled run back into its "running" phase, started its
// per-second refresh of the whole page, and asked for a duration estimate, all
// for a card that says Cancelled.

const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

let calls: string[];
/** Answers the first status request the test is holding, once it is called. */
let answerStatus: ((body: { status: string }) => void) | null;
let statusRequests: number;

beforeEach(() => {
  __resetUploadTabState();
  calls = [];
  answerStatus = null;
  statusRequests = 0;
  localStorage.clear();
  localStorage.setItem(
    RECENT_UPLOADS_KEY,
    JSON.stringify([
      {
        sessionId: "run-1",
        label: "Held scan",
        model: "ePAI",
        status: "Processing",
        timestamp: Date.now() - 1000,
        ownerId: "u1",
      } satisfies RecentUpload,
    ]),
  );
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/inference-status/")) {
      statusRequests += 1;
      if (statusRequests === 1) {
        return new Promise((resolve) => {
          answerStatus = (body) => resolve(json(body));
        });
      }
      return json({ status: "running" });
    }
    if (u.includes("/api/cancel-inference/")) return json({ status: "cancelled" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const cancelWhileAPollIsOut = async () => {
  const user = userEvent.setup();
  render(
    <AuthProvider>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );
  await waitFor(() => expect(answerStatus).not.toBeNull());
  await user.click(await screen.findByRole("button", { name: /^Cancel\b/ }));
  await waitFor(() => expect(calls.some((c) => c.includes("/api/cancel-inference/run-1"))).toBe(true));
  const cancelled = calls.length;
  return { cancelled };
};

describe("a status reply that comes back after Cancel", () => {
  it("does not put the cancelled run back to running, or start the per-second refresh", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { cancelled } = await cancelWhileAPollIsOut();
    const before = setIntervalSpy.mock.calls.filter(([, ms]) => ms === 1000).length;

    await act(async () => {
      answerStatus!({ status: "running" });
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 1000).length).toBe(before);
    // No duration estimate was asked for on behalf of a run that is not running.
    expect(calls.slice(cancelled).some((c) => c.includes("/api/inference-duration-estimate"))).toBe(false);
    // And it is not polled again.
    expect(calls.slice(cancelled).some((c) => c.includes("/api/inference-status/"))).toBe(false);
    const stored = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
    expect(stored[0].status).toBe("Cancelled");
  });

  it("does not turn a cancelled run into Completed or Failed either", async () => {
    await cancelWhileAPollIsOut();

    await act(async () => {
      answerStatus!({ status: "completed" });
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const stored = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
    expect(stored[0].status).toBe("Cancelled");
  });
});
