"""Unit tests for the display name and the account-deletion lifecycle.

Covers the grace period end to end: requesting deletion makes the account
unusable immediately, signing back in inside the window restores it, and past
the window the account is refused even before the purge has physically removed
it. Also covers deleting scan history, including the rule that files outside the
sessions root (the shared PanTS dataset) are never touched.
"""

import importlib
import json
import os
from datetime import timedelta

import pytest


@pytest.fixture()
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'del.db'}")
    monkeypatch.setenv("SESSIONS_DIR_PATH", str(tmp_path / "sessions"))
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.job  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.job_store as job_store
    importlib.reload(job_store)
    # Runs from the Upload page live outside the sessions root; keep them in
    # the test's own folder too.
    monkeypatch.setattr(job_store, "RUNS_DIR", str(tmp_path / "runs"))

    engine.reset_engine_for_tests()
    engine.create_all()
    yield auth_store, job_store, tmp_path
    engine.reset_engine_for_tests()


def _age_deletion(auth_store, user_id, days):
    """Backdate a pending deletion so the grace period can be tested."""
    from models.engine import session_scope
    from models.job import utcnow
    from models.user import User
    with session_scope() as s:
        s.get(User, user_id).deletion_requested_at = utcnow() - timedelta(days=days)


# ---- display name ---------------------------------------------------------

def test_name_is_optional_and_updatable(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("a@b.com", "hunter2pass")
    assert user["name"] is None  # accounts without a name are valid

    updated = auth_store.update_name(user["id"], "  Ada   Lovelace ")
    assert updated["name"] == "Ada Lovelace"  # trimmed, whitespace collapsed


def test_name_can_be_set_at_registration(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("c@d.com", "hunter2pass", "Grace Hopper")
    assert user["name"] == "Grace Hopper"


def test_blank_name_clears_back_to_null(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("e@f.com", "hunter2pass", "Ada")
    assert auth_store.update_name(user["id"], "   ")["name"] is None


def test_overlong_name_is_truncated_not_rejected(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("g@h.com", "hunter2pass")
    updated = auth_store.update_name(user["id"], "x" * 500)
    assert len(updated["name"]) == auth_store.MAX_NAME_LEN


# ---- deletion lifecycle ---------------------------------------------------

def test_requesting_deletion_signs_out_everywhere(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("i@j.com", "hunter2pass")
    token_a = auth_store.create_session(user["id"])
    token_b = auth_store.create_session(user["id"])  # a second browser
    assert auth_store.resolve_session(token_a) is not None

    result = auth_store.request_deletion(user["id"])
    assert result["grace_days"] == auth_store.DELETION_GRACE_DAYS
    assert auth_store.resolve_session(token_a) is None
    assert auth_store.resolve_session(token_b) is None


def test_signing_in_during_grace_restores_the_account(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("k@l.com", "hunter2pass")
    auth_store.request_deletion(user["id"])

    back = auth_store.authenticate("k@l.com", "hunter2pass")
    assert back is not None and back["id"] == user["id"]

    # and the account is fully usable again
    token = auth_store.create_session(user["id"])
    assert auth_store.resolve_session(token) is not None
    assert auth_store.list_users_pending_purge() == []


def test_account_is_refused_once_grace_has_elapsed(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("m@n.com", "hunter2pass")
    auth_store.request_deletion(user["id"])
    _age_deletion(auth_store, user["id"], auth_store.DELETION_GRACE_DAYS + 1)

    # refused even though the row is still physically present
    assert auth_store.authenticate("m@n.com", "hunter2pass") is None
    assert auth_store.get_user(user["id"]) is not None


def test_purge_removes_only_accounts_past_the_grace_period(stores):
    auth_store, _, _ = stores
    keeper = auth_store.create_user("keep@x.com", "hunter2pass")
    recent = auth_store.create_user("recent@x.com", "hunter2pass")
    stale = auth_store.create_user("stale@x.com", "hunter2pass")

    auth_store.request_deletion(recent["id"])  # still inside the window
    auth_store.request_deletion(stale["id"])
    _age_deletion(auth_store, stale["id"], auth_store.DELETION_GRACE_DAYS + 1)

    assert auth_store.purge_expired_deletions() == 1
    assert auth_store.get_user(stale["id"]) is None
    assert auth_store.get_user(recent["id"]) is not None
    assert auth_store.get_user(keeper["id"]) is not None


def test_purge_removes_a_users_jobs_too(stores):
    """job.user_id is NOT NULL with no cascade, so the purge has to clear jobs
    itself or the delete raises."""
    auth_store, job_store, _ = stores
    user = auth_store.create_user("o@p.com", "hunter2pass")
    job_store.create_job("sess-1", "ePAI", None, None, None, user["id"])
    auth_store.request_deletion(user["id"])
    _age_deletion(auth_store, user["id"], auth_store.DELETION_GRACE_DAYS + 1)

    assert auth_store.purge_expired_deletions() == 1
    assert job_store.get_job("sess-1") is None


def test_deletion_is_idempotent(stores):
    auth_store, _, _ = stores
    user = auth_store.create_user("q@r.com", "hunter2pass")
    first = auth_store.request_deletion(user["id"])
    second = auth_store.request_deletion(user["id"])
    # the clock must not restart on a second click
    assert first["deletion_requested_at"] == second["deletion_requested_at"]


# ---- scan history ---------------------------------------------------------

def test_delete_history_removes_jobs_and_their_files(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("s@t.com", "hunter2pass")

    session_dir = tmp_path / "sessions" / "sess-a"
    session_dir.mkdir(parents=True)
    ct = session_dir / "ct.nii.gz"
    ct.write_text("scan")

    job_store.create_job("sess-a", "ePAI", str(ct), str(session_dir), None, user["id"])
    result = job_store.delete_jobs_for_user(user["id"])

    assert result["jobs"] == 1
    assert job_store.get_job("sess-a") is None
    assert not ct.exists()
    assert not session_dir.exists()


def test_delete_history_never_touches_the_shared_dataset(stores):
    """A job run against a dataset case has ct_path inside the read-only PanTS
    tree. Deleting history must not delete the dataset."""
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("u@v.com", "hunter2pass")

    dataset_ct = tmp_path / "pants_dataset" / "image_only" / "PanTS_00001" / "ct.nii.gz"
    dataset_ct.parent.mkdir(parents=True)
    dataset_ct.write_text("shared dataset scan")

    job_store.create_job("sess-b", "ePAI", str(dataset_ct), None, None, user["id"])
    result = job_store.delete_jobs_for_user(user["id"])

    assert result["jobs"] == 1          # the record is gone
    assert result["files"] == 0         # but nothing was deleted from disk
    assert dataset_ct.exists()


def test_delete_history_leaves_other_users_alone(stores):
    auth_store, job_store, _ = stores
    mine = auth_store.create_user("w@x.com", "hunter2pass")
    theirs = auth_store.create_user("y@z.com", "hunter2pass")
    job_store.create_job("mine-1", "ePAI", None, None, None, mine["id"])
    job_store.create_job("theirs-1", "ePAI", None, None, None, theirs["id"])

    job_store.delete_jobs_for_user(mine["id"])

    assert job_store.get_job("mine-1") is None
    assert job_store.get_job("theirs-1") is not None


def test_delete_history_survives_a_missing_directory(stores):
    """Files already gone must not stop the rows from being deleted."""
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("aa@bb.com", "hunter2pass")
    ghost = tmp_path / "sessions" / "not-there"
    job_store.create_job("sess-c", "ePAI", None, str(ghost), None, user["id"])

    result = job_store.delete_jobs_for_user(user["id"])
    assert result == {"jobs": 1, "files": 0}
    assert job_store.get_job("sess-c") is None


def test_delete_history_rejects_a_traversal_path(stores):
    """A stored path escaping the sessions root is skipped, not followed."""
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("cc@dd.com", "hunter2pass")

    outside = tmp_path / "outside.txt"
    outside.write_text("important")
    escaping = os.path.join(str(tmp_path / "sessions"), "..", "outside.txt")

    job_store.create_job("sess-d", "ePAI", escaping, None, None, user["id"])
    result = job_store.delete_jobs_for_user(user["id"])

    assert result["files"] == 0
    assert outside.exists()


# ---- runs from the Upload page ---------------------------------------------
# That path never writes the job table. A run names its owner in
# <RUNS_DIR>/<session>/job.json, a CT uploaded ahead of Run in
# <sessions>/inference/<session>/.owner.

def _upload_page_run(tmp_path, session_id, user_id, status="completed"):
    run = tmp_path / "runs" / session_id
    run.mkdir(parents=True)
    (run / "job.json").write_text(json.dumps({"user_id": user_id, "status": status}))
    (run / "auto_masks.zip").write_text("masks")
    upload = tmp_path / "sessions" / "inference" / session_id
    (upload / "BDMAP_00000001").mkdir(parents=True)
    (upload / ".owner").write_text(user_id)
    (upload / "BDMAP_00000001" / "ct.nii.gz").write_text("scan")
    return run, upload


def test_delete_history_removes_upload_page_runs(stores):
    auth_store, job_store, tmp_path = stores
    mine = auth_store.create_user("ee@ff.com", "hunter2pass")
    theirs = auth_store.create_user("gg@hh.com", "hunter2pass")
    run, upload = _upload_page_run(tmp_path, "sess-mine", mine["id"])
    their_run, their_upload = _upload_page_run(tmp_path, "sess-theirs", theirs["id"])
    # a CT uploaded ahead of Run and never run: only the .owner record exists
    pre = tmp_path / "sessions" / "inference" / "sess-pre"
    pre.mkdir(parents=True)
    (pre / ".owner").write_text(mine["id"])

    assert job_store.delete_run_folders_for_user(mine["id"]) == ["sess-mine", "sess-pre"]
    assert not run.exists() and not upload.exists() and not pre.exists()
    assert their_run.exists() and their_upload.exists()


def test_delete_history_leaves_a_run_still_in_progress(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("ii@jj.com", "hunter2pass")
    run, upload = _upload_page_run(tmp_path, "sess-live", user["id"], status="running")

    removed = job_store.delete_run_folders_for_user(user["id"], is_active=lambda sid: sid == "sess-live")

    assert removed == []
    assert run.exists() and upload.exists()


def test_delete_history_skips_folders_with_no_owner_record(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("kk@ll.com", "hunter2pass")
    legacy = tmp_path / "runs" / "sess-legacy"
    legacy.mkdir(parents=True)
    (legacy / "job.json").write_text(json.dumps({"status": "completed"}))
    (tmp_path / "runs" / "job_durations.jsonl").parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / "runs" / "job_durations.jsonl").write_text("{}\n")

    assert job_store.delete_run_folders_for_user(user["id"]) == []
    assert legacy.exists()
    assert (tmp_path / "runs" / "job_durations.jsonl").exists()


# ---- listing a user's Upload page runs --------------------------------------

def _write_run(tmp_path, session_id, **record):
    run = tmp_path / "runs" / session_id
    run.mkdir(parents=True, exist_ok=True)
    (run / "job.json").write_text(json.dumps(record))
    return run / "job.json"


def test_list_runs_returns_only_the_owners_newest_first(stores):
    _, job_store, tmp_path = stores
    _write_run(tmp_path, "old", user_id="me", status="completed", model="ePAI", created_at=1_700_000_000)
    _write_run(tmp_path, "new", user_id="me", status="failed", model="LesionSegmenter", created_at=1_700_000_500)
    _write_run(tmp_path, "theirs", user_id="someone-else", status="completed", model="ePAI", created_at=1_700_000_900)
    _write_run(tmp_path, "unowned", status="completed", model="ePAI", created_at=1_700_000_900)

    runs = job_store.list_run_records_for_user("me")

    assert [r["session_id"] for r in runs] == ["new", "old"]
    assert runs[0] == {
        "session_id": "new",
        "model": "LesionSegmenter",
        "status": "failed",
        "created_at": "2023-11-14T22:21:40+00:00",
    }


def test_list_runs_sends_no_paths_or_internal_fields(stores):
    _, job_store, tmp_path = stores
    _write_run(
        tmp_path, "s1", user_id="me", status="completed", model="ePAI", created_at=1_700_000_000,
        ct_path="/srv/sessions/s1/ct.nii.gz", session_path="/srv/sessions/s1", zip_path="/srv/z.zip",
        output_mask_dir="/srv/out", error=None,
    )

    (run,) = job_store.list_run_records_for_user("me")

    assert set(run) == {"session_id", "model", "status", "created_at"}
    assert "/srv" not in json.dumps(run)


def test_list_runs_falls_back_to_the_file_time_for_runs_with_no_start_time(stores):
    _, job_store, tmp_path = stores
    record = _write_run(tmp_path, "early", user_id="me", status="completed", model="ePAI")
    os.utime(record, (1_700_000_000, 1_700_000_000))

    (run,) = job_store.list_run_records_for_user("me")

    assert run["created_at"] == "2023-11-14T22:13:20+00:00"


def test_list_runs_reads_a_run_its_process_left_running_as_failed(stores):
    _, job_store, tmp_path = stores
    _write_run(tmp_path, "dead", user_id="me", status="running", model="ePAI", created_at=1_700_000_000)
    _write_run(tmp_path, "waiting", user_id="me", status="queued", model="ePAI", created_at=1_700_000_100)
    _write_run(tmp_path, "live", user_id="me", status="running", model="ePAI", created_at=1_700_000_200)

    runs = job_store.list_run_records_for_user(
        "me", live_job=lambda sid: {"status": "completed"} if sid == "live" else None,
    )

    assert {r["session_id"]: r["status"] for r in runs} == {
        "dead": "failed", "waiting": "failed", "live": "completed",
    }


def test_list_runs_is_capped_and_skips_what_is_not_a_run(stores):
    _, job_store, tmp_path = stores
    for i in range(job_store.RUN_LIST_LIMIT + 5):
        _write_run(tmp_path, f"s{i:03d}", user_id="me", status="completed", model="ePAI", created_at=1_700_000_000 + i)
    (tmp_path / "runs" / "job_durations.jsonl").write_text("{}\n")
    (tmp_path / "runs" / "empty").mkdir()
    (tmp_path / "runs" / "broken").mkdir()
    (tmp_path / "runs" / "broken" / "job.json").write_text("{not json")
    _write_run(tmp_path, "odd-status", user_id="me", status="paused", model="ePAI", created_at=1_800_000_000)

    runs = job_store.list_run_records_for_user("me")

    assert len(runs) == job_store.RUN_LIST_LIMIT
    assert runs[0]["session_id"] == f"s{job_store.RUN_LIST_LIMIT + 4:03d}"
    assert job_store.list_run_records_for_user("me", runs_root=str(tmp_path / "nowhere")) == []


# ---- which sessions are the user's, exactly ----------------------------------
# GET /me/runs is capped and reads only the newest run folders, so it cannot say
# whether an older session id in a browser is the account's. The ownership check
# answers for the ids asked about, by the records deleting history goes by.

def test_owned_sessions_are_named_by_the_same_records_delete_goes_by(stores):
    auth_store, job_store, tmp_path = stores
    mine = auth_store.create_user("oo@pp.com", "hunter2pass")
    _upload_page_run(tmp_path, "run-mine", mine["id"])
    _upload_page_run(tmp_path, "run-theirs", "someone-else")
    pre = tmp_path / "sessions" / "inference" / "pre-mine"  # uploaded ahead of Run, never run
    pre.mkdir(parents=True)
    (pre / ".owner").write_text(mine["id"])
    _write_run(tmp_path, "run-unowned", status="completed")

    ids = ["run-mine", "run-theirs", "pre-mine", "run-unowned", "never-heard-of"]
    owned = job_store.owned_run_sessions(mine["id"], ids)

    assert owned == ["run-mine", "pre-mine"]
    # Exactly what deleting the account's history removes.
    assert job_store.delete_run_folders_for_user(mine["id"]) == sorted(owned)


def test_owned_sessions_reach_past_the_listing_cap(stores):
    auth_store, job_store, tmp_path = stores
    mine = auth_store.create_user("qq@rr.com", "hunter2pass")
    for i in range(60):
        _write_run(tmp_path, f"s{i:02d}", user_id=mine["id"], status="completed", model="ePAI",
                   created_at=1_700_000_000 + i)
    listed = {r["session_id"] for r in job_store.list_run_records_for_user(mine["id"])}
    oldest = [f"s{i:02d}" for i in range(10)]
    assert not listed & set(oldest)  # the listing never says these are the account's

    assert job_store.owned_run_sessions(mine["id"], oldest) == oldest


def test_a_run_this_process_is_working_on_counts_as_owned(stores):
    _, job_store, _tmp_path = stores

    owned = job_store.owned_run_sessions(
        "me", ["live", "live-theirs"],
        live_job=lambda sid: {"user_id": "me" if sid == "live" else "other", "status": "running"},
    )

    assert owned == ["live"]


def test_ownership_lookups_only_take_plain_ids_and_never_leave_the_folder(stores):
    auth_store, job_store, tmp_path = stores
    mine = auth_store.create_user("ss@tt.com", "hunter2pass")
    _upload_page_run(tmp_path, "fine", mine["id"])
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "job.json").write_text(json.dumps({"user_id": mine["id"]}))

    hostile = ["../outside", "..", ".", "a/b", "", None, 7, "fine", "fine", "x" * 200]
    assert job_store.owned_run_sessions(mine["id"], hostile) == ["fine"]


def test_ownership_lookups_are_bounded(stores):
    auth_store, job_store, tmp_path = stores
    mine = auth_store.create_user("uu@vv.com", "hunter2pass")
    limit = job_store.OWNED_CHECK_LIMIT
    for i in range(limit + 5):
        _write_run(tmp_path, f"b{i}", user_id=mine["id"], status="completed")

    owned = job_store.owned_run_sessions(mine["id"], [f"b{i}" for i in range(limit + 5)])

    assert len(owned) == limit


def test_purge_removes_upload_page_runs_too(stores):
    auth_store, job_store, tmp_path = stores
    user = auth_store.create_user("mm@nn.com", "hunter2pass")
    run, upload = _upload_page_run(tmp_path, "sess-gone", user["id"])
    auth_store.request_deletion(user["id"])
    _age_deletion(auth_store, user["id"], auth_store.DELETION_GRACE_DAYS + 1)

    assert auth_store.purge_expired_deletions() == 1
    assert not run.exists() and not upload.exists()
