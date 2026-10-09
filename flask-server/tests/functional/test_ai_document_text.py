"""Attached document text is reference material, not the person's request.

The browser sends the typed question, the file names and the extracted text of
each document as one string. The rules that read intent, move the viewer or
override an answer must look at the typed part only. Uploaded photos are also
not viewer screenshots and carry no mask colors.

Same import caveat as test_guest_gating.py: api.api_blueprint has import-time
side effects, so run this file as its own pytest process.
"""

import importlib
import json
import os

import pytest


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    base = tmp_path_factory.mktemp("ai_document_text")
    for var, sub in [
        ("DATABASE_URL", None),
        ("PANTS_PATH", "data"),
        ("PANTS_LOWRES_PATH", "lowres"),
        ("PERMISSIONS_DIR", "perm"),
        ("BODYMAPS_UPLOAD_CHUNK_DIR", "chunks"),
    ]:
        value = f"sqlite:///{base / 'ad.db'}" if sub is None else str(base / sub)
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




def _register(client, email="d@h.com"):
    r = client.post("/api/auth/register",
                    json={"email": email, "password": "password1"})
    assert r.status_code == 201


def _events(response):
    return [json.loads(line) for line in response.get_data(as_text=True).splitlines() if line.strip()]


_REPORT = (
    "Axial images with coronal reformats. IV contrast 100 mL. "
    "Segment VII of the liver is clear. There is a mass in the pancreatic head."
)
_DOCUMENT_TURN = (
    "summarize this report\n\n[Attached files: report.pdf]\n\n"
    'Content of attached document "report.pdf":\n' + _REPORT
)
_IMAGE = "data:image/png;base64,iVBORw0KGgo="


def test_typed_message_stops_at_the_attachments():
    from api.api_blueprint import _ai_typed_message

    assert _ai_typed_message("hello") == "hello"
    assert _ai_typed_message(_DOCUMENT_TURN) == "summarize this report"
    assert _ai_typed_message('Content of attached document "a.pdf":\nx') == ""
    assert _ai_typed_message("what is this?\n\n[Attached files: a.png]") == "what is this?"


@pytest.fixture()
def seen(monkeypatch):
    """Records what the model was sent and which rules read the message."""
    import api.api_blueprint as api_bp

    record = {"prompts": [], "lesion_messages": [], "agent_calls": 0}

    def answer(**kwargs):
        record["prompts"].append(kwargs.get("user_prompt"))
        yield "content", "The report describes a mass in the pancreatic head."

    def answer_json(**kwargs):
        record["prompts"].append(kwargs.get("user_prompt"))
        return {"reply": "The report describes a mass in the pancreatic head.", "actions": [], "intent": "chat"}

    def lesion_context(case_id, message):
        record["lesion_messages"].append(message)
        return {
            "available": True, "facts": ["No pancreatic lesion is present."],
            "absent": ["Pancreatic lesion"], "present": [], "summary": "There is no pancreatic lesion in this case.",
        }

    def agent(**kwargs):
        record["agent_calls"] += 1
        return {"content": "ok", "tool_calls": []}

    monkeypatch.setattr(api_bp, "chat_stream", answer)
    monkeypatch.setattr(api_bp, "chat_json", answer_json)
    monkeypatch.setattr(api_bp, "chat_with_tools", agent)
    monkeypatch.setattr(api_bp, "_ai_lesion_context", lesion_context)
    monkeypatch.setattr(api_bp, "_ai_load_metrics", lambda *a, **k: ([], "test"))
    monkeypatch.setattr(api_bp, "resolve_vision_model", lambda *a, **k: "vision-test")
    monkeypatch.setattr(api_bp, "resolve_text_model", lambda *a, **k: "text-test")
    return record


_CASE = {"session_id": "1", "available_organs": ["liver", "pancreas"]}


def test_stream_ignores_document_wording_but_gives_the_model_the_document(client, seen):
    _register(client, email="d1@h.com")
    r = client.post("/api/ai-command-stream", json={"message": _DOCUMENT_TURN, **_CASE})
    events = _events(r)

    assert [e for e in events if e["type"] == "actions"] == []
    assert seen["lesion_messages"] == []
    assert seen["agent_calls"] == 0
    final = [e for e in events if e["type"] == "final"][0]
    assert final["actions"] == []
    assert "no pancreatic lesion" not in final["reply"].lower()
    assert "mass in the pancreatic head" in final["reply"]
    assert any(_REPORT in (prompt or "") for prompt in seen["prompts"])


def test_command_ignores_document_wording_but_gives_the_model_the_document(client, seen):
    _register(client, email="d2@h.com")
    r = client.post("/api/ai-command", json={"message": _DOCUMENT_TURN, **_CASE})
    body = r.get_json()

    assert body["actions"] == []
    assert seen["lesion_messages"] == []
    assert "no pancreatic lesion" not in body["reply"].lower()
    assert any(_REPORT in (prompt or "") for prompt in seen["prompts"])


def test_typed_viewer_command_still_acts(client, seen):
    _register(client, email="d3@h.com")
    r = client.post("/api/ai-command-stream", json={"message": "show the coronal view", **_CASE})
    actions = [e for e in _events(r) if e["type"] == "actions"]
    assert actions and {"type": "set_view", "view": "coronal"} in actions[0]["actions"]


_LEGEND = [{"organ": "liver", "color": "brownish red"}]


def test_uploaded_photo_is_not_described_as_a_viewer_pane(client, seen):
    _register(client, email="d4@h.com")
    r = client.post("/api/ai-command-stream", json={
        "message": "which color is this?", "images": [_IMAGE], "uploaded_images": 1,
        "mask_legend": _LEGEND, **_CASE,
    })
    final = [e for e in _events(r) if e["type"] == "final"][0]
    assert final["source"] != "legend"
    prompt = seen["prompts"][-1]
    assert "uploaded by the user" in prompt
    assert "CT viewer screenshot" not in prompt
    assert "Segmentation mask colors" not in prompt


def test_screenshots_keep_their_legend_and_uploads_are_named_separately(client, seen):
    _register(client, email="d5@h.com")
    _events(client.post("/api/ai-command-stream", json={
        "message": "describe these", "images": [_IMAGE, _IMAGE], "uploaded_images": 1,
        "mask_legend": _LEGEND, **_CASE,
    }))
    prompt = seen["prompts"][-1]
    assert "1 CT viewer screenshot(s) are attached" in prompt
    assert "The last 1 image(s) were uploaded by the user" in prompt
    assert "Segmentation mask colors" in prompt


def test_screenshots_alone_read_as_before(client, seen):
    _register(client, email="d6@h.com")
    _events(client.post("/api/ai-command-stream", json={
        "message": "describe these", "images": [_IMAGE], "mask_legend": _LEGEND, **_CASE,
    }))
    prompt = seen["prompts"][-1]
    assert "1 CT viewer screenshot(s) are attached" in prompt
    assert "uploaded by the user" not in prompt
    assert "Segmentation mask colors" in prompt


def test_command_fallback_names_uploads_neutrally(client, seen):
    _register(client, email="d7@h.com")
    client.post("/api/ai-command", json={
        "message": "what does this say?", "images": [_IMAGE], "uploaded_images": 1,
        "mask_legend": _LEGEND, **_CASE,
    })
    prompt = seen["prompts"][-1]
    assert "uploaded by the user" in prompt
    assert "CT viewer screenshot" not in prompt
    assert "Segmentation mask colors" not in prompt


def _system_prompts(monkeypatch):
    import api.api_blueprint as api_bp

    prompts = []

    def answer(**kwargs):
        prompts.append(kwargs.get("system_prompt"))
        yield "content", "It lists a hemoglobin of 13.1."

    monkeypatch.setattr(api_bp, "chat_stream", answer)
    return prompts


def test_upload_only_turn_gets_a_neutral_system_prompt_on_both_routes(client, seen, monkeypatch):
    _register(client, email="d8@h.com")
    prompts = _system_prompts(monkeypatch)
    body = {"message": "what does this say?", "images": [_IMAGE], "uploaded_images": 1,
            "mask_legend": _LEGEND, **_CASE}
    _events(client.post("/api/ai-command-stream", json=body))
    client.post("/api/ai-command", json=body)

    assert len(prompts) == 2
    for prompt in prompts:
        assert "IMAGES ATTACHED BY THE USER" in prompt
        assert "PRIMARY EVIDENCE" not in prompt
        assert "SEGMENTATION MASKS" not in prompt
        assert "Corner letters" not in prompt


def test_screenshots_keep_the_viewer_system_prompt_on_both_routes(client, seen, monkeypatch):
    _register(client, email="d9@h.com")
    prompts = _system_prompts(monkeypatch)
    for images, uploaded in (([_IMAGE], 0), ([_IMAGE, _IMAGE], 1)):
        body = {"message": "describe these", "images": images, "uploaded_images": uploaded,
                "mask_legend": _LEGEND, **_CASE}
        _events(client.post("/api/ai-command-stream", json=body))
        client.post("/api/ai-command", json=body)

    assert len(prompts) == 4
    assert all("SEGMENTATION MASKS" in prompt for prompt in prompts)


def test_system_prompt_flag_defaults_to_the_old_behavior():
    from services import ai_reasoning

    assert ai_reasoning.build_system_prompt(has_images=True) == ai_reasoning.build_system_prompt(
        has_images=True, has_screenshots=True
    )
    assert "SEGMENTATION MASKS" not in ai_reasoning.build_system_prompt(
        has_images=True, has_screenshots=False
    )
    assert "IMAGES ATTACHED" not in ai_reasoning.build_system_prompt(has_images=False)


def test_upload_only_followup_does_not_ask_for_a_ct_slice(client, seen, monkeypatch):
    import api.api_blueprint as api_bp

    _register(client, email="d10@h.com")

    def answer(**kwargs):
        yield "content", "It looks like a lab report. I cannot tell more from the photo."

    monkeypatch.setattr(api_bp, "chat_stream", answer)
    body = {"message": "what does this say about the liver?", "images": [_IMAGE],
            "uploaded_images": 1, **_CASE}
    final = [e for e in _events(client.post("/api/ai-command-stream", json=body)) if e["type"] == "final"][0]
    command = client.post("/api/ai-command", json=body).get_json()

    for reply in (final["reply"], command["reply"]):
        assert "slice" not in reply.lower()


def test_attachment_only_turn_is_not_a_clarification_on_either_route(client, seen):
    _register(client, email="d11@h.com")
    only_document = (
        "[Attached files: report.pdf]\n\n"
        'Content of attached document "report.pdf":\n' + _REPORT
    )
    stream = _events(client.post("/api/ai-command-stream", json={"message": only_document, **_CASE}))
    command = client.post("/api/ai-command", json={"message": only_document, **_CASE}).get_json()

    assert command["intent"] != "clarification_needed"
    assert "type a question" not in command["reply"].lower()
    assert any(_REPORT in (prompt or "") for prompt in seen["prompts"])
    final = [e for e in stream if e["type"] == "final"][0]
    assert final["actions"] == [] and command["actions"] == []
    assert "no pancreatic lesion" not in final["reply"].lower()
    assert "no pancreatic lesion" not in command["reply"].lower()


def test_attachment_only_turn_with_the_model_offline_is_not_a_clarification(client, seen, monkeypatch):
    import api.api_blueprint as api_bp

    _register(client, email="d12@h.com")

    def offline(**kwargs):
        raise RuntimeError("model offline")

    monkeypatch.setattr(api_bp, "chat_json", offline)
    only_document = (
        "[Attached files: report.pdf]\n\n"
        'Content of attached document "report.pdf":\n' + _REPORT
    )
    body = client.post("/api/ai-command", json={"message": only_document, **_CASE}).get_json()

    assert body["intent"] != "clarification_needed"
    assert "type a question" not in body["reply"].lower()
    assert body["actions"] == []
