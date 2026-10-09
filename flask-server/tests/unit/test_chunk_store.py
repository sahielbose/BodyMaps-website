"""Unit tests for the chunked-upload staging bookkeeping.

Dependency-light (tmp dirs only, no app/DB/dataset) so they run in CI, matching
test_path_safety.py. These lock in the two guarantees resume depends on: the
sweeper never touches an upload that is still progressing, and the resume index
never skips past a gap.
"""

import os
import signal
import socket
import subprocess
import sys
import time

import pytest

from api import chunk_store

from api.chunk_store import (
    CHUNK_TTL_SECONDS,
    FINALIZE_LOCK_STALE_SECONDS,
    DISCARD_NOTE,
    FinalizeHeartbeat,
    acquire_finalize_lock,
    finalize_running,
    first_missing_chunk,
    received_chunks,
    sweep_discarded_uploads,
    sweep_stale_uploads,
)


def _make_session(root, session_id, chunk_indices, age_seconds=0):
    session_dir = os.path.join(root, session_id)
    os.makedirs(session_dir, exist_ok=True)
    for index in chunk_indices:
        with open(os.path.join(session_dir, f"chunk-{index}"), "wb") as handle:
            handle.write(b"x")
    if age_seconds:
        stamp = time.time() - age_seconds
        os.utime(session_dir, (stamp, stamp))
    return session_dir


# ---- received_chunks --------------------------------------------------------

def test_lists_chunk_indices_numerically(tmp_path):
    # Sorted as ints, not strings: "chunk-10" must not sort before "chunk-2".
    session_dir = _make_session(str(tmp_path), "sid", [0, 1, 2, 10])
    assert received_chunks(session_dir) == [0, 1, 2, 10]


def test_missing_session_dir_is_empty_not_an_error(tmp_path):
    assert received_chunks(os.path.join(str(tmp_path), "never-existed")) == []


def test_ignores_non_chunk_files(tmp_path):
    session_dir = _make_session(str(tmp_path), "sid", [0])
    os.makedirs(os.path.join(session_dir, "dicom"))
    with open(os.path.join(session_dir, "notes.txt"), "w") as handle:
        handle.write("hi")
    assert received_chunks(session_dir) == [0]


# ---- first_missing_chunk ----------------------------------------------------

@pytest.mark.parametrize("indices,expected", [
    ([], 0),                    # nothing uploaded: start from the beginning
    ([0, 1, 2], 3),             # clean prefix: resume right after it
    ([0, 1, 3], 2),             # gap at 2: rewind to it, don't trust the tail
    ([1, 2, 3], 0),             # chunk 0 missing: everything is suspect
    ([0, 1, 1, 2], 3),          # duplicates are harmless
    ([5, 0, 2, 1], 3),          # unsorted input, gap at 3
])
def test_first_missing_chunk(indices, expected):
    assert first_missing_chunk(indices) == expected


# ---- sweep_stale_uploads ----------------------------------------------------

def test_sweeps_only_dirs_older_than_ttl(tmp_path):
    _make_session(str(tmp_path), "fresh", [0], age_seconds=60)
    _make_session(str(tmp_path), "stale", [0], age_seconds=CHUNK_TTL_SECONDS + 60)

    removed = sweep_stale_uploads(str(tmp_path))

    assert removed == ["stale"]
    assert os.path.isdir(os.path.join(str(tmp_path), "fresh"))
    assert not os.path.exists(os.path.join(str(tmp_path), "stale"))


def test_in_progress_upload_is_never_swept(tmp_path):
    # The regression that matters: a huge upload started long ago but still
    # receiving chunks. Writing a chunk refreshes the dir mtime, so it stays.
    session_dir = _make_session(str(tmp_path), "sid", [0], age_seconds=CHUNK_TTL_SECONDS * 3)
    with open(os.path.join(session_dir, "chunk-1"), "wb") as handle:
        handle.write(b"x")

    assert sweep_stale_uploads(str(tmp_path)) == []
    assert os.path.isdir(session_dir)


def test_missing_root_is_a_noop(tmp_path):
    assert sweep_stale_uploads(os.path.join(str(tmp_path), "absent")) == []


def test_leaves_loose_files_alone(tmp_path):
    stray = os.path.join(str(tmp_path), "stray.txt")
    with open(stray, "w") as handle:
        handle.write("hi")
    stamp = time.time() - CHUNK_TTL_SECONDS * 2
    os.utime(stray, (stamp, stamp))

    assert sweep_stale_uploads(str(tmp_path)) == []
    assert os.path.exists(stray)


def test_finalize_lock_counts_as_held_only_while_it_is_fresh(tmp_path):
    lock = os.path.join(str(tmp_path), ".finalizing")
    assert not finalize_running(lock)

    with open(lock, "w"):
        pass
    assert finalize_running(lock)

    stamp = time.time() - FINALIZE_LOCK_STALE_SECONDS - 1
    os.utime(lock, (stamp, stamp))
    assert not finalize_running(lock)


def _lock_aged(tmp_path, seconds):
    lock = os.path.join(str(tmp_path), ".finalizing")
    with open(lock, "w"):
        pass
    stamp = time.time() - seconds
    os.utime(lock, (stamp, stamp))
    return lock


def test_acquiring_a_free_lock_creates_it(tmp_path):
    lock = os.path.join(str(tmp_path), ".finalizing")

    assert acquire_finalize_lock(lock)
    assert finalize_running(lock)


def test_a_fresh_lock_is_refused_and_left_untouched(tmp_path):
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS - 60)
    before = os.stat(lock)

    assert not acquire_finalize_lock(lock)

    after = os.stat(lock)
    assert (after.st_ino, after.st_mtime) == (before.st_ino, before.st_mtime)
    assert os.listdir(str(tmp_path)) == [".finalizing"]


def test_a_lock_older_than_the_stale_limit_is_taken_over(tmp_path):
    # The same limit finalize_running applies, which is what a discard uses.
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS + 60)
    assert not finalize_running(lock)

    assert acquire_finalize_lock(lock)

    assert finalize_running(lock)
    assert os.listdir(str(tmp_path)) == [".finalizing"]
    # It is held now: the next retry is refused.
    assert not acquire_finalize_lock(lock)


def test_a_lock_nobody_touched_for_minutes_is_dead_whatever_it_says_about_who_made_it(tmp_path):
    # A restarted container can give a new worker the pid of the one that died
    # mid-finalize, so who a lock says made it is nothing to go by: only that it
    # is no longer being touched. Ten minutes is a finalize that is not running.
    lock = os.path.join(str(tmp_path), ".finalizing")
    with open(lock, "w") as handle:
        handle.write(f"v1 {socket.gethostname()} - {os.getpid()} 1\n")  # this very pid
    stamp = time.time() - 10 * 60
    os.utime(lock, (stamp, stamp))

    assert not finalize_running(lock)
    assert acquire_finalize_lock(lock)
    assert finalize_running(lock)


def test_a_takeover_that_finished_meanwhile_is_not_overtaken(tmp_path, monkeypatch):
    # Two retries find the same dead lock. One completes its takeover after the
    # other has looked but before it holds the takeover token, so the lock the
    # other is about to replace is the first one's fresh, live lock.
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS + 60)
    real_create = chunk_store._create_exclusive
    winner = {}

    def other_retry_takes_over_first(path):
        if path.endswith(".takeover") and not winner:
            monkeypatch.setattr(chunk_store, "_create_exclusive", real_create)
            assert acquire_finalize_lock(lock)
            winner["inode"] = os.stat(lock).st_ino
        return real_create(path)

    monkeypatch.setattr(chunk_store, "_create_exclusive", other_retry_takes_over_first)

    assert not acquire_finalize_lock(lock)

    # The live lock is where the winner left it, and nobody's token is left.
    assert os.stat(lock).st_ino == winner["inode"]
    assert os.listdir(str(tmp_path)) == [".finalizing"]


def test_a_lock_made_in_the_moment_the_dead_one_is_gone_is_not_replaced(tmp_path, monkeypatch):
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS + 60)
    real_remove = os.remove
    made = {}

    def a_fresh_finalize_arrives(path, *args, **kwargs):
        real_remove(path, *args, **kwargs)
        if path == lock and not made:
            made["yes"] = True
            with open(lock, "x"):
                pass  # the path is vacant, and a free lock is taken on the spot
            made["inode"] = os.stat(lock).st_ino

    monkeypatch.setattr(os, "remove", a_fresh_finalize_arrives)

    assert not acquire_finalize_lock(lock)

    assert os.stat(lock).st_ino == made["inode"]
    assert os.listdir(str(tmp_path)) == [".finalizing"]


def test_a_takeover_in_progress_is_left_to_finish(tmp_path):
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS + 60)
    token = lock + ".takeover"
    with open(token, "w"):
        pass
    before = os.stat(lock)

    assert not acquire_finalize_lock(lock)

    assert os.stat(lock).st_ino == before.st_ino
    assert os.path.exists(token)


def test_a_takeover_token_left_by_a_taker_that_died_is_cleared(tmp_path):
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS + 60)
    token = lock + ".takeover"
    with open(token, "w"):
        pass
    stamp = time.time() - chunk_store.TAKEOVER_TOKEN_STALE_SECONDS - 1
    os.utime(token, (stamp, stamp))

    assert acquire_finalize_lock(lock)

    assert finalize_running(lock)
    assert os.listdir(str(tmp_path)) == [".finalizing"]


def test_the_lock_needs_nothing_but_exclusive_creates_and_removes(tmp_path, monkeypatch):
    # No hard links and no renames: the same code path works on a filesystem
    # that has neither (some FUSE, CIFS and object-store mounts).
    def forbidden(*_args, **_kwargs):
        raise OSError("operation not supported")

    monkeypatch.setattr(os, "link", forbidden)
    monkeypatch.setattr(os, "rename", forbidden)
    free = os.path.join(str(tmp_path), ".finalizing")
    assert acquire_finalize_lock(free)
    assert not acquire_finalize_lock(free)

    (tmp_path / "other").mkdir()
    stale = _lock_aged(tmp_path / "other", FINALIZE_LOCK_STALE_SECONDS + 60)
    assert acquire_finalize_lock(stale)
    assert finalize_running(stale)
    assert not acquire_finalize_lock(stale)


def _discarded_upload(tmp_path, session_id, lock_age=None):
    """A finalized upload carrying a discard note, and its staging folder when a lock age is given."""
    finalized = tmp_path / "inference" / session_id
    (finalized / "BDMAP_00000001").mkdir(parents=True)
    (finalized / "BDMAP_00000001" / "ct.nii.gz.partial-1").write_bytes(b"half")
    (finalized / DISCARD_NOTE).write_text("")
    if lock_age is not None:
        staging = tmp_path / "chunks" / session_id
        staging.mkdir(parents=True)
        (staging / "chunk-0").write_bytes(b"0")
        lock = staging / ".finalizing"
        lock.write_text("")
        stamp = time.time() - lock_age
        os.utime(lock, (stamp, stamp))
    return finalized, tmp_path / "chunks" / session_id


def _sweep_discarded(tmp_path):
    return sweep_discarded_uploads(str(tmp_path / "inference"), str(tmp_path / "chunks"))


def test_a_discarded_upload_is_reaped_once_the_lock_of_its_finalize_is_stale(tmp_path):
    # The worker died while the lock was still fresh, so the discard left its
    # note for a finalize that never came back.
    finalized, staging = _discarded_upload(tmp_path, "sid", lock_age=FINALIZE_LOCK_STALE_SECONDS + 60)

    assert _sweep_discarded(tmp_path) == ["sid"]

    assert not finalized.exists()
    assert not staging.exists()


def test_a_discarded_upload_is_left_to_a_finalize_that_may_still_be_running(tmp_path):
    finalized, staging = _discarded_upload(tmp_path, "sid", lock_age=FINALIZE_LOCK_STALE_SECONDS - 60)

    assert _sweep_discarded(tmp_path) == []

    assert (finalized / DISCARD_NOTE).exists()
    assert (staging / "chunk-0").exists()


def test_a_discarded_upload_with_no_staging_folder_left_is_reaped(tmp_path):
    finalized, _staging = _discarded_upload(tmp_path, "sid")

    assert _sweep_discarded(tmp_path) == ["sid"]

    assert not finalized.exists()


def test_uploads_nobody_discarded_are_left_alone(tmp_path):
    finalized, _staging = _discarded_upload(tmp_path, "sid")
    (finalized / DISCARD_NOTE).unlink()
    assert _sweep_discarded(tmp_path) == []
    assert (finalized / "BDMAP_00000001").exists()
    assert sweep_discarded_uploads(str(tmp_path / "missing"), str(tmp_path / "chunks")) == []


# ---- a finalize keeps its lock fresh while it works ---------------------------

def _wait_until(condition, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return condition()


def test_the_heartbeat_keeps_a_lock_fresh_and_stops_when_told(tmp_path, monkeypatch):
    monkeypatch.setattr(chunk_store, "FINALIZE_LOCK_BEAT_SECONDS", 0.01)
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS - 5)  # about to go stale

    heartbeat = FinalizeHeartbeat(lock)
    try:
        assert _wait_until(lambda: time.time() - os.path.getmtime(lock) < 1)
    finally:
        heartbeat.stop()

    settled = os.path.getmtime(lock)
    time.sleep(0.1)
    assert os.path.getmtime(lock) == settled
    assert not heartbeat._thread.is_alive()


def test_a_beat_touches_the_lock_at_once(tmp_path, monkeypatch):
    monkeypatch.setattr(chunk_store, "FINALIZE_LOCK_BEAT_SECONDS", 3600)
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS - 5)
    heartbeat = FinalizeHeartbeat(lock)
    try:
        heartbeat.beat()
        assert time.time() - os.path.getmtime(lock) < 1
    finally:
        heartbeat.stop()


def test_the_heartbeat_survives_its_lock_being_removed(tmp_path, monkeypatch):
    # The finalize's own last step removes the staging folder holding the lock.
    monkeypatch.setattr(chunk_store, "FINALIZE_LOCK_BEAT_SECONDS", 0.01)
    lock = _lock_aged(tmp_path, 0)
    heartbeat = FinalizeHeartbeat(lock)
    try:
        os.remove(lock)
        time.sleep(0.1)
        assert heartbeat._thread.is_alive()  # no error took it down
    finally:
        heartbeat.stop()
    assert not os.path.exists(lock)  # and it did not make one


_WORKER = """
import os, sys, time
sys.path.insert(0, {root!r})
from api import chunk_store
chunk_store.FINALIZE_LOCK_STALE_SECONDS = float(sys.argv[2])
chunk_store.FINALIZE_LOCK_BEAT_SECONDS = float(sys.argv[3])
assert chunk_store.acquire_finalize_lock(sys.argv[1])
chunk_store.FinalizeHeartbeat(sys.argv[1])
print("held", flush=True)
sys.stdin.read()
"""

_API_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_a_lock_is_only_ever_taken_from_a_worker_that_stopped_touching_it(tmp_path, monkeypatch):
    # A real worker process finalizing (its heartbeat running) for several times
    # the stale limit is never taken from; once it is killed, its lock goes
    # stale after the limit, not before and not never.
    limit = 0.6
    monkeypatch.setattr(chunk_store, "FINALIZE_LOCK_STALE_SECONDS", limit)
    lock = os.path.join(str(tmp_path), ".finalizing")
    worker = subprocess.Popen(
        [sys.executable, "-c", _WORKER.format(root=_API_ROOT), lock, str(limit), "0.03"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert worker.stdout.readline().strip() == "held"
        deadline = time.time() + 3 * limit
        while time.time() < deadline:
            assert finalize_running(lock)
            assert not acquire_finalize_lock(lock)
            time.sleep(0.05)
        os.kill(worker.pid, signal.SIGKILL)
        worker.wait()
        killed_at = time.time()
        # Not dead the instant it was killed: it was touched a moment ago.
        assert finalize_running(lock)
        assert _wait_until(lambda: not finalize_running(lock), timeout=5 * limit)
        assert time.time() - killed_at >= limit * 0.5
        assert acquire_finalize_lock(lock)
    finally:
        worker.kill()
        worker.wait()


_RACER = """
import sys, time
sys.path.insert(0, {root!r})
from api.chunk_store import acquire_finalize_lock
while time.time() < float(sys.argv[2]):
    pass
print(acquire_finalize_lock(sys.argv[1]), flush=True)
sys.stdin.read()  # stays alive, like a worker in the middle of its finalize
"""


def _race(lock, racers=8):
    go = time.time() + 0.6
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", _RACER.format(root=_API_ROOT), lock, str(go)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        for _ in range(racers)
    ]
    try:
        return [p.stdout.readline().strip() for p in procs]
    finally:
        for p in procs:
            p.kill()
            p.wait()


def test_of_several_workers_asking_at_once_exactly_one_takes_a_free_lock(tmp_path):
    lock = os.path.join(str(tmp_path), ".finalizing")

    assert sorted(_race(lock)) == ["False"] * 7 + ["True"]
    assert os.listdir(str(tmp_path)) == [".finalizing"]


def test_of_several_workers_taking_over_the_same_dead_lock_exactly_one_holds_it(tmp_path):
    lock = _lock_aged(tmp_path, FINALIZE_LOCK_STALE_SECONDS + 60)

    assert sorted(_race(lock)) == ["False"] * 7 + ["True"]
    assert os.listdir(str(tmp_path)) == [".finalizing"]
    assert finalize_running(lock)
