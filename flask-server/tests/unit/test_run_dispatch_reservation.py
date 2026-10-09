"""Two run requests for one session must not both start a run.

A run request copies and checks the CT for seconds before its job exists. A
second request for the same session in that time (a tab's replay after a
reload, two tabs, a double click) used to get through the same checks: both
copied the CT, both went on to start a worker. The second is now answered
409 run_in_progress, before anything is metered, and the session is free
again on every way out of the first.
"""

from __future__ import annotations

import os
import threading
import time
import types

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as api_routes

SID = "dup"


@pytest.fixture
def run(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    seen = {"recorded": [], "ran": [], "release": threading.Event(), "blocked": None, "sessions": {SID}}
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)
    monkeypatch.setattr(api_routes.plan_store, "check_inference", lambda *_args: seen["blocked"])
    monkeypatch.setattr(
        api_routes.plan_store, "record_inference", lambda *args: seen["recorded"].append(args),
    )
    monkeypatch.setattr(api_routes.plan_store, "finish_inference", lambda *_args: None)
    monkeypatch.setattr(api_routes, "cancel_session", lambda _sid: False)
    monkeypatch.setattr(api_routes, "_early_cancels", {}, raising=False)

    # The threads the run requests start, so teardown can wait for each to be
    # done, not only for its status to change: a worker goes on writing the
    # job's file and its plan record after that.
    seen["threads"] = []

    class RecordedThread(threading.Thread):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            seen["threads"].append(self)

    # A copy of the module's own view of `threading`, so no other thread in the
    # process is swapped for a recording one.
    recording = types.SimpleNamespace(**{name: getattr(threading, name) for name in dir(threading)})
    recording.Thread = RecordedThread
    monkeypatch.setattr(api_routes, "threading", recording)

    def worker(*args, **kwargs):
        seen["ran"].append(args)
        # Gets the GPU slot, as a real run does: the job is "running" from here.
        kwargs["on_start"]()
        seen["release"].wait(5)  # a run that takes a while, until the test lets it end
        return None

    monkeypatch.setattr(api_routes, "run_auto_segmentation", worker)
    ct = tmp_path / "ct.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.int16), np.eye(4)), str(ct))
    seen["ct"] = str(ct)
    yield seen
    # Every run the test started ends before its patches are undone, so no
    # worker writes into the real folders or plan store afterwards.
    seen["release"].set()
    for worker_thread in seen["threads"]:
        worker_thread.join(10)
        assert not worker_thread.is_alive(), "a run's worker outlived the test"
    for sid in seen["sessions"]:
        api_routes.inference_jobs.pop(sid, None)
        api_routes._dispatching.pop(sid, None)


def _wait_until_ended(sid):
    deadline = time.time() + 5
    while time.time() < deadline and (api_routes.inference_jobs.get(sid) or {}).get("status") in ("queued", "running"):
        time.sleep(0.01)


def _wait_until_running(sid):
    deadline = time.time() + 5
    while time.time() < deadline and (api_routes.inference_jobs.get(sid) or {}).get("status") != "running":
        time.sleep(0.01)


def _start(run, sid=SID):
    run["sessions"].add(sid)
    with Flask(__name__).test_request_context(method="POST"):
        return api_routes._start_auto_segmentation(sid, "ePAI", server_input_path=run["ct"])


def _during_the_first_request(monkeypatch, run, target, name):
    """Send a second run request just as the first reaches `target.name`."""
    real = getattr(target, name)
    second = []

    def second_first(*args, **kwargs):
        if not second:
            second.append(_start(run))
        return real(*args, **kwargs)

    monkeypatch.setattr(target, name, second_first)
    return second


def test_a_second_request_while_the_first_is_still_copying_is_refused_and_not_metered(run, monkeypatch):
    second = _during_the_first_request(monkeypatch, run, api_routes.nib, "load")

    first_response, first_status = _start(run)

    assert first_status == 200, first_response.get_json()
    response, status = second[0]
    assert (status, response.get_json()["code"]) == (409, "run_in_progress")
    # One copy, one scan, one worker.
    assert len(run["recorded"]) == 1
    deadline = time.time() + 5
    while time.time() < deadline and not run["ran"]:
        time.sleep(0.01)
    assert len(run["ran"]) == 1


def test_a_second_request_while_the_job_is_queued_or_running_is_refused_and_not_metered(run):
    first_response, first_status = _start(run)
    assert first_status == 200, first_response.get_json()
    _wait_until_running(SID)
    # It has the GPU slot: "running", the other half of the check.
    assert api_routes.inference_jobs[SID]["status"] == "running"

    response, status = _start(run)

    assert (status, response.get_json()["code"]) == (409, "run_in_progress")
    assert len(run["recorded"]) == 1

    # And "queued", before the slot is granted.
    api_routes._set_inference_job(SID, status="queued")
    response, status = _start(run)
    assert (status, response.get_json()["code"]) == (409, "run_in_progress")
    assert len(run["recorded"]) == 1


def test_a_run_can_be_started_again_once_the_last_one_has_ended(run):
    assert _start(run)[1] == 200
    run["release"].set()
    _wait_until_ended(SID)

    response, status = _start(run)

    assert status == 200, response.get_json()
    assert len(run["recorded"]) == 2


def test_another_session_is_not_held_up(run):
    assert _start(run)[1] == 200

    response, status = _start(run, sid="other")

    assert status == 200, response.get_json()


def _refuse_by_plan(run, monkeypatch):
    run["blocked"] = {"message": "Used up", "reason": "daily_scans"}


def _unreadable_ct(run, monkeypatch):
    def bad(*_args, **_kwargs):
        raise ValueError("not a NIfTI")

    monkeypatch.setattr(api_routes.nib, "load", bad)


def _cancelled_meanwhile(run, monkeypatch):
    real = api_routes.nib.load

    def load_then_cancel(*args, **kwargs):
        with Flask(__name__).test_request_context(method="POST"):
            api_routes.cancel_inference_session.__wrapped__(SID)
        return real(*args, **kwargs)

    monkeypatch.setattr(api_routes.nib, "load", load_then_cancel)


def _metering_breaks(run, monkeypatch):
    def broken(*_args):
        raise RuntimeError("database is down")

    monkeypatch.setattr(api_routes.plan_store, "record_inference", broken)


@pytest.mark.parametrize(
    "fail",
    [_refuse_by_plan, _unreadable_ct, _cancelled_meanwhile, _metering_breaks],
    ids=["plan-refusal", "unreadable-ct", "cancelled", "exception"],
)
def test_the_session_is_free_again_after_every_way_a_request_can_end_early(run, monkeypatch, fail):
    fail(run, monkeypatch)
    try:
        _start(run)
    except RuntimeError:
        pass  # the exception path: it propagates, and must still let go

    assert SID not in api_routes._dispatching
    assert SID not in api_routes.inference_jobs  # nothing was left holding the session either


def _status(account="owner", sid=SID):
    real = api_routes.current_user
    api_routes.current_user = lambda: {"id": account}
    try:
        with Flask(__name__).test_request_context(method="GET"):
            response, status = api_routes.get_inference_status.__wrapped__(sid)
            return status, response.get_json()
    finally:
        api_routes.current_user = real


def test_the_status_is_starting_for_the_account_that_made_the_request_while_it_copies(run, monkeypatch):
    seen = []

    def look(*args, **kwargs):
        if not seen:
            seen.append((_status(), _status("stranger")))
        return real(*args, **kwargs)

    real = api_routes.nib.load
    monkeypatch.setattr(api_routes.nib, "load", look)

    assert _start(run)[1] == 200

    owner, stranger = seen[0]
    # Not "not found": a page following the run must not give up on it.
    assert owner == (200, {"status": "starting", "session_id": SID})
    # Nothing new for anyone else: the same answer as for a session with no job.
    assert stranger[0] == 404
    assert stranger[1]["status"] == "not_found"


def test_the_status_is_not_found_again_when_the_request_ended_without_a_job(run):
    run["blocked"] = {"message": "Used up", "reason": "daily_scans"}
    assert _start(run)[1] == 402

    status, body = _status()

    assert (status, body["status"]) == (404, "not_found")


def test_the_status_is_the_jobs_once_it_exists(run):
    assert _start(run)[1] == 200
    _wait_until_running(SID)

    status, body = _status()

    assert (status, body["status"]) == (200, "running")


def _finalized_upload(tmp_path, monkeypatch):
    sessions_root = tmp_path / "sessions"
    # The api module's own Constants: other tests reload the module by name.
    monkeypatch.setattr(api_routes.Constants, "SESSIONS_DIR_NAME", str(sessions_root))
    monkeypatch.setattr(api_routes, "CHUNK_DIR", str(tmp_path / "chunks"))
    finalized = sessions_root / "inference" / SID
    (finalized / "BDMAP_00000001").mkdir(parents=True)
    (finalized / ".owner").write_text("owner")
    (finalized / "BDMAP_00000001" / "ct.nii.gz").write_bytes(b"ct")
    return finalized


def _discard():
    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.discard_upload.__wrapped__(SID)
        return status, response.get_json()


def _during_the_copy(monkeypatch, action):
    """Run `action` once, as the run request reaches its NIfTI check (it is reserved by then)."""
    seen = []
    real = api_routes.nib.load

    def look(*args, **kwargs):
        if not seen:
            seen.append(action())
        return real(*args, **kwargs)

    monkeypatch.setattr(api_routes.nib, "load", look)
    return seen


def _cancel():
    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.cancel_inference_session.__wrapped__(SID)
        return status, response.get_json()


def _sweep():
    """The periodic sweep any upload request may run (see _maybe_sweep_uploads)."""
    return api_routes.sweep_discarded_uploads(
        os.path.join(api_routes.Constants.SESSIONS_DIR_NAME, "inference"), api_routes.CHUNK_DIR,
    )


def test_a_discard_while_the_run_request_is_still_copying_waits_for_it_and_deletes_nothing_yet(
    run, monkeypatch, tmp_path
):
    # A gateway answered 502 for the run request, so the page asks for the
    # upload to be deleted, while the server is still copying it.
    finalized = _finalized_upload(tmp_path, monkeypatch)
    seen = _during_the_copy(monkeypatch, lambda: (_discard(), finalized.exists()))

    response, status = _start(run)

    assert status == 200, response.get_json()
    (discard_status, discard_body), still_there = seen[0]
    # Final for the page: nothing to ask again, the request settles it.
    assert (discard_status, discard_body["status"]) == (202, "discarding")
    assert still_there
    # The run went ahead and works from its own copy, so the upload is its now:
    # left in place, and nothing left held that would delete it later.
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").exists()
    assert SID not in api_routes._held_discards


def test_a_cancel_during_the_copy_leaves_no_upload_behind_once_the_request_ends(run, monkeypatch, tmp_path):
    # Cancel finds no job to stop (404), so the page discards the upload: the
    # request that was copying it is the last one that could use it, and ends
    # without a job.
    finalized = _finalized_upload(tmp_path, monkeypatch)
    seen = _during_the_copy(monkeypatch, lambda: (_cancel(), _discard(), finalized.exists()))

    response, status = _start(run)

    assert (status, response.get_json()["code"]) == (409, "cancelled")
    (cancel_status, _), (discard_status, discard_body), still_there = seen[0]
    assert cancel_status == 404
    assert (discard_status, discard_body["status"]) == (202, "discarding")
    assert still_there  # not deleted under the request while it was copying
    assert not finalized.exists()
    assert SID not in api_routes.inference_jobs
    assert SID not in api_routes._dispatching


def test_a_sweep_while_a_discard_is_held_leaves_the_upload_under_the_request(run, monkeypatch, tmp_path):
    # The held discard must not look like a discarded upload to the sweep: it
    # deletes any finalized folder marked so that no finalize is left to
    # honour, and this one is being copied from.
    finalized = _finalized_upload(tmp_path, monkeypatch)
    seen = _during_the_copy(
        monkeypatch,
        lambda: (_discard(), _sweep(), (finalized / "BDMAP_00000001" / "ct.nii.gz").exists()),
    )

    response, status = _start(run)

    assert status == 200, response.get_json()
    (discard_status, _body), swept, ct_there = seen[0]
    assert discard_status == 202
    assert swept == []
    assert ct_there
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").exists()
    assert not any(entry.name == ".discarded" for entry in finalized.iterdir())


def test_the_upload_of_a_held_discard_goes_only_when_the_request_ends_without_a_run(run, monkeypatch, tmp_path):
    finalized = _finalized_upload(tmp_path, monkeypatch)
    seen = _during_the_copy(monkeypatch, lambda: (_cancel(), _discard(), _sweep(), finalized.exists()))

    response, status = _start(run)

    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert seen[0][2:] == ([], True)  # the sweep found nothing to take, the upload was there
    assert not finalized.exists()  # and then the request that held the discard took it
    assert not api_routes._held_discards


@pytest.mark.parametrize(
    "refuse",
    [_refuse_by_plan, _unreadable_ct, _metering_breaks],
    ids=["plan-refusal", "unreadable-ct", "exception"],
)
def test_every_refusal_that_makes_no_job_carries_out_a_discard_it_was_holding(run, monkeypatch, tmp_path, refuse):
    finalized = _finalized_upload(tmp_path, monkeypatch)
    # Written as the run request is reserved: at the first thing it does that a
    # test can see (the plan check), which every refusal here comes after.
    real_check = api_routes.plan_store.check_inference

    def discard_then_check(*args):
        discard_then_check.answer = _discard()
        return real_check(*args)

    monkeypatch.setattr(api_routes.plan_store, "check_inference", discard_then_check)
    refuse(run, monkeypatch)
    try:
        _start(run)
    except RuntimeError:
        pass  # the exception case propagates, and must still settle the discard

    assert discard_then_check.answer[0] == 202
    assert not finalized.exists()


def test_a_discard_held_back_is_not_carried_out_for_a_request_that_was_not_asked_to(run, monkeypatch, tmp_path):
    # The same refusal with no discard in between: the upload stays, as before
    # (an API client that was refused keeps what it uploaded to try again).
    finalized = _finalized_upload(tmp_path, monkeypatch)
    run["blocked"] = {"message": "Used up", "reason": "daily_scans"}

    assert _start(run)[1] == 402

    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").exists()


def test_a_discard_from_another_account_is_not_held_back_for_the_request(run, monkeypatch, tmp_path):
    finalized = _finalized_upload(tmp_path, monkeypatch)

    def stranger_discards():
        real = api_routes.current_user
        api_routes.current_user = lambda: {"id": "stranger"}
        try:
            return _discard()
        finally:
            api_routes.current_user = real

    seen = _during_the_copy(monkeypatch, stranger_discards)

    assert _start(run)[1] == 200

    assert seen[0][0] == 403
    assert not (finalized / ".discarded").exists()


def test_a_discard_with_no_finalized_upload_to_take_back_leaves_nothing_behind(run, monkeypatch, tmp_path):
    # A run started from a file sent with the request has no finalized folder.
    monkeypatch.setattr(api_routes.Constants, "SESSIONS_DIR_NAME", str(tmp_path / "sessions"))
    monkeypatch.setattr(api_routes, "CHUNK_DIR", str(tmp_path / "chunks"))
    seen = _during_the_copy(monkeypatch, _discard)

    assert _start(run)[1] == 200

    assert seen[0][0] == 202
    assert not (tmp_path / "sessions").exists()


def _cancel_when_the_run_is_about_to_be_metered(run, monkeypatch):
    """A Cancel between the request's two looks for one: it finds no job to stop (404)."""
    real = api_routes.plan_store.record_inference
    answers = []

    def cancel_then_record(*args):
        answers.append(_cancel())
        return real(*args)

    monkeypatch.setattr(api_routes.plan_store, "record_inference", cancel_then_record)
    return answers


def test_a_discard_after_a_run_cancelled_before_it_started_still_deletes_the_upload(run, monkeypatch, tmp_path):
    # The Cancel noted itself but found no job, so the page discards the upload;
    # the request then makes its job, sees the cancel and leaves it "cancelled".
    # That discard arrives to a job that never ran.
    finalized = _finalized_upload(tmp_path, monkeypatch)
    answers = _cancel_when_the_run_is_about_to_be_metered(run, monkeypatch)

    response, status = _start(run)

    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert answers[0][0] == 404
    assert api_routes.inference_jobs[SID]["status"] == "cancelled"
    assert _discard() == (200, {"status": "discarded"})
    assert not finalized.exists()


def test_a_discard_after_a_run_that_ran_and_was_cancelled_is_still_refused(run, monkeypatch, tmp_path):
    finalized = _finalized_upload(tmp_path, monkeypatch)
    assert _start(run)[1] == 200
    _wait_until_running(SID)
    assert _cancel()[0] == 200  # it had the GPU: the scan belongs to that run

    status, _body = _discard()

    assert status == 409
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").exists()


def test_an_earlier_run_of_the_session_does_not_make_a_later_cancelled_one_look_as_if_it_ran(
    run, monkeypatch, tmp_path
):
    finalized = _finalized_upload(tmp_path, monkeypatch)
    assert _start(run)[1] == 200
    run["release"].set()
    _wait_until_ended(SID)
    assert api_routes.inference_jobs[SID]["started_at"]  # the first run got the GPU
    answers = _cancel_when_the_run_is_about_to_be_metered(run, monkeypatch)

    response, status = _start(run)

    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert answers
    assert _discard() == (200, {"status": "discarded"})
    assert not finalized.exists()


def test_a_discard_is_answered_as_before_once_no_request_holds_the_session(run, monkeypatch, tmp_path):
    finalized = _finalized_upload(tmp_path, monkeypatch)

    status, body = _discard()

    assert (status, body["status"]) == (200, "discarded")
    assert not finalized.exists()
