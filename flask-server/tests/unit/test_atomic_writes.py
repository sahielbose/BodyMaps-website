"""Writers that publish a shared file must not share a temp name.

A job's job.json is rewritten from whichever request or worker thread changes
its status, and _set_inference_job persists outside its lock, so two threads
can write one job at once. With one fixed temp name ("job.json.tmp") they
truncated each other's bytes and the second rename failed, so a write was lost
and only a log line said so. Every write now has its own temp file in the same
directory, writes to one job are serialized and take the newest state, and a
failed write leaves nothing behind.
"""

from __future__ import annotations

import json
import os
import threading
import time

import pytest
from flask import Flask

import api.api_blueprint as api_routes
from constants import Constants
from services import mesh_generation, user_dataset
from services.atomic_write import STALE_TEMP_SECONDS, atomic_destination

SID = "atomic-job"


@pytest.fixture
def runs(tmp_path, monkeypatch):
    folder = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(folder))
    yield folder
    api_routes.inference_jobs.pop(SID, None)
    if SID in api_routes._queued_order:
        api_routes._queued_order.remove(SID)


def _job_folder(runs):
    return runs / SID


def _on_disk(runs):
    return json.loads((_job_folder(runs) / "job.json").read_text())


def _all_reach_the_rename_together(monkeypatch, count):
    """Hold each writer at its rename until every writer has written its temp.

    Reproduces the bad interleaving on demand: with a shared temp name the first
    rename takes the file and the others find nothing to rename. A writer that
    is made to wait its turn (a lock) times out of the gate instead, so this
    never deadlocks a correct implementation.
    """
    gate = threading.Barrier(count)
    real_replace = os.replace

    def replace(source, destination):
        try:
            gate.wait(timeout=0.4)
        except threading.BrokenBarrierError:
            pass
        return real_replace(source, destination)

    monkeypatch.setattr(os, "replace", replace)


def _run_in_threads(*targets):
    failures = []

    def guarded(target):
        try:
            target()
        except BaseException as error:  # noqa: BLE001 - report it on the main thread
            failures.append(error)

    threads = [threading.Thread(target=guarded, args=(target,)) for target in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert not any(thread.is_alive() for thread in threads)
    assert not failures, failures


def test_two_concurrent_persists_of_one_job_both_succeed(runs, monkeypatch, capsys):
    _all_reach_the_rename_together(monkeypatch, 2)

    _run_in_threads(
        lambda: api_routes._persist_inference_job(SID, {"status": "queued", "n": 1}),
        lambda: api_routes._persist_inference_job(SID, {"status": "running", "n": 2}),
    )

    assert "[job persist]" not in capsys.readouterr().out
    assert _on_disk(runs)["status"] in ("queued", "running")
    assert [entry.name for entry in _job_folder(runs).iterdir()] == ["job.json"]


def test_many_concurrent_status_changes_leave_the_latest_state_on_disk(runs, capsys):
    def change(worker):
        def run():
            for step in range(25):
                api_routes._set_inference_job(SID, status="running", worker=worker, step=step)
        return run

    _run_in_threads(*[change(worker) for worker in range(8)])

    output = capsys.readouterr().out
    assert "[job persist]" not in output
    assert _on_disk(runs) == api_routes.inference_jobs[SID]
    assert [entry.name for entry in _job_folder(runs).iterdir()] == ["job.json"]


def test_a_late_write_of_an_older_snapshot_does_not_replace_the_newer_state(runs):
    api_routes._set_inference_job(SID, status="queued")
    older = dict(api_routes.inference_jobs[SID])
    api_routes._set_inference_job(SID, status="running")

    # The thread that took the "queued" snapshot is slow and writes last.
    api_routes._persist_inference_job(SID, older)

    assert _on_disk(runs)["status"] == "running"


def test_a_failed_persist_leaves_the_previous_file_and_no_temp(runs, capsys):
    api_routes._persist_inference_job(SID, {"status": "queued"})
    unwritable = {}
    unwritable["itself"] = unwritable  # json.dump raises on the circular reference

    api_routes._persist_inference_job(SID, unwritable)

    assert "[job persist]" in capsys.readouterr().out
    assert _on_disk(runs) == {"status": "queued"}
    assert [entry.name for entry in _job_folder(runs).iterdir()] == ["job.json"]


def test_a_failed_rename_removes_its_temp(tmp_path, monkeypatch):
    target = tmp_path / "shared.json"
    target.write_text("old")

    def refuse(_source, _destination):
        raise PermissionError("no")

    monkeypatch.setattr(os, "replace", refuse)
    with pytest.raises(PermissionError):
        with atomic_destination(str(target)) as temp:
            with open(temp, "w") as stream:
                stream.write("new")

    assert target.read_text() == "old"
    assert [entry.name for entry in tmp_path.iterdir()] == ["shared.json"]


def _left_by_a_killed_write(directory, name, suffix, age_seconds):
    """A temp as atomic_destination names it, as a killed write leaves it."""
    leftover = directory / f".{name}.{'a1' * 16}{suffix}"
    leftover.write_bytes(b"half")
    then = time.time() - age_seconds
    os.utime(leftover, (then, then))
    return leftover


def test_temps_left_by_a_killed_write_are_swept_by_the_next_write_to_that_file(tmp_path):
    _left_by_a_killed_write(tmp_path, "job.json", ".tmp", STALE_TEMP_SECONDS + 60)
    older = _left_by_a_killed_write(tmp_path, "job.json", ".tmp", STALE_TEMP_SECONDS + 3600)
    older.rename(tmp_path / f".job.json.{'b2' * 16}.tmp")  # a second one, under its own name

    with atomic_destination(str(tmp_path / "job.json")) as temp:
        with open(temp, "w") as stream:
            stream.write("{}")

    assert sorted(entry.name for entry in tmp_path.iterdir()) == ["job.json"]


def test_the_sweep_leaves_alone_what_is_not_a_dead_temp_of_that_file(tmp_path):
    fresh = _left_by_a_killed_write(tmp_path, "job.json", ".tmp", 60)  # a write still going
    another_files = _left_by_a_killed_write(tmp_path, "other.json", ".tmp", STALE_TEMP_SECONDS + 60)
    another_suffix = _left_by_a_killed_write(tmp_path, "job.json", ".part", STALE_TEMP_SECONDS + 60)
    not_ours = tmp_path / ".job.json.notahexname.tmp"
    not_ours.write_bytes(b"x")
    then = time.time() - STALE_TEMP_SECONDS - 60
    os.utime(not_ours, (then, then))
    a_folder = tmp_path / f".job.json.{'c3' * 16}.tmp"
    a_folder.mkdir()
    os.utime(a_folder, (then, then))

    with atomic_destination(str(tmp_path / "job.json")) as temp:
        with open(temp, "w") as stream:
            stream.write("{}")

    for kept in (fresh, another_files, another_suffix, not_ours, a_folder):
        assert kept.exists(), kept.name


# Every server writer that publishes a shared file by rename, run twice: each
# write must use a temp name of its own, in the same directory as the file.


def _record_a_duration(tmp_path, monkeypatch):
    monkeypatch.setattr(api_routes, "_JOB_DURATIONS_PATH", str(tmp_path / "job_durations.jsonl"))
    return lambda _n: api_routes._record_job_duration("ePAI", 1000, 12.3), tmp_path / "job_durations.jsonl"


def _save_the_registry(tmp_path, monkeypatch):
    registry = {"next_id": 1, "sha256": {}, "phash": {}, "events": []}
    return lambda _n: user_dataset._save_registry(str(tmp_path), registry), tmp_path / "registry.json"


def _write_a_mesh_asset(tmp_path, monkeypatch):
    target = tmp_path / "liver.glb"
    return lambda _n: mesh_generation._write_atomic(str(target), b"glTF"), target


def _cache_a_mesh_on_request(tmp_path, monkeypatch):
    cache = tmp_path / "mesh-cache"
    monkeypatch.setattr(Constants, "MESH_PATH", str(cache))
    monkeypatch.setattr(api_routes, "_ai_local_mask_path", lambda _digits: "labels.nii.gz")
    monkeypatch.setattr(api_routes, "generate_organ_glb_bytes", lambda _organ, _path: b"glTF")
    app = Flask(__name__)
    app.register_blueprint(api_routes.api_blueprint, url_prefix="/api")
    target = cache / "PanTS_00000035" / "liver.glb"

    def request(_n):
        target.unlink(missing_ok=True)
        assert app.test_client().get("/api/cases/PanTS_00000035/render_only/liver.glb").status_code == 200

    return request, target


def _download_a_case_file(tmp_path, monkeypatch):
    monkeypatch.setattr(api_routes, "_AI_HF_CACHE_ROOT", str(tmp_path / "hf"))

    class Reply:
        def raise_for_status(self):
            return None

        def iter_content(self, chunk_size):
            yield b"nifti"

    monkeypatch.setattr(api_routes.requests, "get", lambda *_args, **_kwargs: Reply())
    target = tmp_path / "hf" / "PanTS_00000035" / "combined_labels.nii.gz"

    def download(_n):
        target.unlink(missing_ok=True)
        assert api_routes._ai_download_case_file("PanTS_00000035", "mask_only", target.name) == str(target)

    return download, target


@pytest.mark.parametrize(
    "setup",
    [
        _record_a_duration,
        _save_the_registry,
        _write_a_mesh_asset,
        _cache_a_mesh_on_request,
        _download_a_case_file,
    ],
)
def test_each_write_of_a_shared_file_gets_its_own_temp(setup, tmp_path, monkeypatch):
    write, target = setup(tmp_path, monkeypatch)
    target.parent.mkdir(parents=True, exist_ok=True)
    real_replace = os.replace
    published = []

    def replace(source, destination):
        published.append((str(source), str(destination)))
        return real_replace(source, destination)

    monkeypatch.setattr(os, "replace", replace)

    write(0)
    write(1)

    mine = [(source, destination) for source, destination in published if destination == str(target)]
    assert len(mine) == 2
    assert mine[0][0] != mine[1][0]
    assert all(os.path.dirname(source) == str(target.parent) for source, _ in mine)
    assert not [entry for entry in target.parent.iterdir() if entry.name.endswith((".tmp", ".part"))]
