from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from flask import Flask

import api.api_blueprint as api_routes
import api.auth as auth_routes
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
