"""A Cancel that reaches a run request before its job exists.

The Upload page aborts its run request when the user cancels, but the server
goes on copying and checking the CT for seconds before it makes the job, so the
cancel that follows finds no job (404) and used to be forgotten: the job was
made afterwards, spent a scan and ran under a card marked Cancelled.
"""

from __future__ import annotations

import time

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as api_routes


@pytest.fixture
def run(tmp_path, monkeypatch):
    """A signed-in account that can start a run, and what the run touches."""
    runs = tmp_path / "runs"
    account = {"id": "owner"}
    seen = {"recorded": [], "ran": [], "account": account, "runs": runs}
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    monkeypatch.setattr(api_routes, "current_user", lambda: account)
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)
    monkeypatch.setattr(api_routes.plan_store, "check_inference", lambda *_args: None)
    monkeypatch.setattr(
        api_routes.plan_store, "record_inference", lambda *args: seen["recorded"].append(args),
    )
    monkeypatch.setattr(api_routes.plan_store, "finish_inference", lambda *_args: None)
    monkeypatch.setattr(api_routes, "cancel_session", lambda _sid: False)
    monkeypatch.setattr(api_routes, "_early_cancels", {}, raising=False)
    monkeypatch.setattr(
        api_routes, "run_auto_segmentation",
        lambda *args, **kwargs: seen["ran"].append(args) or None,
    )
    ct = tmp_path / "ct.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.int16), np.eye(4)), str(ct))
    seen["ct"] = str(ct)
    yield seen
    api_routes.inference_jobs.pop("early", None)


def _start(run, received_at=None):
    with Flask(__name__).test_request_context(method="POST"):
        return api_routes._start_auto_segmentation(
            "early", "ePAI", server_input_path=run["ct"], received_at=received_at,
        )


def _cancel():
    with Flask(__name__).test_request_context(method="POST"):
        return api_routes.cancel_inference_session.__wrapped__("early")


def _cancel_when(monkeypatch, target, name):
    """Send the Cancel just before the run request reaches `target.name`."""
    real = getattr(target, name)
    sent = []

    def cancel_first(*args, **kwargs):
        if not sent:
            sent.append(_cancel())
        return real(*args, **kwargs)

    monkeypatch.setattr(target, name, cancel_first)
    return sent


def test_a_run_cancelled_while_its_request_is_still_copying_the_ct_never_gets_a_job(run, monkeypatch):
    sent = _cancel_when(monkeypatch, api_routes.nib, "load")

    response, status = _start(run)

    # The Cancel found no job to stop; the request that made none of it stops.
    assert sent[0][1] == 404
    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert api_routes.inference_jobs.get("early") is None
    assert not (run["runs"] / "early" / "job.json").exists()
    assert not (run["runs"] / "early" / "ct.nii.gz").exists()
    assert run["recorded"] == []  # no scan was spent
    assert run["ran"] == []


def test_a_cancel_between_the_last_check_and_the_job_stops_the_job_it_makes(run, monkeypatch):
    slots = api_routes._INFERENCE_PENDING_SLOTS._value
    sent = _cancel_when(monkeypatch, api_routes.plan_store, "record_inference")

    response, status = _start(run)

    assert sent[0][1] == 404
    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert api_routes.inference_jobs["early"]["status"] == "cancelled"
    assert run["ran"] == []  # no worker was started
    assert api_routes._INFERENCE_PENDING_SLOTS._value == slots


def test_a_cancel_that_looked_for_the_job_just_before_it_was_made_still_stops_it(run, monkeypatch):
    # The Cancel finds no job, and the run request makes the job and passes both
    # its checks before the Cancel has done anything else: it must already have
    # been noted, or nothing would ever stop the job.
    request_began = time.time()
    real = api_routes._job_for_current_user
    started = []

    def looks_then_the_run_goes_ahead(session_id):
        result = real(session_id)
        started.append(_start(run, received_at=request_began))
        return result

    monkeypatch.setattr(api_routes, "_job_for_current_user", looks_then_the_run_goes_ahead)

    assert _cancel()[1] == 404

    response, status = started[0]
    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert run["ran"] == []


def test_a_cancel_that_finds_the_job_stops_it_as_before(run, monkeypatch):
    response, status = _start(run)
    assert status == 200, response.get_json()

    _body, cancel_status = _cancel()

    assert cancel_status == 200
    assert api_routes.inference_jobs["early"]["status"] in ("cancelled", "failed")


def test_a_run_started_again_under_the_same_session_after_a_cancel_is_not_stopped(run):
    assert _cancel()[1] == 404

    time.sleep(0.01)
    response, status = _start(run)

    assert status == 200, response.get_json()


def test_another_accounts_cancel_does_not_stop_a_run(run, monkeypatch):
    def cancel_as_another_account(*args, **kwargs):
        run["account"]["id"] = "other"
        try:
            _cancel()
        finally:
            run["account"]["id"] = "owner"
        return real(*args, **kwargs)

    real = api_routes.nib.load
    monkeypatch.setattr(api_routes.nib, "load", cancel_as_another_account)

    response, status = _start(run)

    assert status == 200, response.get_json()


def test_remembered_cancels_are_dropped_after_an_hour(run):
    api_routes._note_cancel("old", "owner")
    api_routes._early_cancels[("old", "owner")] = time.time() - api_routes._EARLY_CANCEL_TTL_SECONDS - 1

    api_routes._note_cancel("new", "owner")

    assert list(api_routes._early_cancels) == [("new", "owner")]


def _cancel_as(run, account_id):
    previous = run["account"]["id"]
    run["account"]["id"] = account_id
    try:
        return _cancel()
    finally:
        run["account"]["id"] = previous


def test_another_accounts_cancel_does_not_replace_the_owners_remembered_cancel(run, monkeypatch):
    # The owner cancels while the request is copying, then an account that
    # holds the same session id cancels too (refused, but noted before the
    # access check). The owner's cancel must still stop the run.
    real = api_routes.nib.load
    sent = []

    def both_cancel(*args, **kwargs):
        if not sent:
            sent.append(_cancel())                # the owner
            sent.append(_cancel_as(run, "other"))  # the other account
        return real(*args, **kwargs)

    monkeypatch.setattr(api_routes.nib, "load", both_cancel)

    response, status = _start(run)

    assert [code for _body, code in sent] == [404, 404]
    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert api_routes.inference_jobs.get("early") is None
    assert run["recorded"] == []
    assert run["ran"] == []


def test_the_owners_cancel_survives_another_account_cancelling_after_the_job_check(run, monkeypatch):
    # Same, in the window between the run request's two looks.
    sent = []
    real = api_routes.plan_store.record_inference

    def both_cancel(*args, **kwargs):
        if not sent:
            sent.append(_cancel())
            sent.append(_cancel_as(run, "other"))
        return real(*args, **kwargs)

    monkeypatch.setattr(api_routes.plan_store, "record_inference", both_cancel)

    response, status = _start(run)

    assert (status, response.get_json()["code"]) == (409, "cancelled")
    assert api_routes.inference_jobs["early"]["status"] == "cancelled"
    assert run["ran"] == []


def test_one_account_cannot_fill_or_push_out_the_remembered_cancels(run):
    api_routes._note_cancel("victim-run", "victim")
    limit = api_routes._EARLY_CANCEL_MAX_PER_ACCOUNT

    for n in range(limit + 50):
        api_routes._note_cancel(f"junk-{n}", "attacker")

    mine = [key for key in api_routes._early_cancels if key[1] == "attacker"]
    assert len(mine) == limit
    # The attacker lost its own oldest, nobody else's.
    assert ("junk-0", "attacker") not in api_routes._early_cancels
    assert ("junk-{}".format(limit + 49), "attacker") in api_routes._early_cancels
    assert ("victim-run", "victim") in api_routes._early_cancels


def test_the_remembered_cancels_have_an_overall_bound(run, monkeypatch):
    monkeypatch.setattr(api_routes, "_EARLY_CANCEL_MAX_TOTAL", 10)

    for n in range(25):
        api_routes._note_cancel(f"s-{n}", f"user-{n}")

    assert len(api_routes._early_cancels) == 10
    assert ("s-24", "user-24") in api_routes._early_cancels
    assert ("s-0", "user-0") not in api_routes._early_cancels
