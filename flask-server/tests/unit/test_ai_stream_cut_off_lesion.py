"""A cut-off reply is still checked against the measured lesion state.

A fabricated tumour is the worst output the assistant can emit, so a stream that
dies after "There is a pancreatic lesion in the head" must not leave that claim
on screen. The reply is replaced, but the turn is still reported as cut off.
"""

import json

from flask import Flask

from api import api_blueprint as bp
from services import ollama_client

SESSION = "11111111-2222-3333-4444-555555555555"


def _events(monkeypatch, chat_stream, lesion_ctx):
    monkeypatch.setattr(bp, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "_ai_record_answered", lambda _user: None)
    monkeypatch.setattr(
        bp, "_get_inference_job", lambda sid: {"user_id": "owner", "status": "completed"}
    )
    monkeypatch.setattr(bp, "_ai_load_metrics", lambda case_id, supplied: ([], "none"))
    monkeypatch.setattr(bp, "_ai_metadata", lambda case_id, demographics: {})
    monkeypatch.setattr(bp, "_ai_lesion_context", lambda case_id, message: lesion_ctx)
    monkeypatch.setattr(bp, "resolve_text_model", lambda _model: "llama3")
    monkeypatch.setattr(bp, "chat_stream", chat_stream)
    monkeypatch.setattr(
        bp, "chat_with_tools",
        lambda **_k: (_ for _ in ()).throw(ollama_client.OllamaUnavailable("x")),
    )
    app = Flask(__name__)
    app.add_url_rule("/api/ai-command-stream", view_func=bp.ai_command_stream, methods=["POST"])
    response = app.test_client().post(
        "/api/ai-command-stream",
        json={"message": "Is there a pancreatic lesion?", "session_id": SESSION},
    )
    return [json.loads(line) for line in response.get_data(as_text=True).splitlines() if line.strip()]


def _dying(**_kwargs):
    yield "content", "There is a pancreatic lesion in the head"
    raise RuntimeError("model runner exited")


def _ctx(absent, present):
    return {"available": True, "absent": absent, "present": present, "facts": [], "summary": ""}


def test_a_cut_off_lesion_claim_against_a_measured_absence_is_replaced(monkeypatch):
    events = _events(monkeypatch, _dying, _ctx(["pancreatic lesion"], []))
    kinds = [event["type"] for event in events]
    final = next(event for event in events if event["type"] == "final")

    assert "There is no pancreatic lesion in this case" in final["reply"]
    assert "lesion in the head" not in final["reply"]
    assert final["truncated"] is True
    assert kinds[-2:] == ["error", "done"]


def test_a_cut_off_reply_that_agrees_with_the_measurement_is_left_as_it_stands(monkeypatch):
    events = _events(monkeypatch, _dying, _ctx([], ["pancreatic lesion"]))
    final = next(event for event in events if event["type"] == "final")

    assert final["reply"] == "There is a pancreatic lesion in the head"
    assert final["truncated"] is True
