import { useEffect, useState } from "react";
import { API_BASE } from "./constants";
import {
  adoptOwnedRuns,
  loadRecentUploads,
  persistRecentUploads,
  type RecentUpload,
} from "./recentUploads";

// Runs saved before entries carried an owner have none, so the account rule
// (runsOf) shows them to nobody who is signed in until the server says whose
// they are. That used to be a guess from GET /api/me/runs, which lists only an
// account's newest 50 runs and nothing that has not run yet, and only on the
// Upload page. Now the page asks the server about exactly the session ids it
// holds with no owner (POST /api/me/runs/owned), from the auth provider once
// sign-in settles, and again just before Delete scan history removes the
// server's records. Which ids are the account's is then exact, however many
// runs it has.

export const RUNS_ADOPTED_EVENT = "bodymaps-runs-adopted";

export type RunsAdopted = { userId: string; adopted: RecentUpload[] };

// A request that stalls must not hold up whatever waits on it (Delete scan
// history waits on this one). The time covers the whole exchange, the reply's
// body included: a connection that stalls after the headers is as stuck as one
// that stalls before them.
const REQUEST_TIMEOUT_MS = 15000;

/** Whether the reply was a 2xx and, if so, its parsed JSON.
 *  Rejects when `signal` aborts or the time runs out, whichever part of the reply
 *  is pending, and when the body is not JSON. */
async function fetchJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<{ ok: boolean; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort);
  // Settles when the request is given up on, even if the pending read itself
  // (a body that never ends) does not react to the abort.
  let onGiveUp: () => void = () => {};
  const gaveUp = new Promise<never>((_resolve, reject) => {
    onGiveUp = () => reject(new DOMException("Aborted", "AbortError"));
    if (controller.signal.aborted) onGiveUp();
    else controller.signal.addEventListener("abort", onGiveUp);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, { ...init, signal: controller.signal });
        return { ok: res.ok, data: res.ok ? await res.json() : undefined };
      })(),
      gaveUp,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", onGiveUp);
  }
}

const inFlight = new Map<string, Promise<unknown>>();

/** The runs the server lists for this account (GET /api/me/runs), or null when
 *  they could not be read. Callers that ask while a request for the same
 *  account is out share it. The reply lists whoever the cookie belonged to when
 *  it was sent, so a caller whose account has changed since must drop it
 *  (each one checks its own signal). */
export function fetchListedRuns(userId: string): Promise<unknown> {
  const running = inFlight.get(userId);
  if (running) return running;
  const request = (async (): Promise<unknown> => {
    try {
      const { ok, data } = await fetchJson(`${API_BASE}/api/me/runs`, { credentials: "include" });
      return ok ? ((data as { runs?: unknown } | null)?.runs ?? null) : null;
    } catch {
      return null;
    }
  })();
  inFlight.set(userId, request);
  void request.finally(() => {
    if (inFlight.get(userId) === request) inFlight.delete(userId);
  });
  return request;
}

// What the server takes in one check; the list never holds more than this.
const OWNED_CHECK_LIMIT = 500;

/** Stamps the account on the entries with no owner that the server says are its own.
 *  Resolves to the entries that were adopted ([] when there was nothing to
 *  take up), or to null when the server could not be asked or answered badly:
 *  the two are different, because a caller about to delete the account's
 *  records must not go on without knowing. Announces what it adopted on
 *  `window`, so a page already showing the list can refresh. `signal` ends an
 *  attempt whose account is no longer the signed-in one (that is null too). */
export async function adoptLegacyRuns(
  userId: string,
  signal?: AbortSignal,
): Promise<RecentUpload[] | null> {
  const ids = loadRecentUploads()
    .filter((u) => u.ownerId === undefined)
    .map((u) => u.sessionId)
    .slice(0, OWNED_CHECK_LIMIT);
  if (ids.length === 0) return [];
  let owned: unknown;
  try {
    const { ok, data } = await fetchJson(
      `${API_BASE}/api/me/runs/owned`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ids }),
      },
      signal,
    );
    if (!ok) return null;
    owned = (data as { owned?: unknown } | null)?.owned;
  } catch {
    return null;
  }
  if (signal?.aborted || !Array.isArray(owned)) return null;
  // Read now, not before the request: the list may have changed meanwhile.
  const { list, adopted } = adoptOwnedRuns(loadRecentUploads(), owned, userId);
  if (adopted.length === 0) return [];
  persistRecentUploads(list);
  window.dispatchEvent(
    new CustomEvent<RunsAdopted>(RUNS_ADOPTED_EVENT, { detail: { userId, adopted } }),
  );
  return adopted;
}

// How long to wait before asking again after a check could not be made: quick
// at first (a server that was just restarting), then slower. After the last one
// only the tab coming back into focus or the network coming back asks again.
const RETRY_DELAYS_MS = [3000, 10000, 30000, 60000];

/** adoptLegacyRuns, asked again until the server has answered.
 *  A check that could not be made (null) would otherwise leave the account's
 *  earlier scans hidden until the page is reloaded, with nothing to say so.
 *  It asks again after a delay, and at once when the window gets focus or the
 *  network comes back. Resolves once the server has answered (adopted or not)
 *  or `signal` aborts, and touches nothing after that. */
export function adoptLegacyRunsUntilChecked(
  userId: string,
  signal: AbortSignal,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let running = false;
    let finished = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener("focus", attempt);
      window.removeEventListener("online", attempt);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    async function attempt() {
      if (finished || running) return;
      clearTimeout(timer);
      running = true;
      const result = await adoptLegacyRuns(userId, signal);
      running = false;
      if (finished) return;
      if (result !== null) return finish();
      failures += 1;
      if (failures <= delays.length) timer = setTimeout(attempt, delays[failures - 1]);
    }

    if (signal.aborted) return finish();
    signal.addEventListener("abort", finish);
    window.addEventListener("focus", attempt);
    window.addEventListener("online", attempt);
    void attempt();
  });
}

/** Changes every time runs are adopted, for a reader that re-reads the list when it does. */
export function useRunsAdoptedVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onAdopted = () => setVersion((v) => v + 1);
    window.addEventListener(RUNS_ADOPTED_EVENT, onAdopted);
    return () => window.removeEventListener(RUNS_ADOPTED_EVENT, onAdopted);
  }, []);
  return version;
}
