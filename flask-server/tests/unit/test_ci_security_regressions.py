from __future__ import annotations

import io
import json
import os
import shutil
import threading
import time
from pathlib import Path

import pytest
from flask import Flask

import api.api_blueprint as api_routes
import api.auth as auth_routes
from api import chunk_store
from api.api_blueprint import api_blueprint
from constants import Constants
from services.inference_job_queue import InferenceJobQueue, QueueFullError


def _client():
    app = Flask(__name__)
    app.register_blueprint(api_blueprint, url_prefix="/api")
    return app.test_client()


def test_image_proxy_rejects_confusing_hostnames_without_requesting_them(monkeypatch):
    def fail_request(*_args, **_kwargs):
        raise AssertionError("untrusted URL reached requests.get")

    monkeypatch.setattr(api_routes.requests, "get", fail_request)

    response = _client().get(
        "/api/proxy-image",
        query_string={"url": "https://huggingface.co.evil.example/image.png"},
    )

    assert response.status_code == 403


def test_image_proxy_disables_redirects_and_rebuilds_trusted_origin(monkeypatch):
    recorded = {}

    class FakeResponse:
        ok = True
        status_code = 200
        content = b"image"
        headers = {"Content-Type": "image/png"}

    def fake_get(url, **kwargs):
        recorded["url"] = url
        recorded.update(kwargs)
        return FakeResponse()

    monkeypatch.setattr(api_routes.requests, "get", fake_get)

    response = _client().get(
        "/api/proxy-image",
        query_string={"url": "https://huggingface.co/org/repo/image.png?download=1"},
    )

    assert response.status_code == 200
    assert recorded["url"] == "https://huggingface.co/org/repo/image.png?download=1"
    assert recorded["allow_redirects"] is False
    assert recorded["timeout"] == 10


class _Reply:
    def __init__(self, status_code, headers=None, content=b""):
        self.status_code = status_code
        self.ok = status_code < 400
        self.headers = headers or {}
        self.content = content


def _replay(monkeypatch, replies):
    requested = []

    def fake_get(url, **kwargs):
        assert kwargs["allow_redirects"] is False
        requested.append(url)
        return replies[len(requested) - 1]

    monkeypatch.setattr(api_routes.requests, "get", fake_get)
    return requested


def test_image_proxy_follows_the_hugging_face_cdn_redirect(monkeypatch):
    # resolve/ files answer with a 302 to Hugging Face's CDN; passing that
    # redirect notice on as the image broke every dataset thumbnail.
    cdn = "https://us.aws.cdn.hf.co/xet-bridge-us/abc?X-Xet-Cas-Uid=public"
    requested = _replay(monkeypatch, [
        _Reply(302, {"Location": cdn, "Content-Type": "text/plain"}, b"Found. Redirecting"),
        _Reply(200, {"Content-Type": "image/jpeg"}, b"jpeg-bytes"),
    ])

    response = _client().get(
        "/api/proxy-image",
        query_string={"url": "https://huggingface.co/datasets/org/repo/resolve/main/profile.jpg"},
    )

    assert response.status_code == 200
    assert response.data == b"jpeg-bytes"
    assert response.mimetype == "image/jpeg"
    assert requested[1] == cdn


def test_image_proxy_never_follows_a_redirect_off_hugging_face(monkeypatch):
    for location in ("http://us.aws.cdn.hf.co/x.jpg", "https://169.254.169.254/latest",
                     "https://hf.co.evil.example/x.jpg", "https://user@cdn.hf.co/x.jpg"):
        requested = _replay(monkeypatch, [_Reply(302, {"Location": location})])

        response = _client().get(
            "/api/proxy-image", query_string={"url": "https://huggingface.co/org/repo/x.jpg"})

        assert response.status_code == 502, location
        assert len(requested) == 1, location


def test_image_proxy_gives_up_after_a_few_redirects(monkeypatch):
    hop = {"Location": "https://cdn.hf.co/again.jpg"}
    requested = _replay(monkeypatch, [_Reply(302, hop)] * 10)

    response = _client().get(
        "/api/proxy-image", query_string={"url": "https://huggingface.co/org/repo/x.jpg"})

    assert response.status_code == 502
    assert len(requested) == 4


def test_image_proxy_refuses_a_reply_that_is_not_an_image(monkeypatch):
    _replay(monkeypatch, [_Reply(200, {"Content-Type": "text/html"}, b"<html>")])

    response = _client().get(
        "/api/proxy-image", query_string={"url": "https://huggingface.co/org/repo/x.jpg"})

    assert response.status_code == 502


def test_mesh_filename_validation_is_bounded_before_regex_work():
    response = _client().get(
        "/api/cases/PanTS_00000035/render_only/" + ("a" * 10000) + ".glb"
    )

    assert response.status_code in {400, 414}


def test_uploaded_file_lookup_never_joins_request_path_segments(tmp_path, monkeypatch):
    sessions_root = tmp_path / "sessions"
    ct_path = sessions_root / "inference" / "safe-session" / "BDMAP_00000001" / "ct.nii.gz"
    ct_path.parent.mkdir(parents=True)
    ct_path.write_bytes(b"scan")
    monkeypatch.setattr(Constants, "SESSIONS_DIR_NAME", str(sessions_root))

    assert api_routes._uploaded_file_candidate(
        "safe-session", "BDMAP_00000001/ct.nii.gz"
    ) == str(ct_path)
    assert api_routes._uploaded_file_candidate("../safe-session", "ct.nii.gz") is None
    assert api_routes._uploaded_file_candidate("safe-session", "../ct.nii.gz") is None
    assert api_routes._uploaded_file_candidate("safe-session", str(ct_path)) is None


def test_inference_queue_copies_stream_to_server_minted_path(tmp_path: Path):
    queue = InferenceJobQueue(str(tmp_path / "queue"))

    job = queue.create_job(io.BytesIO(b"scan"), "../../patient.nii.gz", session_id="session")

    input_path = os.path.realpath(job["input_file_path"])
    inputs_root = os.path.realpath(queue.inputs_dir)
    assert os.path.commonpath([inputs_root, input_path]) == inputs_root
    assert input_path.endswith(".nii.gz")
    assert Path(input_path).read_bytes() == b"scan"
    assert queue.get_job("../not-a-job") is None


def test_full_inference_queue_refuses_before_writing_the_input(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("INFERENCE_QUEUE_MAX_PENDING", "1")
    queue = InferenceJobQueue(str(tmp_path / "queue"))
    queue.create_job(io.BytesIO(b"scan"), "ct.nii.gz", session_id="first")

    class UnreadableStream:
        def read(self, *_args):
            raise AssertionError("input was copied into a full queue")

    with pytest.raises(QueueFullError):
        queue.create_job(UnreadableStream(), "ct.nii.gz", session_id="second")
    assert len(os.listdir(queue.inputs_dir)) == 1


def test_private_inference_routes_reject_guests_before_touching_jobs(monkeypatch):
    app = Flask(__name__)
    monkeypatch.setattr(auth_routes, "current_user", lambda: None)
    monkeypatch.setattr(
        api_routes, "_get_inference_job",
        lambda _session_id: (_ for _ in ()).throw(AssertionError("job lookup ran")),
    )

    with app.test_request_context():
        assert api_routes.get_inference_status("private-session")[1] == 401
        assert api_routes.cancel_inference_session("private-session")[1] == 401
        assert api_routes.discard_upload("private-session")[1] == 401
        assert api_routes.cancel_inference()[1] == 401


def test_job_access_requires_owner_or_admin(monkeypatch):
    app = Flask(__name__)
    monkeypatch.setattr(api_routes, "_get_inference_job", lambda _sid: {"user_id": "owner"})
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "other"})
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)

    with app.test_request_context():
        _job, error = api_routes._job_for_current_user("session")
        assert error[1] == 403

        monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
        job, error = api_routes._job_for_current_user("session")
        assert error is None
        assert job["user_id"] == "owner"


def test_inference_status_does_not_expose_owner_or_server_paths(monkeypatch):
    app = Flask(__name__)
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes, "_get_inference_job", lambda _sid: {
        "user_id": "owner",
        "status": "running",
        "model": "ePAI",
        "ct_path": "/private/patient.nii.gz",
        "session_path": "/private/session",
    })

    with app.test_request_context():
        response, status = api_routes.get_inference_status.__wrapped__("session")

    assert status == 200
    assert response.get_json() == {
        "session_id": "session", "status": "running", "model": "ePAI",
    }


def test_upload_staging_cannot_be_claimed_by_another_user(tmp_path, monkeypatch):
    app = Flask(__name__)
    monkeypatch.setattr(api_routes, "CHUNK_DIR", str(tmp_path))
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)

    with app.test_request_context():
        monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
        folder, error = api_routes._staging_for_current_user("session", create=True)
        assert error is None
        assert Path(folder, ".owner").read_text() == "owner"

        monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "other"})
        _folder, error = api_routes._staging_for_current_user("session", create=False)
        assert error[1] == 403


def test_upload_status_reports_first_gap_from_server(tmp_path, monkeypatch):
    app = Flask(__name__)
    monkeypatch.setattr(api_routes, "CHUNK_DIR", str(tmp_path))
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes, "_maybe_sweep_uploads", lambda: None)
    staging = tmp_path / "session"
    staging.mkdir()
    (staging / ".owner").write_text("owner")
    (staging / "chunk-0").write_bytes(b"0")
    (staging / "chunk-2").write_bytes(b"2")

    with app.test_request_context():
        response, status = api_routes.upload_status.__wrapped__("session")

    assert status == 200
    assert response.get_json() == {
        "session_id": "session", "next_chunk": 1, "received_chunks": 2,
    }


def test_finalize_upload_is_atomic_and_removes_staging(tmp_path, monkeypatch):
    app = Flask(__name__)
    chunks_root = tmp_path / "chunks"
    sessions_root = tmp_path / "sessions"
    chunks_root.mkdir()
    monkeypatch.setattr(api_routes, "CHUNK_DIR", str(chunks_root))
    monkeypatch.setattr(Constants, "SESSIONS_DIR_NAME", str(sessions_root))
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)
    monkeypatch.setattr(api_routes, "_maybe_sweep_uploads", lambda: None)

    staging = chunks_root / "session"
    staging.mkdir()
    (staging / ".owner").write_text("owner")
    (staging / ".total_chunks").write_text("2")
    (staging / "chunk-0").write_bytes(b"first")
    (staging / "chunk-1").write_bytes(b"second")

    with app.test_request_context(
        method="POST",
        data={"session_id": "session", "total_chunks": "2", "output_filename": "scan.nii.gz"},
    ):
        response = api_routes.finalize_upload.__wrapped__()

    assert response.get_json()["status"] == "combined"
    destination = sessions_root / "inference" / "session" / response.get_json()["uploaded_filename"]
    assert destination.read_bytes() == b"firstsecond"
    assert not staging.exists()
    assert not list(destination.parent.glob("*.partial-*"))


def _pre_upload(tmp_path, monkeypatch, owner="owner"):
    """A finished pre-upload plus a leftover staging folder, both owned."""
    chunks_root = tmp_path / "chunks"
    sessions_root = tmp_path / "sessions"
    monkeypatch.setattr(api_routes, "CHUNK_DIR", str(chunks_root))
    monkeypatch.setattr(Constants, "SESSIONS_DIR_NAME", str(sessions_root))
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)
    monkeypatch.setattr(api_routes, "_get_inference_job", lambda _sid: None)
    staging = chunks_root / "session"
    staging.mkdir(parents=True)
    (staging / ".owner").write_text(owner)
    (staging / "chunk-0").write_bytes(b"0")
    finalized = sessions_root / "inference" / "session"
    (finalized / "BDMAP_00000001").mkdir(parents=True)
    (finalized / ".owner").write_text(owner)
    (finalized / "BDMAP_00000001" / "ct.nii.gz").write_bytes(b"ct")
    return staging, finalized


def test_discard_upload_deletes_the_owners_pre_upload(tmp_path, monkeypatch):
    staging, finalized = _pre_upload(tmp_path, monkeypatch)
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})

    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.discard_upload.__wrapped__("session")

    assert status == 200
    assert response.get_json() == {"status": "discarded"}
    assert not staging.exists()
    assert not finalized.exists()


def test_discard_upload_refuses_another_users_upload(tmp_path, monkeypatch):
    staging, finalized = _pre_upload(tmp_path, monkeypatch)
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "other"})

    with Flask(__name__).test_request_context(method="POST"):
        _response, status = api_routes.discard_upload.__wrapped__("session")

    assert status == 403
    assert staging.exists()
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").exists()


def test_discard_upload_leaves_a_scan_that_was_run(tmp_path, monkeypatch):
    staging, finalized = _pre_upload(tmp_path, monkeypatch)
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes, "_get_inference_job", lambda _sid: {"user_id": "owner"})

    with Flask(__name__).test_request_context(method="POST"):
        _response, status = api_routes.discard_upload.__wrapped__("session")

    assert status == 409
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").exists()


def _finalizing_upload(tmp_path, monkeypatch):
    """A finished set of chunks, staged for the signed-in owner, ready to finalize."""
    chunks_root = tmp_path / "chunks"
    sessions_root = tmp_path / "sessions"
    chunks_root.mkdir()
    monkeypatch.setattr(api_routes, "CHUNK_DIR", str(chunks_root))
    monkeypatch.setattr(Constants, "SESSIONS_DIR_NAME", str(sessions_root))
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)
    monkeypatch.setattr(api_routes, "_maybe_sweep_uploads", lambda: None)
    monkeypatch.setattr(api_routes, "_get_inference_job", lambda _sid: None)
    staging = chunks_root / "session"
    staging.mkdir()
    (staging / ".owner").write_text("owner")
    (staging / ".total_chunks").write_text("2")
    (staging / "chunk-0").write_bytes(b"first")
    (staging / "chunk-1").write_bytes(b"second")
    return staging, sessions_root / "inference" / "session"


def _finalize_with_discard_at(monkeypatch, step):
    """Run finalize-upload, sending the discard request just before `step` runs."""
    app = Flask(__name__)
    real = getattr(api_routes, step)
    discards = []

    def discard_first(*args, **kwargs):
        if not discards:  # discard_upload cleans up with some of the same helpers
            discards.append(None)
            with app.test_request_context(method="POST"):
                discards[0] = api_routes.discard_upload.__wrapped__("session")
        return real(*args, **kwargs)

    monkeypatch.setattr(api_routes, step, discard_first)
    with app.test_request_context(
        method="POST",
        data={"session_id": "session", "total_chunks": "2", "output_filename": "scan.nii.gz"},
    ):
        response = api_routes.finalize_upload.__wrapped__()
    status = response[1] if isinstance(response, tuple) else response.status_code
    return status, discards


def test_discard_during_finalize_leaves_no_assembled_file_behind(tmp_path, monkeypatch):
    # The page aborts its finalize request when the user leaves, but the server
    # keeps assembling. The discard that follows arrives before the owner marker
    # exists, so it cannot find the file to delete; finalize has to honour it.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)

    finalize_status, discards = _finalize_with_discard_at(monkeypatch, "_write_owner_marker")

    (_body, discard_status), = discards
    assert discard_status == 200
    assert finalize_status == 409
    assert not finalized.exists()
    assert not staging.exists()


def test_discard_once_the_file_is_published_is_honoured_when_finalize_cleans_up(tmp_path, monkeypatch):
    # The file is in place, owner marker and all, and finalize has yet to remove
    # its staging folder: the discard still finds the lock, and it is finalize's
    # closing check of the note that removes the file.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)

    finalize_status, discards = _finalize_with_discard_at(monkeypatch, "_remove_staging_session")

    assert discards[0][0].get_json() == {"status": "discarding"}
    assert finalize_status == 409
    assert not finalized.exists()
    assert not staging.exists()


def test_discard_that_sees_the_finalize_finish_meanwhile_deletes_the_file_itself(tmp_path, monkeypatch):
    # The lock is there when discard looks, and gone when it looks again: the
    # finalize published its file and removed its staging folder in between, so
    # nobody is left to act on the note and discard has to.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    (staging / ".finalizing").write_text("")
    real = api_routes._mark_discarded

    def finalize_finishes(session_id):
        real(session_id)
        (finalized / "BDMAP_00000000").mkdir(parents=True)
        (finalized / "BDMAP_00000000" / "ct.nii.gz").write_bytes(b"ct")
        (finalized / ".owner").write_text("owner")
        shutil.rmtree(staging)

    monkeypatch.setattr(api_routes, "_mark_discarded", finalize_finishes)

    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.discard_upload.__wrapped__("session")

    assert (status, response.get_json()) == (200, {"status": "discarded"})
    assert not finalized.exists()


def test_discard_during_a_finalize_that_fails_still_removes_the_chunks(tmp_path, monkeypatch):
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    app = Flask(__name__)
    discards = []

    def fail_after_discard(*_args, **_kwargs):
        with app.test_request_context(method="POST"):
            discards.append(api_routes.discard_upload.__wrapped__("session"))
        raise OSError("No space left on device")

    monkeypatch.setattr(api_routes.shutil, "copyfileobj", fail_after_discard)
    with app.test_request_context(
        method="POST",
        data={"session_id": "session", "total_chunks": "2", "output_filename": "scan.nii.gz"},
    ):
        _body, status = api_routes.finalize_upload.__wrapped__()

    assert status == 500
    assert discards[0][1] == 200
    assert not staging.exists()
    assert not finalized.exists()


def test_discard_without_a_finalize_running_leaves_no_note_behind(tmp_path, monkeypatch):
    # Only chunks are staged, so nothing else would ever create the finalized
    # folder: a note written anyway would be all that is left of the session.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)

    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.discard_upload.__wrapped__("session")

    assert (status, response.get_json()) == (200, {"status": "discarded"})
    assert not staging.exists()
    assert not finalized.exists()


def test_a_refused_second_finalize_leaves_the_running_ones_lock_alone(tmp_path, monkeypatch):
    # A retry, or a second tab, is refused while the first finalize is still
    # assembling. Its cleanup must not take the first one's lock with it: a
    # discard looks for that lock, and would find nothing to wait for.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    app = Flask(__name__)
    seen = {}
    real = api_routes._write_owner_marker
    form = {"session_id": "session", "total_chunks": "2", "output_filename": "scan.nii.gz"}

    def second_finalize_then_discard(*args):
        with app.test_request_context(method="POST", data=form):
            _body, seen["second"] = api_routes.finalize_upload.__wrapped__()
        seen["lock_kept"] = (staging / ".finalizing").exists()
        with app.test_request_context(method="POST"):
            response, _status = api_routes.discard_upload.__wrapped__("session")
        seen["discard"] = response.get_json()
        return real(*args)

    monkeypatch.setattr(api_routes, "_write_owner_marker", second_finalize_then_discard)
    with app.test_request_context(method="POST", data=form):
        response = api_routes.finalize_upload.__wrapped__()
    status = response[1] if isinstance(response, tuple) else response.status_code

    assert seen["second"] == 409
    assert seen["lock_kept"]
    assert seen["discard"] == {"status": "discarding"}
    assert status == 409
    assert not finalized.exists()
    assert not staging.exists()


def _age(path, seconds):
    then = time.time() - seconds
    os.utime(path, (then, then))


def test_discard_deletes_the_file_itself_when_the_finalize_that_made_it_died(tmp_path, monkeypatch):
    # The worker died after publishing the file and before removing staging, so
    # the lock is still there and no finalize is left to honour a note.
    staging, finalized = _pre_upload(tmp_path, monkeypatch)
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    (staging / ".finalizing").write_text("")
    _age(staging / ".finalizing", 3 * 60 * 60)

    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.discard_upload.__wrapped__("session")

    assert (status, response.get_json()) == (200, {"status": "discarded"})
    assert not staging.exists()
    assert not finalized.exists()


def test_discard_deletes_a_half_assembled_file_left_by_a_finalize_that_died(tmp_path, monkeypatch):
    # Died while assembling: no owner marker yet, only a partial file. The
    # caller owns the staging folder, which is what says the file is theirs.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    (staging / ".finalizing").write_text("")
    _age(staging / ".finalizing", 3 * 60 * 60)
    (finalized / "BDMAP_00000000").mkdir(parents=True)
    (finalized / "BDMAP_00000000" / "ct.nii.gz.partial-1").write_bytes(b"half")

    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.discard_upload.__wrapped__("session")

    assert (status, response.get_json()) == (200, {"status": "discarded"})
    assert not staging.exists()
    assert not finalized.exists()


def test_discard_still_defers_to_a_finalize_that_holds_a_fresh_lock(tmp_path, monkeypatch):
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    (staging / ".finalizing").write_text("")
    _age(staging / ".finalizing", 60)

    with Flask(__name__).test_request_context(method="POST"):
        response, status = api_routes.discard_upload.__wrapped__("session")

    assert (status, response.get_json()) == (200, {"status": "discarding"})
    assert staging.exists()


def test_a_finalize_that_is_not_discarded_still_publishes(tmp_path, monkeypatch):
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    app = Flask(__name__)

    with app.test_request_context(
        method="POST",
        data={"session_id": "session", "total_chunks": "2", "output_filename": "scan.nii.gz"},
    ):
        response = api_routes.finalize_upload.__wrapped__()

    assert response.get_json()["status"] == "combined"
    assert [f.read_bytes() for f in finalized.glob("*/ct.nii.gz")] == [b"firstsecond"]


def _dead_finalize(staging, finalized):
    """What a finalize whose worker was killed leaves: a lock hours old, a half-assembled file."""
    (staging / ".finalizing").write_text("")
    _age(staging / ".finalizing", 3 * 60 * 60)
    (finalized / "BDMAP_00000000").mkdir(parents=True)
    (finalized / "BDMAP_00000000" / "ct.nii.gz.partial-1").write_bytes(b"half")


def _finalize_request(app):
    with app.test_request_context(
        method="POST",
        data={
            "session_id": "session", "total_chunks": "2",
            "output_filename": "scan.nii.gz", "bdmap_id": "BDMAP_00000000",
        },
    ):
        return api_routes.finalize_upload.__wrapped__()


def test_a_finalize_takes_over_a_lock_left_by_a_finalize_that_died(tmp_path, monkeypatch):
    # The retry after a killed worker used to get 409 until the 24-hour sweep.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    _dead_finalize(staging, finalized)

    response = _finalize_request(Flask(__name__))

    assert response.get_json()["status"] == "combined"
    assert [f.read_bytes() for f in finalized.rglob("ct.nii.gz")] == [b"firstsecond"]
    # The dead worker's half file goes, and so does the lock: staging is gone.
    assert not list(finalized.rglob("*.partial-*"))
    assert not staging.exists()


def test_a_finalize_still_refuses_a_lock_that_is_fresh(tmp_path, monkeypatch):
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    (staging / ".finalizing").write_text("")
    _age(staging / ".finalizing", 60)
    stamp = (staging / ".finalizing").stat().st_mtime

    response, status = _finalize_request(Flask(__name__))

    assert status == 409
    assert response.get_json() == {"error": "Upload is already being finalized"}
    assert (staging / ".finalizing").stat().st_mtime == stamp
    assert not finalized.exists()
    assert (staging / "chunk-0").exists()


def test_a_takeover_honours_a_discard_left_for_the_finalize_that_died(tmp_path, monkeypatch):
    # A discard saw the lock while the finalize was still running, left its note
    # and was told it would be honoured; then the worker died. The retry that
    # takes the lock over is the finalize that note was left for.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    _dead_finalize(staging, finalized)
    (finalized / ".discarded").write_text("")

    _response, status = _finalize_request(Flask(__name__))

    assert status == 409
    assert not finalized.exists()
    assert not staging.exists()


def _run_discard(app):
    with app.test_request_context(method="POST"):
        return api_routes.discard_upload.__wrapped__("session")


def _race(monkeypatch, outer, step):
    """Run a finalize or a discard, sending the other request just before `step` runs."""
    app = Flask(__name__)
    requests = {"finalize": _finalize_request, "discard": _run_discard}
    inner = "discard" if outer == "finalize" else "finalize"
    target = os if step in ("rename", "remove") else api_routes
    real = getattr(target, step)
    sent = []

    def other_first(*args, **kwargs):
        if not sent:  # both requests clean up with some of the same helpers
            sent.append(None)
            sent[0] = requests[inner](app)
        return real(*args, **kwargs)

    monkeypatch.setattr(target, step, other_first)
    first = requests[outer](app)
    assert sent, f"{step} was never reached"
    return first, sent[0]


def _ends_with_the_file_or_nothing(finalized):
    files = [p for p in finalized.rglob("*") if p.is_file()] if finalized.exists() else []
    if not files:
        return True
    return (
        [p.name for p in files if p.name.startswith("ct.")] == ["ct.nii.gz"]
        and not [p for p in files if p.name in (".discarded",) or ".partial-" in p.name]
    )


# Every point at which a discard can land in a finalize taking over a dead lock
# (the finalize is the first request), or a finalize in a discard that has
# found the same lock dead (the discard is the first).
@pytest.mark.parametrize("outer, step", [
    ("finalize", "acquire_finalize_lock"),
    ("finalize", "remove"),
    ("finalize", "_write_owner_marker"),
    ("finalize", "_remove_staging_session"),
    ("finalize", "_discard_requested"),
    ("discard", "acquire_finalize_lock"),
    ("discard", "_read_owner_marker"),
    ("discard", "_remove_staging_session"),
    ("discard", "_remove_finalized_upload"),
])
def test_a_takeover_racing_a_discard_of_the_same_dead_lock_leaves_the_file_or_nothing(
    tmp_path, monkeypatch, outer, step
):
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    _dead_finalize(staging, finalized)

    first, second = _race(monkeypatch, outer, step)

    # A request that lost is refused, not crashed (a swallowed error is a 500).
    for response in (first, second):
        assert (response[1] if isinstance(response, tuple) else response.status_code) != 500
    assert _ends_with_the_file_or_nothing(finalized)
    assert not (finalized / ".discarded").exists()


def test_a_discard_that_found_the_lock_dead_cannot_delete_under_the_finalize_that_takes_it_over(
    tmp_path, monkeypatch
):
    # The discard reads the lock's age, is slow to act on it, and a finalize
    # takes the lock over in the meantime and gets as far as having assembled
    # the file. Both requests are real: the discard runs in its own thread.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    _dead_finalize(staging, finalized)
    app = Flask(__name__)
    lock_read, taken_over = threading.Event(), threading.Event()
    real_getmtime = os.path.getmtime
    real_write_owner_marker = api_routes._write_owner_marker
    discards = []
    discarder = threading.Thread(target=lambda: discards.append(_run_discard(app)))

    def slow_to_act(path):
        age = real_getmtime(path)
        if threading.current_thread() is discarder and not lock_read.is_set():
            lock_read.set()
            taken_over.wait(10)
        return age

    def assembled(*args):
        taken_over.set()
        discarder.join(10)
        return real_write_owner_marker(*args)

    monkeypatch.setattr(os.path, "getmtime", slow_to_act)
    monkeypatch.setattr(api_routes, "_write_owner_marker", assembled)
    discarder.start()
    assert lock_read.wait(10)
    _finalize_request(app)

    assert taken_over.is_set()
    (_body, discard_status), = discards
    assert discard_status == 200
    # However the two were ordered, the discard was accepted: no file is left.
    assert not finalized.exists()


def test_a_discard_left_for_a_finalize_whose_worker_died_is_reaped_by_the_sweep(tmp_path, monkeypatch):
    # The worker died mid-assembly, but its lock was touched a moment ago, so a
    # discard still leaves word for it and goes. Nothing else looks in the
    # finalized folder, so the sweep has to clear the half-assembled file.
    sweep = api_routes._maybe_sweep_uploads
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    _dead_finalize(staging, finalized)
    _age(staging / ".finalizing", 60)

    response, status = _run_discard(Flask(__name__))
    assert (status, response.get_json()) == (200, {"status": "discarding"})
    assert (finalized / ".discarded").exists()

    monkeypatch.setattr(api_routes, "_last_upload_sweep", 0.0)
    sweep()
    assert (finalized / ".discarded").exists()  # the lock is not yet stale

    _age(staging / ".finalizing", 2 * 60 * 60)
    monkeypatch.setattr(api_routes, "_last_upload_sweep", 0.0)
    sweep()

    assert not finalized.exists()
    assert not staging.exists()


def _upload_of_another_account(tmp_path, monkeypatch):
    """The owner's finished pre-upload, and a different account holding its session id."""
    staging, finalized = _pre_upload(tmp_path, monkeypatch)
    shutil.rmtree(staging)
    monkeypatch.setattr(api_routes, "_maybe_sweep_uploads", lambda: None)
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "other"})
    return finalized


def test_a_session_id_whose_upload_is_another_accounts_cannot_be_staged_under_or_finalized(tmp_path, monkeypatch):
    finalized = _upload_of_another_account(tmp_path, monkeypatch)
    app = Flask(__name__)
    chunk = {
        "session_id": "session", "chunk_index": "0", "total_chunks": "1",
        "file": (io.BytesIO(b"x"), "chunk"),
    }

    with app.test_request_context(method="POST", data=chunk, content_type="multipart/form-data"):
        _body, chunk_status = api_routes.upload_inference_chunk.__wrapped__()
    _body, finalize_status = _finalize_request(app)
    with app.test_request_context():
        _body, status_status = api_routes.upload_status.__wrapped__("session")

    assert (chunk_status, finalize_status, status_status) == (403, 403, 403)
    assert not (tmp_path / "chunks" / "session").exists()
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").read_bytes() == b"ct"


def test_a_discard_of_another_accounts_upload_leaves_no_note_and_deletes_nothing(tmp_path, monkeypatch):
    # The staging folder is the caller's and a finalize of theirs holds a live
    # lock, which is where a discard would otherwise write its note.
    finalized = _upload_of_another_account(tmp_path, monkeypatch)
    staging = tmp_path / "chunks" / "session"
    staging.mkdir()
    (staging / ".owner").write_text("other")
    (staging / ".finalizing").write_text("")

    response, status = _run_discard(Flask(__name__))

    assert status == 403
    assert not (finalized / ".discarded").exists()
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").read_bytes() == b"ct"


def test_a_finalize_refused_at_the_owner_marker_does_not_delete_the_folder_it_lost_to(tmp_path, monkeypatch):
    # The other account's upload was published while this one was assembling, and
    # a note for this finalize was left before that. The note is this finalize's,
    # not a licence to delete what it does not own.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    (staging / ".owner").write_text("other")
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "other"})
    finalized.mkdir(parents=True)
    (finalized / ".discarded").write_text("")
    real = api_routes._write_owner_marker

    def other_account_publishes_first(session_id, user_id):
        (finalized / "BDMAP_00000001").mkdir()
        (finalized / "BDMAP_00000001" / "ct.nii.gz").write_bytes(b"ct")
        (finalized / ".owner").write_text("owner")
        return real(session_id, user_id)

    monkeypatch.setattr(api_routes, "_write_owner_marker", other_account_publishes_first)

    _body, status = _finalize_request(Flask(__name__))

    assert status == 403
    assert (finalized / "BDMAP_00000001" / "ct.nii.gz").read_bytes() == b"ct"
    assert (finalized / ".owner").read_text() == "owner"
    assert not staging.exists()


def test_discard_upload_rejects_path_like_ids(monkeypatch):
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    with Flask(__name__).test_request_context(method="POST"):
        _response, status = api_routes.discard_upload.__wrapped__("..")
    assert status == 400


def test_deleting_history_forgets_finished_runs_and_keeps_live_ones(tmp_path, monkeypatch):
    import json

    runs = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    monkeypatch.setattr(Constants, "SESSIONS_DIR_NAME", str(tmp_path / "sessions"))
    for session_id, status in (("done", "completed"), ("live", "running")):
        (runs / session_id).mkdir(parents=True)
        (runs / session_id / "job.json").write_text(json.dumps({"user_id": "owner", "status": status}))
    monkeypatch.setitem(api_routes.inference_jobs, "done", {"user_id": "owner", "status": "completed"})
    monkeypatch.setitem(api_routes.inference_jobs, "live", {"user_id": "owner", "status": "running"})

    assert api_routes.delete_inference_runs_for_user("owner") == 1
    assert "done" not in api_routes.inference_jobs
    assert not (runs / "done").exists()
    assert api_routes.inference_jobs["live"]["status"] == "running"
    assert (runs / "live").exists()


def test_a_run_interrupted_by_a_restart_gives_back_its_plan_slot(tmp_path, monkeypatch):
    import json

    runs = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    for session_id, status in (("dead", "running"), ("waiting", "queued"), ("done", "completed")):
        (runs / session_id).mkdir(parents=True)
        (runs / session_id / "job.json").write_text(json.dumps({"user_id": "owner", "status": status}))
        monkeypatch.delitem(api_routes.inference_jobs, session_id, raising=False)
    finished = []
    monkeypatch.setattr(api_routes.plan_store, "finish_inference", finished.append)

    try:
        assert api_routes._get_inference_job("dead")["status"] == "failed"
        assert api_routes._get_inference_job("waiting")["status"] == "failed"
        assert api_routes._get_inference_job("done")["status"] == "completed"
    finally:
        for session_id in ("dead", "waiting", "done"):
            api_routes.inference_jobs.pop(session_id, None)
    assert finished == ["dead", "waiting"]


def _signed_in_with_staging(tmp_path, monkeypatch):
    monkeypatch.setattr(auth_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes, "_maybe_sweep_uploads", lambda: None)
    staging = tmp_path / "staging"
    (staging / "dicom").mkdir(parents=True)
    monkeypatch.setattr(
        api_routes, "_staging_for_current_user",
        lambda _sid, create=False: (str(staging), None),
    )
    return staging


def _disk_full(*_args, **_kwargs):
    raise OSError(28, "No space left on device", "/srv/secret-root/uploads/chunk-0")


def test_upload_failures_do_not_send_server_paths_to_the_client(tmp_path, monkeypatch):
    from werkzeug.datastructures import FileStorage

    _signed_in_with_staging(tmp_path, monkeypatch)
    monkeypatch.setattr(FileStorage, "save", _disk_full)
    monkeypatch.setattr(api_routes, "_record_total_chunks", lambda *_a: True)
    client = _client()

    chunk = client.post("/api/upload-inference-chunk", data={
        "session_id": "s1", "chunk_index": "0", "total_chunks": "1",
        "file": (io.BytesIO(b"x"), "chunk"),
    })
    dicom = client.post("/api/upload-dicom-slice", data={
        "session_id": "s1", "file": (io.BytesIO(b"x"), "a.dcm"),
    })
    monkeypatch.setattr(api_routes, "_record_total_chunks", _disk_full)
    finalize = client.post("/api/finalize-upload", data={"session_id": "s1", "total_chunks": "1"})

    assert chunk.status_code == 500
    assert chunk.get_json() == {"error": "Could not save the upload chunk"}
    assert dicom.status_code == 500
    assert dicom.get_json() == {"error": "Could not save the DICOM slice"}
    assert finalize.status_code == 500
    assert finalize.get_json() == {"error": "Could not assemble the upload"}


class _FakeSeriesReader:
    fail_with = None

    def GetGDCMSeriesIDs(self, _root):
        return ["series-1"]

    def SetFileNames(self, _names):
        pass

    def Execute(self):
        if self.fail_with is not None:
            raise self.fail_with
        return "image"


def _fake_sitk():
    import types

    def write_image(_image, path):
        with open(path, "wb") as f:
            f.write(b"nifti")

    return types.SimpleNamespace(
        ImageSeriesReader=_FakeSeriesReader,
        DICOMOrient=lambda image, _orientation: image,
        WriteImage=write_image,
    )


def test_finalize_dicom_keeps_server_paths_and_raw_errors_private(tmp_path, monkeypatch):
    import sys

    _signed_in_with_staging(tmp_path, monkeypatch)
    monkeypatch.setitem(sys.modules, "SimpleITK", _fake_sitk())
    monkeypatch.setattr(api_routes, "_select_dicom_series_files", lambda *_a: ["a.dcm"])
    monkeypatch.setattr(api_routes, "_write_owner_marker", lambda *_a: True)
    monkeypatch.setattr(api_routes, "_remove_staging_session", lambda _sid: None)
    monkeypatch.setattr(Constants, "SESSIONS_DIR_NAME", str(tmp_path / "sessions"))
    client = _client()

    ok = client.post("/api/finalize-dicom", data={"session_id": "s1"})
    assert ok.status_code == 200
    body = ok.get_json()
    assert "path" not in body
    assert body["uploaded_filename"].endswith("ct.nii.gz")
    assert str(tmp_path) not in json.dumps(body)

    # A series the reader can't assemble is the upload's problem: 400, plainly.
    monkeypatch.setattr(
        _FakeSeriesReader, "fail_with",
        RuntimeError("ITK ERROR: /build/sitk/Code/IO/src/sitkImageSeriesReader.cxx /srv/secret-root/a.dcm"),
    )
    bad = client.post("/api/finalize-dicom", data={"session_id": "s1"})
    assert bad.status_code == 400
    assert bad.get_json() == {"error": "The DICOM files could not be read as a single series"}

    # Anything else is a plain 500.
    monkeypatch.setattr(_FakeSeriesReader, "fail_with", None)
    monkeypatch.setattr(api_routes, "_write_owner_marker", _disk_full)
    broken = client.post("/api/finalize-dicom", data={"session_id": "s1"})
    assert broken.status_code == 500
    assert broken.get_json() == {"error": "Could not convert the DICOM series"}


def _dicom_upload(tmp_path, monkeypatch):
    """A staged DICOM series for the signed-in owner, converted by a fake SimpleITK."""
    import sys

    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    (staging / "dicom").mkdir()
    (staging / "dicom" / "a.dcm").write_bytes(b"slice")
    monkeypatch.setitem(sys.modules, "SimpleITK", _fake_sitk())
    monkeypatch.setattr(api_routes, "_select_dicom_series_files", lambda *_a: ["a.dcm"])
    return staging, finalized


def _dicom_request(app=None):
    with (app or Flask(__name__)).test_request_context(
        method="POST", data={"session_id": "session"},
    ):
        return api_routes.finalize_dicom.__wrapped__()


def _during_conversion(monkeypatch, action, at="WriteImage"):
    """Run `action` once, in the middle of the conversion, and return what it produced."""
    import sys

    sitk = sys.modules["SimpleITK"]
    real = getattr(sitk, at)
    done = []

    def hooked(*args, **kwargs):
        if not done:
            done.append(action())
        return real(*args, **kwargs)

    monkeypatch.setattr(sitk, at, hooked)
    return done


@pytest.mark.parametrize("at", ["WriteImage", "DICOMOrient"])
def test_a_discard_during_a_dicom_conversion_leaves_no_ct_behind(tmp_path, monkeypatch, at):
    # The Cancel that reaches the server while the series is being converted:
    # discard used to find no lock, delete the staged slices, answer
    # "discarded", and the conversion went on to write the CT anyway.
    staging, finalized = _dicom_upload(tmp_path, monkeypatch)
    discard = _during_conversion(monkeypatch, lambda: _run_discard(Flask(__name__)), at=at)

    response, status = _dicom_request()

    assert discard[0][1] == 200
    assert discard[0][0].get_json() == {"status": "discarding"}
    assert (status, response.get_json()) == (409, {"error": "This upload was discarded."})
    assert not finalized.exists()
    assert not staging.exists()


def test_a_dicom_conversion_that_fails_after_a_discard_still_deletes_what_it_made(tmp_path, monkeypatch):
    import sys

    staging, finalized = _dicom_upload(tmp_path, monkeypatch)

    def write_then_fail(_image, path):
        _run_discard(Flask(__name__))
        with open(path, "wb") as f:
            f.write(b"half")
        raise OSError("disk full")

    monkeypatch.setattr(sys.modules["SimpleITK"], "WriteImage", write_then_fail)

    _response, status = _dicom_request()

    assert status == 500
    assert not finalized.exists()
    assert not staging.exists()


def test_two_dicom_conversions_of_one_session_do_not_run_at_once(tmp_path, monkeypatch):
    staging, finalized = _dicom_upload(tmp_path, monkeypatch)
    second = _during_conversion(monkeypatch, _dicom_request)

    response = _dicom_request()

    assert response.status_code == 200
    refused, refused_status = second[0]
    assert refused_status == 409
    assert refused.get_json() == {"error": "Upload is already being finalized"}
    assert [f.read_bytes() for f in finalized.rglob("ct.nii.gz")] == [b"nifti"]


def test_a_dicom_conversion_takes_over_the_lock_of_one_that_died(tmp_path, monkeypatch):
    import uuid

    staging, finalized = _dicom_upload(tmp_path, monkeypatch)
    (staging / ".finalizing").write_text("")
    _age(staging / ".finalizing", 3 * 60 * 60)
    digits = f"{uuid.uuid5(uuid.NAMESPACE_DNS, 'session').int % 10 ** 8:08d}"
    dead_partial = finalized / f"BDMAP_{digits}" / "ct.nii.gz.partial-1.nii.gz"
    dead_partial.parent.mkdir(parents=True)
    dead_partial.write_bytes(b"half")

    response = _dicom_request()

    assert response.get_json()["status"] == "converted"
    assert [f.read_bytes() for f in finalized.rglob("ct.nii.gz")] == [b"nifti"]
    assert not dead_partial.exists()


def test_a_dicom_conversion_keeps_its_lock_fresh_and_gives_it_back(tmp_path, monkeypatch):
    import sys

    staging, finalized = _dicom_upload(tmp_path, monkeypatch)
    monkeypatch.setattr(chunk_store, "FINALIZE_LOCK_BEAT_SECONDS", 3600)  # only the step-boundary beat
    seen = []

    def orient_after_a_long_read(image, _orientation):
        _age(staging / ".finalizing", chunk_store.FINALIZE_LOCK_STALE_SECONDS - 5)
        return image

    def write(_image, path):
        seen.append(time.time() - (staging / ".finalizing").stat().st_mtime)
        with open(path, "wb") as f:
            f.write(b"nifti")

    monkeypatch.setattr(sys.modules["SimpleITK"], "DICOMOrient", orient_after_a_long_read)
    monkeypatch.setattr(sys.modules["SimpleITK"], "WriteImage", write)

    assert _dicom_request().get_json()["status"] == "converted"

    assert seen and seen[0] < 5  # touched between the read and the write
    assert not [t for t in threading.enumerate() if t.name == "finalize-lock-heartbeat"]


def test_a_chunk_finalize_keeps_its_lock_fresh_while_it_assembles(tmp_path, monkeypatch):
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    monkeypatch.setattr(chunk_store, "FINALIZE_LOCK_BEAT_SECONDS", 0.01)
    real_copy = api_routes.shutil.copyfileobj
    ages = []

    def copy_slowly(src, dst, *args, **kwargs):
        if not ages:
            # A long step: the lock would be stale but for the heartbeat.
            _age(staging / ".finalizing", chunk_store.FINALIZE_LOCK_STALE_SECONDS - 1)
            deadline = time.time() + 5
            while time.time() < deadline and time.time() - (staging / ".finalizing").stat().st_mtime > 1:
                time.sleep(0.01)
            ages.append(time.time() - (staging / ".finalizing").stat().st_mtime)
        return real_copy(src, dst, *args, **kwargs)

    monkeypatch.setattr(api_routes.shutil, "copyfileobj", copy_slowly)

    response = _finalize_request(Flask(__name__))

    assert response.get_json()["status"] == "combined"
    assert ages and ages[0] < 1
    # The heartbeat ends with the finalize that started it.
    assert not [t for t in threading.enumerate() if t.name == "finalize-lock-heartbeat"]


class _NoThreadToBeHad:
    def __init__(self, *_args, **_kwargs):
        raise RuntimeError("can't start new thread")


def test_a_lock_is_not_left_behind_when_the_heartbeat_cannot_start(tmp_path, monkeypatch):
    # Thread.start() failing (a container's thread or memory limit) used to leave
    # the lock just taken with nobody holding it: every retry got 409 "already
    # being finalized" until the lock went stale, and a Cancel left a note that
    # nothing would honour.
    staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
    real = api_routes.FinalizeHeartbeat
    monkeypatch.setattr(api_routes, "FinalizeHeartbeat", _NoThreadToBeHad)

    with pytest.raises(RuntimeError):
        api_routes._take_finalize_lock(str(staging))

    assert not (staging / ".finalizing").exists()
    monkeypatch.setattr(api_routes, "FinalizeHeartbeat", real)  # threads are to be had again
    held, refused = api_routes._take_finalize_lock(str(staging))
    assert refused is None
    api_routes._release_finalize_lock(held, "session")


@pytest.mark.parametrize("finalize", ["chunks", "dicom"])
def test_a_finalize_whose_heartbeat_cannot_start_answers_500_and_can_be_retried(tmp_path, monkeypatch, finalize):
    if finalize == "dicom":
        staging, finalized = _dicom_upload(tmp_path, monkeypatch)
        run = _dicom_request
    else:
        staging, finalized = _finalizing_upload(tmp_path, monkeypatch)
        run = lambda: _finalize_request(Flask(__name__))
    real = api_routes.FinalizeHeartbeat
    monkeypatch.setattr(api_routes, "FinalizeHeartbeat", _NoThreadToBeHad)

    failed = run()

    assert (failed[1] if isinstance(failed, tuple) else failed.status_code) == 500
    assert not (staging / ".finalizing").exists()
    # The retry is not refused for five minutes.
    monkeypatch.setattr(api_routes, "FinalizeHeartbeat", real)
    retry = run()
    assert retry.get_json()["status"] == ("converted" if finalize == "dicom" else "combined")


def test_dicom_series_prefers_largest_ct_stack():
    class Reader:
        def GetGDCMSeriesFileNames(self, _root, series_id):
            return {
                "scout": ["scout-1", "scout-2", "scout-3"],
                "ct-small": ["ct-small"],
                "ct-main": ["ct-1", "ct-2"],
            }[series_id]

    modalities = {"scout-1": "MR", "ct-small": "CT", "ct-1": "CT"}

    class Probe:
        filename = None

        def SetFileName(self, filename):
            self.filename = filename

        def ReadImageInformation(self):
            return None

        def HasMetaDataKey(self, _key):
            return True

        def GetMetaData(self, _key):
            return modalities[self.filename]

    class Sitk:
        ImageFileReader = Probe

    selected = api_routes._select_dicom_series_files(
        Sitk, Reader(), "/dicom", ["scout", "ct-small", "ct-main"]
    )
    assert selected == ["ct-1", "ct-2"]
