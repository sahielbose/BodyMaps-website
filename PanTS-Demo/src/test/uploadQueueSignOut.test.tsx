import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

// Files upload one at a time. Signing out while one is on the wire stops it,
// and every file still waiting behind it is skipped when its turn comes: it
// belongs to the account that left. Those files' unsent bytes used to stay
// counted, so the page kept saying to keep the tab open (and warning before
// it closed) with nothing uploading.

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

const CHUNK_SIZE = 512 * 1024;
const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

let calls: string[] = [];

beforeEach(() => {

  __resetUploadTabState();
  calls = [];
  store.pending = [];
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/logout")) return json({ ok: true });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      // Hangs until the upload is aborted (by the sign-out).
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
      });
    }
    if (u.includes("/api/upload-status")) return json({ received: [] });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SignOut = () => {
  const { signOut } = useAuth();
  return (
    <button type="button" onClick={() => void signOut()}>
      test sign out
    </button>
  );
};

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <SignOut />
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const settledSignedIn = () => screen.findByRole("button", { name: /^Model ePAI$/ });

/**
 * Whether the page says the tab is still needed. (The browser's leave prompt
 * is not the signal: these uploads were read back from IndexedDB, so closing
 * the tab loses nothing and the prompt stays off, see visualUploadPageRenameDrag.)
 */
const unloadWarns = () => !!document.querySelector(".proc-close-note:not(.proc-close-note--ready)");

const statusOf = (sid: string) =>
  (JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).find(
    (u) => u.sessionId === sid,
  )?.status;

describe("signing out with uploads waiting in the line", () => {
  it("stops counting their bytes, so the tab is no longer needed", async () => {
    const user = userEvent.setup();
    const entry = (sessionId: string, label: string): RecentUpload => ({
      sessionId,
      label,
      model: "ePAI",
      status: "Processing",
      timestamp: Date.now(),
      ownerId: "u1",
    });
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([entry("sid-a", "Scan A"), entry("sid-b", "Scan B")]));
    store.pending = ["sid-a", "sid-b"].map((sessionId) => ({
      sessionId,
      file: new Blob([new Uint8Array(CHUNK_SIZE * 2)]),
      filename: `${sessionId}.nii.gz`,
      model: "ePAI",
      bdmapId: "",
      totalChunks: 2,
      nextChunk: 0,
      chunkSize: CHUNK_SIZE,
    }));
    renderUpload();
    await settledSignedIn();
    // Scan A is on the wire and Scan B waits behind it; the bytes of both
    // keep the tab needed (the close note refreshes once a second).
    await waitFor(() => expect(calls.filter((c) => c.includes("/api/upload-inference-chunk"))).toHaveLength(2));
    await waitFor(() => expect(unloadWarns()).toBe(true), { timeout: 3000 });

    await user.click(screen.getByRole("button", { name: "test sign out" }));

    // Scan A is aborted, Scan B is skipped at its turn: nothing is uploading.
    await waitFor(() => expect(unloadWarns()).toBe(false), { timeout: 3000 });
    expect(calls.filter((c) => c.includes("/api/upload-inference-chunk"))).toHaveLength(2);
    expect(calls.some((c) => c.includes("/api/finalize-upload"))).toBe(false);
    // Both stay Processing, and their resumable copies stay for the next sign-in.
    expect(statusOf("sid-a")).toBe("Processing");
    expect(statusOf("sid-b")).toBe("Processing");
    expect(store.pending.map((p) => p.sessionId)).toEqual(["sid-a", "sid-b"]);
  });
});
