"""Publish a file atomically without two writers sharing a temp name.

The write-temp-then-rename pattern only protects readers when every writer has
its own temp file. With one fixed name next to the shared file ("job.json.tmp"),
two concurrent writers open the same temp: one truncates the other's bytes
mid-write, and whichever renames second finds the temp already gone and fails,
so a write is lost or the shared file ends up empty or stale.
"""

from __future__ import annotations

import contextlib
import os
import re
import time
import uuid

# A temp this old belongs to a write that was killed (SIGKILL, the OOM killer, a
# worker timeout: none of which run the cleanup below). A write still going
# keeps touching its temp, so it never gets this old.
STALE_TEMP_SECONDS = 60 * 60


def sweep_stale_temps(directory, name, suffix=".tmp", *, max_age=STALE_TEMP_SECONDS):
    """Remove this module's own temps for ``name`` in ``directory`` left by dead writes.

    Only files named exactly as :func:`atomic_destination` names them
    (``.<name>.<32 hex><suffix>``) and untouched for ``max_age`` seconds.
    """
    pattern = re.compile(rf"\.{re.escape(name)}\.[0-9a-f]{{32}}{re.escape(suffix)}")
    cutoff = time.time() - max_age
    try:
        with os.scandir(directory or ".") as entries:
            for entry in entries:
                if not pattern.fullmatch(entry.name):
                    continue
                with contextlib.suppress(OSError):
                    if entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_mtime < cutoff:
                        os.unlink(entry.path)
    except OSError:
        pass  # no directory yet, or unreadable: nothing to sweep, and not the write's concern


@contextlib.contextmanager
def atomic_destination(path, *, suffix=".tmp"):
    """Yield a temp path unique to this write and rename it onto ``path`` on success.

    The temp sits in the same directory as ``path`` so the rename stays on one
    filesystem and is atomic. When the block raises, or the rename fails, the
    temp is removed and the original error propagates, so a failed write leaves
    neither a partial file at ``path`` nor a stray temp beside it. Temps that a
    killed write could not remove are swept from that directory first.
    """
    directory, name = os.path.split(os.fspath(path))
    sweep_stale_temps(directory, name, suffix)
    temp = os.path.join(directory, f".{name}.{uuid.uuid4().hex}{suffix}")
    try:
        yield temp
        os.replace(temp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise
