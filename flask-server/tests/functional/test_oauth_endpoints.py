"""Endpoint tests for the OAuth routes.

The provider round-trip itself isn't exercised (that needs real credentials and
a browser), so these cover the parts we own: the providers-discovery endpoint,
unknown-provider handling, and that the app degrades safely when no OAuth
credentials are configured.
"""

import importlib

import pytest


def _make_client(tmp_path, monkeypatch, configured: bool):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'oauth_ep.db'}")
    if configured:
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-google-id")
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-google-secret")
        monkeypatch.setenv("GITHUB_CLIENT_ID", "test-github-id")
        monkeypatch.setenv("GITHUB_CLIENT_SECRET", "test-github-secret")
    else:
        # Empty, not deleted: the constants reload below re-runs load_dotenv,
        # which would refill a *missing* key from a developer's real .env and
        # make this "unconfigured" client look configured. load_dotenv leaves an
        # existing key alone, and "" is falsy to the provider check either way.
        for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
                  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"):
            monkeypatch.setenv(k, "")

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.oauth_identity  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.oauth_blueprint as oauth_mod
    importlib.reload(oauth_mod)

    engine.reset_engine_for_tests()
    engine.create_all()

    from flask import Flask
    app = Flask(__name__)
    app.config["SECRET_KEY"] = "test-secret"
    oauth_mod.init_oauth(app)
    app.register_blueprint(oauth_mod.oauth_blueprint, url_prefix="/api")
    return app.test_client(), engine


@pytest.fixture()
def configured_client(tmp_path, monkeypatch):
    client, engine = _make_client(tmp_path, monkeypatch, configured=True)
    yield client
    engine.reset_engine_for_tests()


@pytest.fixture()
def unconfigured_client(tmp_path, monkeypatch):
    client, engine = _make_client(tmp_path, monkeypatch, configured=False)
    yield client
    engine.reset_engine_for_tests()


def test_providers_reports_configured(configured_client):
    body = configured_client.get("/api/auth/oauth/providers").get_json()
    assert body == {"google": True, "github": True}


def test_providers_reports_unconfigured(unconfigured_client):
    body = unconfigured_client.get("/api/auth/oauth/providers").get_json()
    assert body == {"google": False, "github": False}


def test_start_redirects_to_provider_when_configured(configured_client):
    r = configured_client.get("/api/auth/oauth/google")
    assert r.status_code in (302, 303)
    assert "accounts.google.com" in r.headers["Location"]


def test_start_redirects_with_error_when_not_configured(unconfigured_client):
    """The start link is a full-page navigation, so an unconfigured provider
    bounces back to the page the click came from with a message the popup
    shows, not a JSON body."""
    from urllib.parse import parse_qs, urlparse

    r = unconfigured_client.get("/api/auth/oauth/github?next=%2Fcase%2F35")
    assert r.status_code in (302, 303)
    loc = urlparse(r.headers["Location"])
    assert loc.path == "/case/35"
    assert parse_qs(loc.query)["auth_error"] == ["GitHub sign in isn't available on this site."]


def test_callback_redirects_with_error_when_not_configured(unconfigured_client):
    r = unconfigured_client.get("/api/auth/oauth/google/callback?code=abc")
    assert r.status_code in (302, 303)
    assert "auth_error" in r.headers["Location"]


def test_unknown_provider_404(configured_client):
    assert configured_client.get("/api/auth/oauth/facebook").status_code == 404
    assert configured_client.get("/api/auth/oauth/facebook/callback").status_code == 404


def test_callback_without_state_redirects_with_error(configured_client):
    """A callback with no valid `state` (CSRF check) must not 500 — it bounces
    back to the frontend with an error message."""
    r = configured_client.get("/api/auth/oauth/google/callback?code=abc")
    assert r.status_code in (302, 303)
    assert "auth_error" in r.headers["Location"]


def test_start_accepts_next_and_still_redirects_to_provider(configured_client):
    from urllib.parse import urlparse

    r = configured_client.get("/api/auth/oauth/google?next=%2Fcase%2F35")
    assert r.status_code in (302, 303)
    # Parse the host rather than substring-matching it (a bare `in` check reads
    # as an incomplete URL sanitizer to static analysis).
    assert urlparse(r.headers["Location"]).hostname == "accounts.google.com"


def test_safe_next_only_allows_same_site_relative_paths():
    import api.oauth_blueprint as oauth_mod

    # Kept as-is.
    assert oauth_mod._safe_next("/case/35") == "/case/35"
    assert oauth_mod._safe_next("/session/abc?hd=1#note") == "/session/abc?hd=1#note"
    # Rejected -> "" (falls back to the app root).
    for bad in (
        None, "", "case/35", "//evil.com", "/\\evil.com", "https://evil.com",
        "/%2f%2fevil.com", "/foo\r\nSet-Cookie: x=y", "/" + "a" * 600,
    ):
        assert oauth_mod._safe_next(bad) == "", bad
