"""The AI endpoints tell the model about the images it is really sent, and the
non-streaming fallback never points a viewer command at a button that is not there."""

import json

from flask import Flask

from api import api_blueprint as bp
from services import ollama_client


def test_the_intro_counts_only_the_uploads_that_are_sent():
    # Three screenshots then two uploads: the model reads four, so one upload is left.
    body = {"uploaded_images": 2}
    images = bp._ai_cap_images(body, [str(i) for i in range(5)])

    assert len(images) == ollama_client.OLLAMA_MAX_IMAGES
    assert bp._ai_uploaded_count(body, len(images)) == 1
    intro = bp._ai_attachment_intro(len(images), bp._ai_uploaded_count(body, len(images)))
    assert "The last 1 image(s) were uploaded" in intro
    assert "3 CT viewer screenshot(s)" in intro


def test_uploads_pushed_out_entirely_are_not_claimed():
    body = {"uploaded_images": 2}
    images = bp._ai_cap_images(body, [str(i) for i in range(6)])

    assert bp._ai_uploaded_count(body, len(images)) == 0


def test_a_message_within_the_cap_is_left_alone():
    body = {"uploaded_images": 2}
    images = bp._ai_cap_images(body, ["a", "b", "c"])

    assert images == ["a", "b", "c"]
    assert body["uploaded_images"] == 2


def test_the_fallback_endpoint_sends_four_images_and_describes_them_truthfully(monkeypatch):
    seen = {}

    def fake_stream(**kwargs):
        seen.update(kwargs)
        yield "content", "Looks fine."

    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "resolve_vision_model", lambda _model: "vision")
    monkeypatch.setattr(bp, "chat_stream", fake_stream)
    app = Flask(__name__)
    with app.test_request_context(
        "/api/ai-command",
        method="POST",
        json={"message": "What is in these?", "images": [f"data:image/png;base64,{i}" for i in range(5)], "uploaded_images": 2},
    ):
        bp.ai_command()

    assert seen["images"] == ["0", "1", "2", "3"]
    assert "3 CT viewer screenshot(s)" in seen["user_prompt"]
    assert "The last 1 image(s) were uploaded" in seen["user_prompt"]


def _run(monkeypatch, message, chat_json):
    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "chat_json", chat_json)
    app = Flask(__name__)
    with app.test_request_context(
        "/api/ai-command",
        method="POST",
        json={"message": message, "viewer_state": {"zoomLevel": 1, "view": "mpr"}},
    ):
        response = bp.ai_command()
    return response.get_json()


def _model_down(**_kwargs):
    raise ollama_client.OllamaUnavailable("down")


def test_a_viewer_command_fallback_does_not_say_click_below(monkeypatch):
    data = _run(monkeypatch, "zoom in", _model_down)

    assert "Click below" not in data["reply"]
    assert "zoom" in data["reply"].lower()
    assert data["actions"]


def test_an_empty_model_reply_for_a_command_does_not_say_click_below(monkeypatch):
    data = _run(monkeypatch, "switch to coronal view", lambda **_k: {"reply": "", "actions": []})

    assert "Click below" not in data["reply"]
    assert "coronal" in data["reply"].lower()


def test_the_model_reply_still_wins_for_a_command(monkeypatch):
    data = _run(monkeypatch, "zoom in", lambda **_k: {"reply": "Zooming in.", "actions": []})

    assert data["reply"].startswith("Zooming in.")
