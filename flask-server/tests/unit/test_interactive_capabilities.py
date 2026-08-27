"""/interactive-capabilities: the viewer's attribution line reads the weights
licence from the running model server instead of hardcoding it — a future
checkpoint could ship different terms. The endpoint proxies (and caches) the
model server's /capabilities payload and degrades to available:false."""
from flask import Flask

import api.api_blueprint as api_routes
import services.nninteractive_predictor as predictor


def _get():
    app = Flask(__name__)
    with app.test_request_context("/", method="GET"):
        return api_routes.interactive_capabilities()


def test_reports_the_servers_own_licence(monkeypatch):
    monkeypatch.setattr(predictor, "get_capabilities", lambda: {
        "license": "CC BY-NC-SA 4.0",
        "inference_session_version": "2.5.1",
        "supported_interactions": {"points": True},
    })

    resp = _get()

    body = resp.get_json()
    assert body == {
        "available": True,
        "license": "CC BY-NC-SA 4.0",
        "model_version": "2.5.1",
    }
    assert "max-age=3600" in resp.headers["Cache-Control"]


def test_degrades_cleanly_when_the_model_server_never_answered(monkeypatch):
    monkeypatch.setattr(predictor, "get_capabilities", lambda: None)

    resp = _get()

    assert resp.get_json() == {
        "available": False,
        "license": None,
        "model_version": None,
    }


def test_get_capabilities_caches_and_survives_outages(monkeypatch):
    import requests

    calls = {"n": 0}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"license": "CC BY-NC-SA 4.0"}

    def fake_get(url, headers=None, timeout=None):
        calls["n"] += 1
        if calls["n"] > 1:
            raise requests.ConnectionError("server down")
        return FakeResp()

    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(predictor, "_caps_cache", None)
    monkeypatch.setattr(predictor, "_caps_fetched_at", 0.0)

    first = predictor.get_capabilities()
    assert first["license"] == "CC BY-NC-SA 4.0"
    # Within the TTL nothing refetches.
    assert predictor.get_capabilities() is first
    assert calls["n"] == 1

    # Past the TTL with the server down: the stale payload beats nothing.
    monkeypatch.setattr(predictor, "_caps_fetched_at", -10_000.0)
    assert predictor.get_capabilities()["license"] == "CC BY-NC-SA 4.0"
    assert calls["n"] == 2
