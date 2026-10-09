"""Bookkeeping for the resumable chunked-upload staging area (/tmp/uploads).

A chunked upload writes ``<root>/<session_id>/chunk-N`` per chunk and
``finalize-upload`` concatenates then deletes them. Two things were missing:

1. Nothing ever cleaned up an upload the user *abandoned* — a tab closed
   mid-transfer left its chunks on disk forever. ``sweep_stale_uploads``
   reclaims session dirs untouched for longer than ``CHUNK_TTL_SECONDS``.
2. A resuming client had no way to ask what the server actually still has, so
   it trusted its own cursor and could finalize over gaps.
   ``first_missing_chunk`` gives it ground truth instead.

Kept dependency-light (stdlib only, no app/DB/dataset) so it can be unit-tested
in CI — same rationale as path_safety.py.
"""

import os
import re
import shutil
import threading
import time

# How long an interrupted upload stays resumable. A tab closed over lunch or
# overnight resumes without re-sending; anything older is treated as abandoned
# and its (often hundreds of MB) partial scan is reclaimed.
CHUNK_TTL_SECONDS = 24 * 60 * 60

# A finalize keeps its lock fresh while it works (``FinalizeHeartbeat`` touches
# it every FINALIZE_LOCK_BEAT_SECONDS), so a lock that has not been touched for
# FINALIZE_LOCK_STALE_SECONDS belongs to a finalize that is no longer there (its
# worker was killed by a deploy, a crash or the OOM killer) and nobody is
# finalizing: a discard treats the upload as abandoned, and a finalize takes the
# lock over (``acquire_finalize_lock``). The limit is several minutes, far past
# the longest single step a live finalize takes (a multi-GB fsync, a DICOM
# series read or write, each tens of seconds at the outside) and past many missed
# beats; the beat is a small fraction of it.
FINALIZE_LOCK_STALE_SECONDS = 5 * 60
FINALIZE_LOCK_BEAT_SECONDS = 20

# A takeover is decided under a token of its own, held for a few filesystem
# calls. One left behind by a taker that died is cleared after this long.
TAKEOVER_TOKEN_STALE_SECONDS = 30
_TAKEOVER_SUFFIX = ".takeover"

# Left in a finalized upload's folder by a discard that arrived while a finalize
# was still running, for that finalize to act on (see discard_upload).
DISCARD_NOTE = ".discarded"

_CHUNK_RE = re.compile(r"^chunk-(\d+)$")


def received_chunks(session_dir):
    """Sorted indices of chunks in an already-resolved staging directory.

    Returns ``[]`` when the session has no staging dir (never started, already
    finalized, or swept). Resolving and authorizing the directory remains the
    caller's responsibility, so this helper never builds a path from a request
    value.
    """
    try:
        names = os.listdir(session_dir)
    except (FileNotFoundError, NotADirectoryError):
        return []
    indices = []
    for name in names:
        match = _CHUNK_RE.match(name)
        if match:
            indices.append(int(match.group(1)))
    return sorted(indices)


def finalize_running(lock_path, now=None):
    """Whether a finalize holds ``lock_path``: it exists and was touched recently."""
    try:
        age = (time.time() if now is None else now) - os.path.getmtime(lock_path)
    except OSError:
        return False
    return age < FINALIZE_LOCK_STALE_SECONDS


def takeover_in_progress(lock_path, now=None):
    """Whether another request is taking over ``lock_path`` from a finalize that died.

    Its takeover token exists and is not itself left over from a taker that
    died. A request refused the lock while that is so is not looking at a
    finalize that is gone: someone is about to finalize (or delete) under it.
    """
    try:
        age = (time.time() if now is None else now) - os.path.getmtime(f"{lock_path}{_TAKEOVER_SUFFIX}")
    except OSError:
        return False
    return age < TAKEOVER_TOKEN_STALE_SECONDS


def _create_exclusive(path):
    """Create an empty file that must not exist yet; FileExistsError if it does."""
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))


def acquire_finalize_lock(lock_path):
    """Take the finalize lock at ``lock_path``; False while a finalize holds it.

    The lock is a file made with O_EXCL, so of any number of workers asking at
    once exactly one gets a free lock. One that has not been touched for
    FINALIZE_LOCK_STALE_SECONDS was left by a finalize that died, and is taken
    over: whoever creates the takeover token (also O_EXCL) alone replaces the
    dead lock, having looked at it again under the token, so two retries that
    both found the same dead lock cannot both end up holding it, and a live
    lock is never moved or deleted. Uses nothing but O_EXCL creates and
    removes, so it works wherever those do. FileNotFoundError (the staging
    folder is gone) is the caller's to handle.
    """
    try:
        _create_exclusive(lock_path)
        return True
    except FileExistsError:
        pass
    if finalize_running(lock_path):
        return False

    token = f"{lock_path}{_TAKEOVER_SUFFIX}"
    try:
        _create_exclusive(token)
    except FileExistsError:
        # Someone is taking it over right now, unless that taker died holding it.
        try:
            stale_token = time.time() - os.path.getmtime(token) >= TAKEOVER_TOKEN_STALE_SECONDS
        except OSError:
            stale_token = True
        if not stale_token:
            return False
        try:
            os.remove(token)
        except FileNotFoundError:
            pass
        try:
            _create_exclusive(token)
        except FileExistsError:
            return False
    try:
        # Under the token: a takeover that finished before ours began has made
        # a fresh lock since we looked.
        if finalize_running(lock_path):
            return False
        try:
            os.remove(lock_path)
        except FileNotFoundError:
            pass
        try:
            _create_exclusive(lock_path)
        except FileExistsError:
            return False  # a free lock was taken in the moment it was vacant
        return True
    finally:
        try:
            os.remove(token)
        except OSError:
            pass


class FinalizeHeartbeat:
    """Keeps a finalize lock fresh for as long as the finalize that took it runs.

    A thread touches the lock every FINALIZE_LOCK_BEAT_SECONDS, so no single
    step of the finalize (a long fsync, a DICOM conversion) can outlast the
    stale limit whatever it is doing; ``beat`` touches it at once for a caller
    that wants to at a step boundary. If the worker dies, the thread dies with
    it and the lock goes stale. ``stop`` before removing the lock.
    """

    def __init__(self, lock_path):
        self._path = lock_path
        self._stopped = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name="finalize-lock-heartbeat", daemon=True,
        )
        self._thread.start()

    def beat(self):
        try:
            os.utime(self._path, None)
        except OSError:
            pass  # the lock is gone (its staging folder was removed): nothing to keep

    def _run(self):
        while not self._stopped.wait(FINALIZE_LOCK_BEAT_SECONDS):
            self.beat()

    def stop(self):
        self._stopped.set()
        self._thread.join(timeout=5)


def first_missing_chunk(indices):
    """Length of the contiguous 0..N-1 prefix in ``indices``.

    This is the index a resuming client should start from: everything before it
    is definitely on disk, so re-sending it would be wasted bytes. A gap makes
    the whole tail suspect (finalize concatenates by index), so the first hole
    wins even if later chunks exist.
    """
    expected = 0
    for index in sorted(indices):
        if index > expected:
            break
        if index == expected:
            expected += 1
    return expected


def sweep_stale_uploads(root, ttl_seconds=CHUNK_TTL_SECONDS, now=None):
    """Delete session dirs under ``root`` untouched for ``ttl_seconds``.

    Age is directory mtime, which a chunk write refreshes — so an upload still
    making progress is never swept no matter how large the file is. Returns the
    session ids removed. Best-effort: a dir that vanishes or can't be removed
    mid-sweep is skipped rather than failing the caller (this runs inline on an
    upload request).
    """
    now = time.time() if now is None else now
    cutoff = now - ttl_seconds
    removed = []
    try:
        entries = os.listdir(root)
    except FileNotFoundError:
        return removed
    for name in entries:
        path = os.path.join(root, name)
        try:
            if not os.path.isdir(path):
                continue
            if os.path.getmtime(path) >= cutoff:
                continue
            shutil.rmtree(path)
            removed.append(name)
        except OSError:
            continue
    return removed


def sweep_discarded_uploads(inference_root, chunk_root):
    """Delete finalized uploads whose discard note no finalize is left to honour.

    A discard that arrives while a finalize is running leaves its note and goes:
    the finalize deletes the upload itself. If that worker died, nobody does,
    and neither sweep would ever look in ``inference_root`` or at a staging
    folder whose lock is stale. The lock is taken over as a retry would take it,
    so a finalize starting now cannot assemble under the delete; one that holds
    a fresh lock is left to act on the note. Returns the session ids removed.
    """
    removed = []
    try:
        entries = os.listdir(inference_root)
    except FileNotFoundError:
        return removed
    for name in entries:
        finalized = os.path.join(inference_root, name)
        staging = os.path.join(chunk_root, name)
        try:
            if not os.path.isfile(os.path.join(finalized, DISCARD_NOTE)):
                continue
            if os.path.isdir(staging):
                if not acquire_finalize_lock(os.path.join(staging, ".finalizing")):
                    continue
                shutil.rmtree(staging, ignore_errors=True)
            shutil.rmtree(finalized)
            removed.append(name)
        except OSError:
            continue
    return removed
