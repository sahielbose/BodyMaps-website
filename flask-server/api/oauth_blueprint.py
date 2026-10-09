"""Google + GitHub OAuth sign-in (B2).

Flow (standard authorization-code, secret stays server-side):
  1. Browser hits  GET /api/auth/oauth/<provider>            -> 302 to provider
  2. User approves at the provider
  3. Provider redirects to GET /api/auth/oauth/<provider>/callback
  4. We exchange the code, read the profile, resolve/link the account,
     set the same session cookie the password flow uses, and 302 back to the
     frontend.

CSRF is handled by Authlib's `state` parameter, which it stores in the Flask
session — hence SECRET_KEY being required (see app.py). Providers are only
registered when their client id/secret are configured, so the app runs fine
without OAuth set up; /api/auth/oauth/providers tells the frontend which
buttons to show.
"""

import os
from urllib.parse import urlencode, urljoin

from authlib.integrations.flask_client import OAuth
from flask import Blueprint, jsonify, redirect, request, session

from api.auth import set_session_cookie
from services import auth_store

oauth_blueprint = Blueprint("oauth", __name__)

oauth = OAuth()

# Where to send the browser after the callback finishes. Same-origin in prod
# (frontend + API are served together); localhost:5173 in dev.
def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:5173")


# The provider matches redirect_uri as an exact string, so it has to be the
# app's real public origin. Deriving it from the request means trusting the
# proxy chain to report scheme/host correctly, which isn't always in our
# control — an nginx that rewrites X-Forwarded-Proto yields http:// and every
# sign-in fails. Set PUBLIC_BASE_URL in production to state it outright;
# unset, we fall back to the request (correct for local dev).
def _callback_url(provider: str) -> str:
    base = os.environ.get("PUBLIC_BASE_URL") or request.url_root
    return urljoin(base.rstrip("/") + "/", f"api/auth/oauth/{provider}/callback")


def _provider_configured(provider: str) -> bool:
    return bool(
        os.environ.get(f"{provider.upper()}_CLIENT_ID")
        and os.environ.get(f"{provider.upper()}_CLIENT_SECRET")
    )


# The page the user was on when they hit "sign in" — round-tripped through the
# Flask session (NOT a query param on the provider redirect, which the provider
# would drop) so the callback can send them back there instead of to the app
# root. Must be a same-site relative path: reject anything with a scheme, a
# "//host" form, backslashes, or control chars so this can't become an open
# redirect / header-injection vector.
def _safe_next(raw: str | None) -> str:
    if not raw or len(raw) > 512:
        return ""
    if not raw.startswith("/") or raw.startswith(("//", "/\\", "/%2f", "/%2F")):
        return ""
    if any(c in raw for c in "\r\n\t") or any(ord(c) < 0x20 for c in raw):
        return ""
    return raw


def _frontend_redirect(next_path: str, extra_query: dict | None = None):
    """Bounce back to the frontend, honoring a stashed same-site `next` path."""
    target = _frontend_url().rstrip("/") + (next_path or "/")
    if extra_query:
        target = f"{target}{'&' if '?' in target else '?'}{urlencode(extra_query)}"
    return redirect(target)


def init_oauth(app):
    """Register providers that have credentials configured. Called from app.py."""
    oauth.init_app(app)

    if _provider_configured("google"):
        oauth.register(
            name="google",
            client_id=os.environ["GOOGLE_CLIENT_ID"],
            client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
            # Discovery doc gives us endpoints + JWKS for id_token validation.
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )

    if _provider_configured("github"):
        oauth.register(
            name="github",
            client_id=os.environ["GITHUB_CLIENT_ID"],
            client_secret=os.environ["GITHUB_CLIENT_SECRET"],
            access_token_url="https://github.com/login/oauth/access_token",
            authorize_url="https://github.com/login/oauth/authorize",
            api_base_url="https://api.github.com/",
            client_kwargs={"scope": "read:user user:email"},
        )


def _redirect_with_error(message: str):
    """Bounce back to the frontend with an error the UI can surface — back to
    the page the sign-in was started from, if one was stashed."""
    next_path = _safe_next(session.pop("oauth_next", None))
    return _frontend_redirect(next_path, {"auth_error": message})


@oauth_blueprint.route("/auth/oauth/providers", methods=["GET"])
def providers():
    """Which providers are usable — lets the frontend enable/disable buttons."""
    return jsonify({
        "google": _provider_configured("google"),
        "github": _provider_configured("github"),
    }), 200


def _not_configured_redirect(provider: str):
    """A browser navigation can't show a JSON body, so a provider this site has
    no credentials for goes back to the page with a message the popup shows."""
    label = "GitHub" if provider == "github" else "Google"
    return _redirect_with_error(f"{label} sign in isn't available on this site.")


@oauth_blueprint.route("/auth/oauth/<provider>", methods=["GET"])
def oauth_start(provider):
    if provider not in ("google", "github"):
        return jsonify({"error": "Unknown provider"}), 404

    # Remember where to return the browser after the callback. Stored in the
    # Flask session (same place Authlib keeps its `state`) so it survives the
    # provider round-trip; sanitized on the way back out in the callback.
    session["oauth_next"] = _safe_next(request.args.get("next"))

    if not _provider_configured(provider):
        return _not_configured_redirect(provider)

    client = oauth.create_client(provider)
    return client.authorize_redirect(_callback_url(provider))


@oauth_blueprint.route("/auth/oauth/<provider>/callback", methods=["GET"])
def oauth_callback(provider):
    if provider not in ("google", "github"):
        return jsonify({"error": "Unknown provider"}), 404
    if not _provider_configured(provider):
        return _not_configured_redirect(provider)

    client = oauth.create_client(provider)
    try:
        token = client.authorize_access_token()  # also validates `state`
    except Exception as e:
        print(f"[oauth] {provider} token exchange failed: {e}")
        return _redirect_with_error("Sign-in was cancelled or failed. Please try again.")

    try:
        if provider == "google":
            profile = _google_profile(token)
        else:
            profile = _github_profile(client)
    except Exception as e:
        print(f"[oauth] {provider} profile fetch failed: {e}")
        return _redirect_with_error("Couldn't read your profile from the provider.")

    try:
        user = auth_store.upsert_oauth_user(
            provider=provider,
            provider_user_id=profile["id"],
            email=profile["email"],
            email_verified=profile["email_verified"],
        )
    except auth_store.OAuthLinkRefusedError as e:
        return _redirect_with_error(str(e))
    except Exception as e:
        print(f"[oauth] {provider} account resolution failed: {e}")
        return _redirect_with_error("Could not complete sign-in. Please try again.")

    raw = auth_store.create_session(user["id"])
    next_path = _safe_next(session.pop("oauth_next", None))
    resp = _frontend_redirect(next_path)
    return set_session_cookie(resp, raw)


def _google_profile(token) -> dict:
    """Google returns an OIDC id_token; Authlib validated it during exchange."""
    claims = token.get("userinfo") or {}
    return {
        "id": claims.get("sub"),
        "email": claims.get("email") or "",
        "email_verified": bool(claims.get("email_verified")),
    }


def _github_profile(client) -> dict:
    """GitHub has no OIDC id_token: read /user, then /user/emails for the
    verified primary address (the /user payload's email can be null or an
    unverified public address)."""
    profile = client.get("user").json()
    email, verified = "", False
    try:
        for entry in client.get("user/emails").json():
            if entry.get("primary"):
                email = entry.get("email") or ""
                verified = bool(entry.get("verified"))
                break
    except Exception:
        # Falls back to the public profile email, which we treat as unverified.
        email, verified = profile.get("email") or "", False
    return {"id": str(profile.get("id") or ""), "email": email, "email_verified": verified}
