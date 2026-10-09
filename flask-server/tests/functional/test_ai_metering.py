"""The assistant spends the daily allowance only when a turn answers.

One typed question can reach the server more than once: the capture follow-up,
the non-streaming fallback after a failed stream, and Try again. Usage used to
be recorded on entry, so each of those cost a message and a failed send cost
one too. Now a message is counted when the model answered.

Same import caveat as test_guest_gating.py: api.api_blueprint has import-time
side effects, so run this file as its own pytest process.
"""

import importlib
import json
import os

import pytest


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    base = tmp_path_factory.mktemp("ai_metering")
    for var, sub in [
        ("DATABASE_URL", None),
        ("PANTS_PATH", "data"),
        ("PANTS_LOWRES_PATH", "lowres"),
        ("PERMISSIONS_DIR", "perm"),
        ("BODYMAPS_UPLOAD_CHUNK_DIR", "chunks"),
    ]:
        value = f"sqlite:///{base / 'am.db'}" if sub is None else str(base / sub)
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




def _used(user_id):
    import services.plan_store as plan_store

    return plan_store.usage_summary(user_id)["ai_messages"]["used"]


def _events(response):
    return [json.loads(line) for line in response.get_data(as_text=True).splitlines() if line.strip()]


def test_empty_message_is_not_metered(client):
    user_id = _register(client, email="m1@h.com")
    r = client.post("/api/ai-command", json={"message": "   "})
    assert r.status_code == 400
    assert _used(user_id) == 0


def test_offline_model_is_not_metered_on_either_endpoint(client, app, monkeypatch):
    import api.api_blueprint as api_bp

    def offline(**kwargs):
        raise api_bp.OllamaUnavailable("down")

    monkeypatch.setattr(api_bp, "chat_json", offline)
    monkeypatch.setattr(api_bp, "chat_stream", offline)
    user_id = _register(client, email="m2@h.com")

    r = client.post("/api/ai-command", json={"message": "Tell me about this scan"})
    assert r.status_code == 200
    assert r.get_json()["source"] == "rule_fallback"
    r = client.post("/api/ai-command-stream", json={"message": "Tell me about this scan"})
    assert _events(r)[-2]["source"] == "rule_fallback"
    assert _used(user_id) == 0


def test_answered_turn_is_metered_once(client, monkeypatch):
    import api.api_blueprint as api_bp

    def answer(**kwargs):
        yield "content", "The scan shows a pancreas."

    def answer_json(**kwargs):
        return {"reply": "The scan shows a pancreas.", "actions": [], "intent": "chat"}

    monkeypatch.setattr(api_bp, "chat_stream", answer)
    monkeypatch.setattr(api_bp, "chat_json", answer_json)
    user_id = _register(client, email="m3@h.com")

    r = client.post("/api/ai-command-stream", json={"message": "Tell me about this scan"})
    final = [e for e in _events(r) if e["type"] == "final"][0]
    assert final["source"] == "ollama"
    assert _used(user_id) == 1

    r = client.post("/api/ai-command", json={"message": "Tell me about this scan"})
    assert r.get_json()["source"] == "ollama"
    assert _used(user_id) == 2


_IMAGE = "data:image/png;base64,iVBORw0KGgo="


def test_capture_turn_is_free_and_its_followup_costs_one(client, monkeypatch):
    import api.api_blueprint as api_bp

    def ask_for_capture(**kwargs):
        return {"content": "", "tool_calls": [
            {"function": {"name": "capture_views", "arguments": {}}},
        ]}

    def answer(**kwargs):
        yield "content", "The views show a pancreas."

    monkeypatch.setattr(api_bp, "chat_with_tools", ask_for_capture)
    monkeypatch.setattr(api_bp, "chat_stream", answer)
    monkeypatch.setattr(api_bp, "resolve_vision_model", lambda *a, **k: "vision-test")
    user_id = _register(client, email="m4@h.com")
    body = {"message": "What do you see in this scan?", "session_id": "1", "can_capture": True}

    r = client.post("/api/ai-command-stream", json=body)
    assert "need_capture" in [e["type"] for e in _events(r)]
    assert _used(user_id) == 0

    r = client.post("/api/ai-command-stream", json={
        **body, "auto_captured": True, "images": [_IMAGE],
    })
    final = [e for e in _events(r) if e["type"] == "final"][0]
    assert final["source"] == "ollama"
    assert _used(user_id) == 1


def test_stream_with_images_is_metered_once(client, monkeypatch):
    import api.api_blueprint as api_bp

    def answer(**kwargs):
        yield "content", "The axial view shows the liver."

    monkeypatch.setattr(api_bp, "chat_stream", answer)
    monkeypatch.setattr(api_bp, "resolve_vision_model", lambda *a, **k: "vision-test")
    user_id = _register(client, email="m5@h.com")

    r = client.post("/api/ai-command-stream", json={
        "message": "Describe the views", "images": [_IMAGE],
    })
    assert [e for e in _events(r) if e["type"] == "final"][0]["source"] == "ollama"
    assert _used(user_id) == 1


def test_vision_reply_is_metered_once_and_offline_is_free(client, monkeypatch):
    import api.api_blueprint as api_bp

    def answer(**kwargs):
        yield "content", "The axial view shows the liver."

    def offline(**kwargs):
        raise api_bp.OllamaUnavailable("down")
        yield  # pragma: no cover

    monkeypatch.setattr(api_bp, "resolve_vision_model", lambda *a, **k: "vision-test")
    user_id = _register(client, email="m6@h.com")
    body = {"message": "Describe the views", "images": [_IMAGE]}

    monkeypatch.setattr(api_bp, "chat_stream", offline)
    r = client.post("/api/ai-command", json=body)
    assert r.get_json()["source"] == "rule_fallback"
    assert _used(user_id) == 0

    monkeypatch.setattr(api_bp, "chat_stream", answer)
    r = client.post("/api/ai-command", json=body)
    assert r.get_json()["source"] == "ollama"
    assert _used(user_id) == 1


def test_stream_closed_after_first_text_is_still_metered(client, monkeypatch):
    import api.api_blueprint as api_bp

    def answer(**kwargs):
        yield "content", "The scan shows "
        yield "content", "a pancreas."

    monkeypatch.setattr(api_bp, "chat_stream", answer)
    user_id = _register(client, email="m7@h.com")

    r = client.post("/api/ai-command-stream", json={"message": "Tell me about this scan"},
                    buffered=False)
    chunks = r.response
    next(chunks)
    while True:
        line = next(chunks)
        if b'"reply"' in line:
            break
    # The client drops the connection before the final event.
    r.close()
    assert _used(user_id) == 1


def test_offline_final_is_not_grounded_without_facts(client, monkeypatch):
    import api.api_blueprint as api_bp

    def offline(**kwargs):
        raise api_bp.OllamaUnavailable("down")
        yield  # pragma: no cover

    monkeypatch.setattr(api_bp, "chat_stream", offline)
    _register(client, email="m8@h.com")
    r = client.post("/api/ai-command-stream", json={"message": "Tell me about this scan"})
    final = [e for e in _events(r) if e["type"] == "final"][0]
    assert final["source"] == "rule_fallback"
    assert final["grounded"] is False


def test_command_offline_reply_says_whether_it_is_grounded(client, monkeypatch):
    import api.api_blueprint as api_bp

    def offline(**kwargs):
        raise api_bp.OllamaUnavailable("down")
        yield  # pragma: no cover

    def offline_json(**kwargs):
        raise api_bp.OllamaUnavailable("down")

    monkeypatch.setattr(api_bp, "chat_json", offline_json)
    monkeypatch.setattr(api_bp, "chat_stream", offline)
    monkeypatch.setattr(api_bp, "resolve_vision_model", lambda *a, **k: "vision-test")
    _register(client, email="m9@h.com")

    # Nothing measured and no viewer action: the browser offers Try again.
    r = client.post("/api/ai-command", json={"message": "Tell me about this scan"})
    assert r.get_json()["source"] == "rule_fallback"
    assert r.get_json()["grounded"] is False

    # A views question with the model offline has no answer either.
    r = client.post("/api/ai-command", json={"message": "Describe the views", "images": [_IMAGE]})
    assert r.get_json()["source"] == "rule_fallback"
    assert r.get_json()["grounded"] is False

    # A viewer action that still ran is an answer, so it is not retried.
    r = client.post("/api/ai-command", json={
        "message": "Hide the liver", "available_organs": ["liver"],
    })
    body = r.get_json()
    assert body["source"] == "rule_fallback"
    assert body["actions"]
    assert body["grounded"] is True


def test_command_answered_by_the_model_is_not_marked_grounded(client, monkeypatch):
    import api.api_blueprint as api_bp

    monkeypatch.setattr(api_bp, "chat_json", lambda **k: {
        "reply": "The scan shows a pancreas.", "actions": [], "intent": "chat",
    })
    _register(client, email="m10@h.com")
    r = client.post("/api/ai-command", json={"message": "Tell me about this scan"})
    assert r.get_json()["source"] == "ollama"
    assert r.get_json()["grounded"] is False


def test_image_only_message_reaches_the_vision_reply_on_the_fallback_route(client, monkeypatch):
    import api.api_blueprint as api_bp

    # The stream route takes a message with only screenshots; the fallback the
    # browser retries on must not refuse it with the empty-message 400.
    monkeypatch.setattr(api_bp, "resolve_vision_model", lambda *_: None)
    _register(client, email="m11@h.com")

    r = client.post("/api/ai-command", json={"message": "", "images": ["data:image/png;base64,AAAA"]})
    assert r.status_code == 200
    assert r.get_json()["source"] == "vision_model_unavailable"

    r = client.post("/api/ai-command", json={"message": "", "images": []})
    assert r.status_code == 400


def test_history_turn_with_a_document_keeps_its_text():
    import api.api_blueprint as api_bp

    document = 'Question\n\nContent of attached document "a.pdf":\n' + "x" * 6000
    turns = api_bp._ai_normalize_conversation([
        {"role": "user", "content": document},
        {"role": "assistant", "content": "y" * 5000},
        {"role": "user", "content": "z" * 5000},
    ])
    assert len(turns[0]["content"]) == len(document)
    assert len(turns[1]["content"]) == 2000
    assert len(turns[2]["content"]) == 2000


def test_history_window_keeps_the_document_turn_in_a_long_thread():
    import api.api_blueprint as api_bp

    document = {"role": "user", "content": 'Q\n\nContent of attached document "a.pdf":\nTable two'}
    thread = [document] + [
        {"role": "assistant" if i % 2 else "user", "content": f"turn {i}"} for i in range(1, 9)
    ]
    window = api_bp._ai_history_window(thread)
    assert window[0] is document
    assert len(window) == 7
    # Nothing to add when the document turn is still inside the window.
    assert api_bp._ai_history_window(thread[:4]) == thread[:4]
