"""A reply that the model stream cut off is reported as cut off.

When Ollama dies part-way through an answer the text so far is real, so it is
sent, but the turn must end with an error event rather than a clean final, or
the reader takes half a sentence for the whole answer.
"""

import json

from flask import Flask

from api import api_blueprint as bp
from services import ollama_client


def _events(monkeypatch, chat_stream):
    monkeypatch.setattr(bp, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "_ai_record_answered", lambda _user: None)
    monkeypatch.setattr(bp, "resolve_text_model", lambda _model: "llama3")
    monkeypatch.setattr(bp, "chat_stream", chat_stream)
    monkeypatch.setattr(bp, "chat_with_tools", lambda **_k: (_ for _ in ()).throw(ollama_client.OllamaUnavailable("x")))
    app = Flask(__name__)
    app.add_url_rule("/api/ai-command-stream", view_func=bp.ai_command_stream, methods=["POST"])
    response = app.test_client().post("/api/ai-command-stream", json={"message": "Tell me about the liver."})
    return [json.loads(line) for line in response.get_data(as_text=True).splitlines() if line.strip()]


def test_a_stream_that_dies_part_way_ends_in_an_error_after_the_partial_text(monkeypatch):
    def dying(**_kwargs):
        yield "content", "The liver is the large organ in the upper"
        raise RuntimeError("model runner exited")

    events = _events(monkeypatch, dying)
    kinds = [event["type"] for event in events]
    final = next(event for event in events if event["type"] == "final")

    assert final["reply"] == "The liver is the large organ in the upper"
    assert final["truncated"] is True
    assert kinds[-2:] == ["error", "done"]
    assert kinds.index("final") < kinds.index("error")
    assert events[-2]["message"] == "The answer was cut off."


def test_a_stream_that_finishes_is_not_marked_cut_off(monkeypatch):
    def whole(**_kwargs):
        yield "content", "The liver sits under the diaphragm."

    events = _events(monkeypatch, whole)
    final = next(event for event in events if event["type"] == "final")

    assert final["truncated"] is False
    assert "error" not in [event["type"] for event in events]
