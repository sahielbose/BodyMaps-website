"""A per-IP request ceiling for the endpoints that take no auth.

Deliberately in-process and approximate. There is no Redis here, and the
alternative (a new dependency plus somewhere to run it) costs more than the
precision is worth: these are abuse ceilings, not quotas anyone is billed
against. Two consequences worth knowing:

  * gunicorn runs more than one worker, each with its own counters, so the real
    ceiling is about `limit` times the worker count.
  * The key is the client IP, so an institution behind one NAT shares a bucket.
    Limits are set high enough that this doesn't bite in practice.

Note that the client IP is only the *client's* if the app is behind a proxy it
trusts — see TRUST_PROXY in app.py. Without it every request behind nginx keys
on the proxy's address and the whole site shares one bucket.
"""

import threading
import time


class Limiter:
    """Fixed-window counter, keyed by IP.

    A fixed window rather than a sliding one on purpose: it is one tuple per
    key, and the worst case it allows (a double burst across a window boundary)
    is not worth a deque per caller to prevent.
    """

    # Past this many tracked keys, drop the expired ones. Bounds the dict
    # against a spray of forged X-Forwarded-For values.
    MAX_BUCKETS = 10_000

    def __init__(self, window_seconds: int):
        self._window = window_seconds
        self._lock = threading.Lock()
        self._buckets: dict[str, tuple[float, int]] = {}  # key -> (window start, count)

    def over(self, key: str, limit: int) -> bool:
        """Count this request against `key`'s window. True if it should be
        refused. A limit of 0 turns the ceiling off."""
        if limit <= 0:
            return False

        return self._count(key) > limit

    def _count(self, key: str) -> int:
        """Add one to `key`'s window and return its new count."""
        now = time.monotonic()
        with self._lock:
            if len(self._buckets) > self.MAX_BUCKETS:
                for existing, (started, _) in list(self._buckets.items()):
                    if now - started >= self._window:
                        del self._buckets[existing]

            started, count = self._buckets.get(key, (now, 0))
            if now - started >= self._window:
                started, count = now, 0
            self._buckets[key] = (started, count + 1)
            return count + 1

    def at_limit(self, key: str, limit: int) -> bool:
        """Whether `key` has already used up its window, without counting this
        request. Pair with hit() to count only some outcomes (failed logins)."""
        if limit <= 0:
            return False
        now = time.monotonic()
        with self._lock:
            started, count = self._buckets.get(key, (now, 0))
            return now - started < self._window and count >= limit

    def hit(self, key: str) -> None:
        """Count one event against `key`'s window."""
        self._count(key)

    def clear(self, key: str) -> None:
        """Forget `key`'s counter."""
        with self._lock:
            self._buckets.pop(key, None)

    def reset(self) -> None:
        """Forget every counter. For tests, which would otherwise leak a full
        window's worth of state into the next one."""
        with self._lock:
            self._buckets.clear()
