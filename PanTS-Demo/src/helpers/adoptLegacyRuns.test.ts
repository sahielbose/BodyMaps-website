import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptLegacyRuns,
  adoptLegacyRunsUntilChecked,
  fetchListedRuns,
  RUNS_ADOPTED_EVENT,
  type RunsAdopted,
} from "./adoptLegacyRuns";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "./recentUploads";

const entry = (sessionId: string, extra: Partial<RecentUpload> = {}): RecentUpload => ({
  sessionId,
  label: sessionId,
  model: "ePAI",
  status: "Completed",
  timestamp: 1,
  ...extra,
});
const stored = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[];
const seed = (list: RecentUpload[]) => localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(list));

const reply = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 503, json: async () => body }) as unknown as Response;
const run = (id: string) => ({
  session_id: id, model: "ePAI", status: "completed", created_at: "2026-09-01T00:00:00Z",
});

describe("adoptLegacyRuns", () => {
  let heard: RunsAdopted[];
  /** The ids the server says are the account's. */
  let serverOwns: string[];
  const asked = () => vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).endsWith("/api/me/runs/owned"));
  const listen = (event: Event) => heard.push((event as CustomEvent<RunsAdopted>).detail);

  beforeEach(() => {
    heard = [];
    serverOwns = ["mine"];
    localStorage.clear();
    window.addEventListener(RUNS_ADOPTED_EVENT, listen);
    global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const ids = JSON.parse(String(init?.body ?? "{}")).session_ids ?? [];
      return reply({ owned: ids.filter((id: string) => serverOwns.includes(id)) });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    window.removeEventListener(RUNS_ADOPTED_EVENT, listen);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks about exactly the entries that have no owner, and stamps the ones the server names", async () => {
    seed([entry("mine"), entry("stranger"), entry("theirs", { ownerId: "u2" }), entry("done", { ownerId: "u1" })]);

    const adopted = await adoptLegacyRuns("u1");

    expect(adopted?.map((u) => u.sessionId)).toEqual(["mine"]);
    const [url, init] = asked()[0];
    expect(String(url)).toContain("/api/me/runs/owned");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(init?.body))).toEqual({ session_ids: ["mine", "stranger"] });
    // Only the named, unowned one; nobody else's is touched.
    expect(stored().map((u) => [u.sessionId, u.ownerId])).toEqual([
      ["mine", "u1"],
      ["stranger", undefined],
      ["theirs", "u2"],
      ["done", "u1"],
    ]);
    expect(heard).toHaveLength(1);
    expect(heard[0].userId).toBe("u1");
    expect(heard[0].adopted.map((u) => u.sessionId)).toEqual(["mine"]);
  });

  it("does not depend on how many runs the account has, only on what the server says", async () => {
    // Sixty entries, all the account's: the 50-run listing would name 50 of them.
    const ids = Array.from({ length: 60 }, (_, i) => `run-${i}`);
    serverOwns = ids;
    seed(ids.map((id) => entry(id)));

    const adopted = await adoptLegacyRuns("u1");

    expect(adopted).toHaveLength(60);
    expect(stored().every((u) => u.ownerId === "u1")).toBe(true);
  });

  it("asks nothing when every entry already has an owner", async () => {
    seed([entry("done", { ownerId: "u1" })]);

    expect(await adoptLegacyRuns("u1")).toEqual([]);

    expect(asked()).toHaveLength(0);
  });

  it("says nothing and writes nothing when the server names none of them", async () => {
    seed([entry("stranger")]);

    expect(await adoptLegacyRuns("u1")).toEqual([]);

    expect(heard).toEqual([]);
    expect(stored()[0].ownerId).toBeUndefined();
  });

  it("reports that it could not check, apart from having nothing to take up", async () => {
    seed([entry("mine")]);

    global.fetch = vi.fn(async () => reply({ error: "busy" }, false)) as unknown as typeof fetch;
    expect(await adoptLegacyRuns("u1")).toBeNull();
    global.fetch = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    expect(await adoptLegacyRuns("u1")).toBeNull();
    global.fetch = vi.fn(async () => reply({ owned: "nonsense" })) as unknown as typeof fetch;
    expect(await adoptLegacyRuns("u1")).toBeNull();
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError("bad"); } }) as unknown as Response) as unknown as typeof fetch;
    expect(await adoptLegacyRuns("u1")).toBeNull();

    expect(stored()[0].ownerId).toBeUndefined();
  });

  it("gives up on a request that stalls, so nothing waiting on it waits for ever", async () => {
    vi.useFakeTimers();
    seed([entry("mine")]);
    global.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    ) as unknown as typeof fetch;

    const pending = adoptLegacyRuns("u1");
    await vi.advanceTimersByTimeAsync(20000);

    expect(await pending).toBeNull();
    expect(stored()[0].ownerId).toBeUndefined();
  });

  it("gives up on a reply whose body stalls after its headers arrived", async () => {
    vi.useFakeTimers();
    seed([entry("mine")]);
    // Headers are in at once; the body never finishes (a proxy that stops
    // mid-reply). Nothing aborts a read like this on its own.
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response) as unknown as typeof fetch;

    const pending = adoptLegacyRuns("u1");
    await vi.advanceTimersByTimeAsync(20000);

    expect(await pending).toBeNull();
    expect(stored()[0].ownerId).toBeUndefined();
  });

  it("stamps nothing on an account that has been left since the request went out", async () => {
    seed([entry("mine")]);
    const controller = new AbortController();
    const pending = adoptLegacyRuns("u1", controller.signal);
    controller.abort();

    expect(await pending).toBeNull();
    expect(stored()[0].ownerId).toBeUndefined();
    expect(heard).toEqual([]);
  });
});

describe("fetchListedRuns", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => reply({ runs: [run("mine")] })) as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks the server once for callers that ask together, and again once that has finished", async () => {
    const [a, b] = await Promise.all([fetchListedRuns("u1"), fetchListedRuns("u1")]);
    expect(a).toEqual(b);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);

    await fetchListedRuns("u1");
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
  });

  it("does not let one account's request answer another's", async () => {
    await Promise.all([fetchListedRuns("u1"), fetchListedRuns("u2")]);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
  });

  it("is null, in the end, when the body of the reply stalls", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response) as unknown as typeof fetch;

    const pending = fetchListedRuns("u1");
    await vi.advanceTimersByTimeAsync(20000);

    expect(await pending).toBeNull();
  });

  it("is null when the list cannot be read", async () => {
    global.fetch = vi.fn(async () => reply({ error: "busy" }, false)) as unknown as typeof fetch;
    expect(await fetchListedRuns("u1")).toBeNull();
  });
});

describe("adoptLegacyRunsUntilChecked", () => {
  let heard: RunsAdopted[];
  /** One reply per request to /api/me/runs/owned; the last repeats. */
  let replies: (() => Response)[];
  const requests = () => vi.mocked(global.fetch).mock.calls.length;
  const listen = (event: Event) => heard.push((event as CustomEvent<RunsAdopted>).detail);
  const ok = () => reply({ owned: ["mine"] });
  const busy = () => reply({ error: "busy" }, false);
  let controller: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    heard = [];
    replies = [ok];
    controller = new AbortController();
    localStorage.clear();
    seed([entry("mine")]);
    window.addEventListener(RUNS_ADOPTED_EVENT, listen);
    global.fetch = vi.fn(async () => (replies.length > 1 ? replies.shift()! : replies[0])()) as unknown as typeof fetch;
  });
  afterEach(() => {
    controller.abort();
    window.removeEventListener(RUNS_ADOPTED_EVENT, listen);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks once, and is done, when the server answers", async () => {
    const done = adoptLegacyRunsUntilChecked("u1", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(stored()[0].ownerId).toBe("u1");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests()).toBe(1);
  });

  it("asks again after a check that could not be made, with a longer wait each time", async () => {
    replies = [busy, busy, ok];
    const done = adoptLegacyRunsUntilChecked("u1", controller.signal, [3000, 10000]);

    await vi.advanceTimersByTimeAsync(2999);
    expect(requests()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests()).toBe(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(requests()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(requests()).toBe(3);
    expect(stored()[0].ownerId).toBe("u1");
    expect(heard).toHaveLength(1);
  });

  it("asks again at once when the window gets focus, and when the network comes back", async () => {
    replies = [busy, busy, ok];
    const done = adoptLegacyRunsUntilChecked("u1", controller.signal, [60000]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests()).toBe(2);

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(requests()).toBe(3);
    expect(stored()[0].ownerId).toBe("u1");
  });

  it("does not send a second request while one is out", async () => {
    let release: (r: Response) => void = () => {};
    global.fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
    void adoptLegacyRunsUntilChecked("u1", controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(requests()).toBe(1);
    release(ok());
  });

  it("stops asking on its own after the last wait, but still asks when the window gets focus", async () => {
    replies = [busy];
    void adoptLegacyRunsUntilChecked("u1", controller.signal, [1000, 2000]);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(requests()).toBe(3);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests()).toBe(4);
  });

  it("stops for good, and stamps nothing, once the account has been left", async () => {
    replies = [busy];
    const done = adoptLegacyRunsUntilChecked("u1", controller.signal, [1000]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests()).toBe(1);

    controller.abort();
    await done;
    replies = [ok];
    await vi.advanceTimersByTimeAsync(60 * 1000);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(requests()).toBe(1);
    expect(stored()[0].ownerId).toBeUndefined();
  });

  it("lets go of the window's events once it is done, whichever way it ends", async () => {
    const removed = vi.spyOn(window, "removeEventListener");
    await adoptLegacyRunsUntilChecked("u1", controller.signal);
    expect(removed).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removed).toHaveBeenCalledWith("online", expect.any(Function));

    removed.mockClear();
    replies = [busy];
    const other = new AbortController();
    const done = adoptLegacyRunsUntilChecked("u1", other.signal);
    await vi.advanceTimersByTimeAsync(0);
    other.abort();
    await done;
    expect(removed).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removed).toHaveBeenCalledWith("online", expect.any(Function));
  });

  it("asks nothing for an account that was already left", async () => {
    controller.abort();
    await adoptLegacyRunsUntilChecked("u1", controller.signal);
    expect(requests()).toBe(0);
  });
});
