"""The assistant and /mask-data only read a session's segmentation for its owner.

A session id is not a bearer token: signed in as someone else, asking the
assistant about another person's upload must behave as if no case were open,
and /mask-data must refuse. Dataset ids stay open to everyone, and an
administrator can still read any session.
"""

import json

import pytest
from flask import Flask

from api import api_blueprint as bp

SESSION = "11111111-2222-3333-4444-555555555555"
CV_SESSION = "CV-abc"


@pytest.fixture
def world(monkeypatch):
    state = {"user": {"id": "owner"}, "admin": False}
    monkeypatch.setattr(bp, "current_user", lambda: state["user"])
    monkeypatch.setattr(bp.role_store, "has_role", lambda *_args: state["admin"])
    monkeypatch.setattr(
        bp, "_get_inference_job",
        lambda sid: {"user_id": "owner", "status": "completed"} if sid in (SESSION, CV_SESSION) else None,
    )
    monkeypatch.setattr(bp, "_ai_gate", lambda: None)

    seen = []

    def load_metrics(case_id, supplied):
        seen.append(("metrics", case_id))
        return [], "none"

    def lesion_context(case_id, message):
        seen.append(("lesion", case_id))
        return None

    monkeypatch.setattr(bp, "_ai_load_metrics", load_metrics)
    monkeypatch.setattr(bp, "_ai_lesion_context", lesion_context)
    monkeypatch.setattr(bp, "_ai_metadata", lambda case_id, demographics: seen.append(("meta", case_id)) or {})

    def offline(**_kwargs):
        raise bp.OllamaUnavailable("offline")

    monkeypatch.setattr(bp, "chat_json", offline)
    monkeypatch.setattr(bp, "chat_stream", offline)
    monkeypatch.setattr(bp, "chat_with_tools", offline)
    state["seen"] = seen
    return state


def test_case_allowed_covers_owner_other_admin_and_dataset(world):
    app = Flask(__name__)
    with app.test_request_context():
        assert bp._ai_case_allowed(SESSION) is True
        assert bp._ai_case_allowed("35") is True
        assert bp._ai_case_allowed("") is True
        assert bp._ai_case_allowed("CV0001") is True
        assert bp._ai_case_allowed(CV_SESSION) is True
        world["user"] = {"id": "someone-else"}
        assert bp._ai_case_allowed(SESSION) is False
        assert bp._ai_case_allowed(CV_SESSION) is False
        assert bp._ai_case_allowed("35") is True
        world["user"] = None
        assert bp._ai_case_allowed(SESSION) is False
        world["user"] = {"id": "admin"}
        world["admin"] = True
        assert bp._ai_case_allowed(SESSION) is True


def _mask_data(session_key):
    app = Flask(__name__)
    app.add_url_rule("/api/mask-data", view_func=bp.get_mask_data, methods=["POST"])
    return app.test_client().post("/api/mask-data", data={"sessionKey": session_key})


def test_mask_data_for_a_session_is_refused_to_another_user(world, monkeypatch):
    monkeypatch.setattr(bp, "get_session_mask_data", lambda sid, job: {"organ_metrics": [{"organ_name": "liver"}]})
    world["user"] = {"id": "someone-else"}
    response = _mask_data(SESSION)
    assert response.status_code == 403
    assert "organ_metrics" not in json.dumps(response.get_json())


def test_mask_data_for_a_session_is_served_to_its_owner_and_an_admin(world, monkeypatch):
    monkeypatch.setattr(bp, "get_session_mask_data", lambda sid, job: {"organ_metrics": [{"organ_name": "liver"}]})
    assert _mask_data(SESSION).get_json()["organ_metrics"][0]["organ_name"] == "liver"
    world["user"] = {"id": "admin"}
    world["admin"] = True
    assert _mask_data(SESSION).status_code == 200


def test_mask_data_for_a_dataset_case_stays_open(world, monkeypatch):
    monkeypatch.setattr(bp, "get_mask_data_internal", lambda sid: {"organ_metrics": [{"organ_name": "liver"}]})
    world["user"] = None
    assert _mask_data("35").status_code == 200
