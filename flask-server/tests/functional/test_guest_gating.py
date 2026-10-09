"""Guest gating: the data plane refuses anonymous callers.

The upload endpoints and the AI assistant were open to unauthenticated
requests; the only real gate was /run-inference. These tests pin the new
boundary: guests browse, accounts upload and chat.

api.api_blueprint has import-time side effects (it creates directories from
env-configured paths), so the fixture points every path at a temp dir before
the import. The module is imported once per pytest process — run this file as
its own step, as ci.yml does.
"""

import importlib
import io
import os

import pytest


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    base = tmp_path_factory.mktemp("guest_gating")
    for var, sub in [
        ("DATABASE_URL", None),
        ("PANTS_PATH", "data"),
        ("PANTS_LOWRES_PATH", "lowres"),
        ("PERMISSIONS_DIR", "perm"),
        ("BODYMAPS_UPLOAD_CHUNK_DIR", "chunks"),
    ]:
        value = f"sqlite:///{base / 'gg.db'}" if sub is None else str(base / sub)
        os.environ[var] = value

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.plan_store as plan_store
    importlib.reload(plan_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    # Heavy module, imported once (no reload): binds the auth/plan modules above.
    import api.api_blueprint as api_bp

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask

    flask_app = Flask(__name__)
    flask_app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    flask_app.register_blueprint(api_bp.api_blueprint, url_prefix="/api")
    yield flask_app
    engine.reset_engine_for_tests()


@pytest.fixture()
def client(app):
    with app.test_client() as c:
        yield c


def _register(client, email="g@h.com"):
    r = client.post("/api/auth/register",
                    json={"email": email, "password": "password1"})
    assert r.status_code == 201
    return r.get_json()["user"]["id"]


UPLOAD_ENDPOINTS = [
    "/api/upload",
    "/api/upload-inference-chunk",
    "/api/finalize-upload",
    "/api/upload-dicom-slice",
    "/api/finalize-dicom",
    "/api/save-edited-mask/1",
]


def test_upload_endpoints_refuse_guests(client):
    for endpoint in UPLOAD_ENDPOINTS:
        r = client.post(endpoint, data={})
        assert r.status_code == 401, endpoint


def test_legacy_upload_writes_nothing_for_guests(client):
    import constants

    r = client.post("/api/upload", data={
        "SESSION_ID": "guest-upload",
        "MAIN_NIFTI": (io.BytesIO(b"not-a-scan"), "ct.nii.gz"),
    })
    assert r.status_code == 401
    assert not os.path.exists(
        os.path.join(constants.Constants.SESSIONS_DIR_NAME, "guest-upload"))


def test_pull_queue_job_creation_needs_the_worker_token(client, monkeypatch):
    import api.api_blueprint as api_bp

    monkeypatch.setenv("WORKER_API_TOKEN", "worker-secret")
    monkeypatch.setattr(
        api_bp.inference_job_queue, "create_job",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("job was queued")),
    )
    scan = lambda: (io.BytesIO(b"scan"), "ct.nii.gz")  # noqa: E731

    assert client.post("/api/jobs", data={"MAIN_NIFTI": scan()}).status_code == 401
    wrong = client.post("/api/jobs", data={"MAIN_NIFTI": scan()},
                        headers={"X-Worker-Token": "guess"})
    assert wrong.status_code == 401

    # A signed-in site account is not a worker either.
    _register(client, email="jobs-user@h.com")
    assert client.post("/api/jobs", data={"MAIN_NIFTI": scan()}).status_code == 401


def test_pull_queue_job_creation_works_with_the_worker_token(client, monkeypatch):
    import api.api_blueprint as api_bp

    monkeypatch.setenv("WORKER_API_TOKEN", "worker-secret")
    queued = {}

    def fake_create_job(**kwargs):
        queued.update(kwargs)
        return {"job_id": "job-1", "session_id": kwargs["session_id"],
                "model": kwargs["model"], "status": "queued"}

    monkeypatch.setattr(api_bp.inference_job_queue, "create_job", fake_create_job)
    r = client.post("/api/jobs", data={
        "session_id": "worker-session",
        "MAIN_NIFTI": (io.BytesIO(b"scan"), "ct.nii.gz"),
    }, headers={"X-Worker-Token": "worker-secret"})
    assert r.status_code == 201
    assert queued["session_id"] == "worker-session"


def test_private_session_endpoints_refuse_guests(client):
    for endpoint in (
        "/api/upload-status/private-session",
        "/api/inference-status/private-session",
        "/api/get_result/private-session",
        "/api/session-ct/private-session",
        "/api/session-segmentation/private-session",
        "/api/session-reconstruction/private-session",
        "/api/sessions/private-session/mesh-manifest",
        "/api/sessions/private-session/render_only/liver.glb",
    ):
        assert client.get(endpoint).status_code == 401, endpoint

    assert client.post("/api/cancel-inference/private-session").status_code == 401
    assert client.post("/api/cancel-inference").status_code == 401


def test_segmentation_download_is_private_and_not_available_to_ordinary_users(client):
    """The legacy dataset archive route must never become a guest download."""
    assert client.get("/api/download/35").status_code == 401

    _register(client, email="download-user@h.com")
    response = client.get("/api/download/35")
    assert response.status_code == 403
    assert response.get_json()["error"] == "Segmentation downloads are disabled."


def test_signed_in_chunk_upload_still_works(client):
    _register(client, email="u1@h.com")
    r = client.post("/api/upload-inference-chunk", data={
        "session_id": "123456",
        "chunk_index": "0",
        "total_chunks": "1",
        "file": (io.BytesIO(b"chunk-bytes"), "chunk"),
    })
    assert r.status_code == 200
    assert r.get_json()["status"] == "ok"


def test_dicom_slice_retry_replaces_the_same_staged_file(client, app):
    _register(client, email="dicom@h.com")
    request_data = {
        "session_id": "dicom-session",
        "slice_index": "7",
    }
    first = client.post("/api/upload-dicom-slice", data={
        **request_data,
        "file": (io.BytesIO(b"first"), "image.dcm"),
    })
    assert first.status_code == 200

    retry = client.post("/api/upload-dicom-slice", data={
        **request_data,
        "file": (io.BytesIO(b"replacement"), "image.dcm"),
    })
    assert retry.status_code == 200

    chunk_root = os.environ["BODYMAPS_UPLOAD_CHUNK_DIR"]
    staged = os.path.join(chunk_root, "dicom-session", "dicom", "slice-000007-image.dcm")
    with open(staged, "rb") as stream:
        assert stream.read() == b"replacement"


def test_assistant_refuses_guests(client):
    for endpoint in ("/api/ai-command", "/api/ai-command-stream"):
        r = client.post(endpoint, json={"message": "hi"})
        assert r.status_code == 401, endpoint
        assert "Sign in" in (r.get_json() or {}).get("error", "")


def test_assistant_enforces_the_daily_allowance(client):
    import services.plan_store as plan_store

    user_id = _register(client, email="u2@h.com")
    limit = plan_store.PLAN_LIMITS["free"]["daily_ai_messages"]
    for _ in range(limit):
        plan_store.record_ai_message(user_id)
    r = client.post("/api/ai-command", json={"message": "hi"})
    assert r.status_code == 402
    body = r.get_json()
    assert body["code"] == "plan_limit"
    assert body["reason"] == "daily_ai_messages"
