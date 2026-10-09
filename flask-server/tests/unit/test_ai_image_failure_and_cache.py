"""Offline wording for uploaded photos, the stream fallback's history, and the metrics cache.

A photo or report the person uploaded is not a CT pane, so the offline reply must
not talk about views or ask for a re-capture. The non-streaming fallback must see
the earlier turns, like the stream. Numbers the browser sends are never stored
where another user's question would read them.
"""

import json

from flask import Flask

import services.ai_reasoning as ai_reasoning
from api import api_blueprint as bp


def test_an_uploaded_photo_failure_does_not_mention_panes_or_views():
    reply = ai_reasoning.model_offline_reply(has_images=True, only_uploads=True)

    assert "panes" not in reply
    assert "views" not in reply
    assert "re-capture" not in reply
    assert "images" in reply


def test_a_capture_failure_still_offers_the_recapture():
    reply = ai_reasoning.model_offline_reply(has_images=True)

    assert "re-capture the panes" in reply


def test_a_missing_vision_model_names_images_for_an_upload():
    reply = ai_reasoning.model_offline_reply(
        has_images=True, vision_model_missing=True, only_uploads=True
    )

    assert "attached images" in reply
    assert "views" not in reply


def _run_ai_command(monkeypatch, payload):
    seen = {}

    def fake_chat_json(**kwargs):
        seen["prompt"] = json.loads(kwargs["user_prompt"])
        return {"reply": "ok", "actions": []}

    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "chat_json", fake_chat_json)
    app = Flask(__name__)
    with app.test_request_context("/api/ai-command", method="POST", json=payload):
        bp.ai_command()
    return seen["prompt"]


def test_the_fallback_endpoint_sends_the_earlier_turns_to_the_model(monkeypatch):
    prompt = _run_ai_command(
        monkeypatch,
        {
            "message": "and its mean HU?",
            "conversation": [
                {"role": "user", "content": "what is the liver volume?"},
                {"role": "assistant", "content": "The liver is 1200 cm3."},
            ],
        },
    )

    assert prompt["recent_conversation"] == [
        {"role": "user", "content": "what is the liver volume?"},
        {"role": "assistant", "content": "The liver is 1200 cm3."},
    ]


def test_the_fallback_endpoint_tolerates_a_missing_conversation(monkeypatch):
    prompt = _run_ai_command(monkeypatch, {"message": "what is a CT scan?"})

    assert prompt["recent_conversation"] == []


def _clear_cache():
    bp._AI_METRICS_CACHE.clear()


def test_browser_supplied_metrics_are_not_cached_for_the_case(monkeypatch):
    _clear_cache()
    monkeypatch.setattr(bp, "get_mask_data_internal", lambda case_id: {"error": "no data"})
    monkeypatch.setattr(bp, "_ai_compute_organ_metrics_from_labels", lambda case_id: None)
    forged = [{"organ_name": "liver", "volume_cm3": 1}]

    first, source = bp._ai_load_metrics("5", forged)
    assert source == "frontend_supplied_metrics"
    assert first[0]["volume_cm3"] == 1

    # Another user asks about the same case with their own (real) numbers.
    second, _source = bp._ai_load_metrics("5", [{"organ_name": "liver", "volume_cm3": 1200}])
    assert second[0]["volume_cm3"] == 1200
    assert "5" not in bp._AI_METRICS_CACHE


def test_an_unsafe_case_id_never_enters_the_cache():
    _clear_cache()
    bp._ai_load_metrics("../etc/passwd", [{"organ_name": "liver", "volume_cm3": 1}])
    bp._ai_load_metrics("x" * 500 + "?", [{"organ_name": "liver", "volume_cm3": 1}])

    assert len(bp._AI_METRICS_CACHE) == 0


def test_server_computed_metrics_are_cached_and_the_cache_is_bounded(monkeypatch):
    _clear_cache()
    calls = []

    def compute(case_id):
        calls.append(case_id)
        return {"organ_metrics": [{"organ_name": "liver", "volume_cm3": 1200}]}

    monkeypatch.setattr(bp, "get_mask_data_internal", compute)
    monkeypatch.setattr(bp, "_ai_metrics_stamp", lambda identifier: 1.0, raising=False)

    bp._ai_load_metrics("7", None)
    bp._ai_load_metrics("7", None)
    assert calls == ["7"]

    for number in range(100, 100 + getattr(bp, "_AI_METRICS_CACHE_MAX", 64) + 10):
        bp._ai_load_metrics(str(number), None)
    assert len(bp._AI_METRICS_CACHE) == getattr(bp, "_AI_METRICS_CACHE_MAX", 64)


def test_a_reprocessed_scan_is_recomputed(monkeypatch):
    _clear_cache()
    calls = []

    def compute(case_id):
        calls.append(case_id)
        return {"organ_metrics": [{"organ_name": "liver", "volume_cm3": 1200 + len(calls)}]}

    stamp = {"value": 1.0}
    monkeypatch.setattr(bp, "get_mask_data_internal", compute)
    monkeypatch.setattr(bp, "_ai_metrics_stamp", lambda identifier: stamp["value"], raising=False)

    bp._ai_load_metrics("9", None)
    stamp["value"] = 2.0
    metrics, _source = bp._ai_load_metrics("9", None)

    assert len(calls) == 2
    assert metrics[0]["volume_cm3"] == 1202
