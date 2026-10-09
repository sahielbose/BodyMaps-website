// A request to delete an upload that could not be answered (the sign-in had
// lapsed and it met a 401, the network dropped, the server erred or was busy)
// did nothing, and has to be made again. The session ids wait here, in this
// browser, until the server has answered one for good: a reload in between
// does not lose them, and they are sent again at the next sign-in or page load.

const KEY = "bodymaps-discard-after-sign-in";
const MAX_WAITING = 50;

const read = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const write = (ids: string[]) => {
  try {
    if (ids.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(ids.slice(-MAX_WAITING)));
  } catch {
    // Storage is unavailable: the file stays on the server, as it did before.
  }
};

export function queueDiscardAfterSignIn(sessionId: string): void {
  const waiting = read();
  if (!waiting.includes(sessionId)) write([...waiting, sessionId]);
}

/** The session ids still waiting to be discarded; they stay until forgotten. */
export function queuedDiscards(): string[] {
  return read();
}

/** The server has answered this one for good, so it is not waiting any more. */
export function forgetQueuedDiscard(sessionId: string): void {
  const waiting = read();
  if (waiting.includes(sessionId)) write(waiting.filter((id) => id !== sessionId));
}
