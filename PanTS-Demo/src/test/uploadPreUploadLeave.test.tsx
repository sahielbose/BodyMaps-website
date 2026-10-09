import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import type { PendingUpload } from "../helpers/pendingUploads";
import UploadPage from "../routes/UploadPage";

// A file is uploaded in the background the moment it is picked, before Run.
// Leaving /upload drops the selection (it lives in the page's state), so bytes
// nobody pressed Run for can never be used again: they are stopped and the
// server is asked to delete what already arrived. A pre-upload that Run has
// already handed on belongs to its run and is left to finish.

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

type Call = { url: string; sid: string; signal?: AbortSignal | null; keepalive?: boolean };
let calls: Call[] = [];
/** While set, chunk uploads hang until aborted or the gate opens. */
let holdChunks = false;
let gate: Promise<void>;
let openGate: () => void;
/** Sessions the server has a job for; any other one is not_found. */
let dispatched: Set<string>;

const callsTo = (path: string) => calls.filter((c) => c.url.includes(path));
const discards = () => callsTo("/api/discard-upload/");

beforeEach(() => {
  calls = [];
  dispatched = new Set();
  holdChunks = false;
  store.pending = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const sid = sessionOf(init?.body);
    calls.push({ url: u, sid, signal: init?.signal, keepalive: init?.keepalive });
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) {
      if (!holdChunks) return json({ ok: true });
      const signal = init?.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        void gate.then(() => resolve(json({ ok: true })));
      });
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
    if (u.includes("/api/discard-upload/")) return json({ status: "discarded" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  openGate();
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

const pickFile = async (container: HTMLElement, name = "scan.nii.gz") => {
  const user = userEvent.setup();
  const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await user.upload(input, new File([new Uint8Array(CHUNK_SIZE * 2)], name, { type: "application/gzip" }));
  return user;
};

describe("leaving /upload with a file picked but never run", () => {
  it("stops a pre-upload still in flight and asks the server to delete what arrived", async () => {
    holdChunks = true;
    const page = renderUpload();
    await settledSignedIn();
    await pickFile(page.container);
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(2));
    const inFlight = callsTo("/api/upload-inference-chunk");
    const sid = inFlight[0].sid;
    expect(inFlight.every((c) => c.signal && !c.signal.aborted)).toBe(true);

    page.unmount();

    expect(inFlight.every((c) => c.signal?.aborted)).toBe(true);
    await waitFor(() => expect(discards()).toHaveLength(1));
    expect(discards()[0].url).toContain(`/api/discard-upload/${sid}`);
    // The page is gone, so the request has to outlive it.
    expect(discards()[0].keepalive).toBe(true);
    await flush();
    // Nothing was finalized or dispatched, and no further chunk went out.
    expect(callsTo("/api/upload-inference-chunk")).toHaveLength(inFlight.length);
    expect(callsTo("/api/finalize-upload")).toHaveLength(0);
    expect(callsTo("/api/run-epai-inference")).toHaveLength(0);
  });

  it("asks the server to delete a pre-upload that had already finished", async () => {
    const page = renderUpload();
    await settledSignedIn();
    await pickFile(page.container);
    await screen.findByText(/ready/);
    const sid = callsTo("/api/finalize-upload")[0].sid;
    expect(discards()).toEqual([]);

    page.unmount();

    await waitFor(() => expect(discards()).toHaveLength(1));
    expect(discards()[0].url).toContain(`/api/discard-upload/${sid}`);
  });

  it("leaves a pre-upload that Run already handed on to finish its run", async () => {
    holdChunks = true;
    const page = renderUpload();
    await settledSignedIn();
    const user = await pickFile(page.container);
    await waitFor(() => expect(callsTo("/api/upload-inference-chunk").length).toBe(2));
    const inFlight = callsTo("/api/upload-inference-chunk");
    const sid = inFlight[0].sid;
    await user.click(screen.getByRole("button", { name: "Run" }));

    page.unmount();
    await flush();

    expect(inFlight.every((c) => c.signal && !c.signal.aborted)).toBe(true);
    expect(discards()).toEqual([]);

    // The bytes land and the run is dispatched, as if the page were still there.
    openGate();
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/run-epai-inference") && c.sid === sid)).toBe(true),
    );
    expect(discards()).toEqual([]);
  });
});
