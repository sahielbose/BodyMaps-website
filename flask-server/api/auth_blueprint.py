"""Auth + account endpoints. Deliberately kept out of api_blueprint (which pulls
in the heavy nibabel/scipy stack) so the auth surface stays light and testable.

Routes (registered under <BASE_PATH>/api):
  POST   /auth/register   {email, password, name?}  -> creates account, logs in
  POST   /auth/login      {email, password}         -> logs in
  POST   /auth/logout                               -> revokes session
  POST   /auth/redeem-admin-coupon {coupon}         -> grants unlimited plan
  POST   /auth/forgot-password {email}              -> emails a reset link (always 200)
  POST   /auth/reset-password  {token, password}    -> sets a new password, logs in
  GET    /auth/me                                   -> current user + roles (401 if none)
  PATCH  /auth/me         {name?, account_type?}    -> update name / account type
  POST   /me/plan         {plan}                    -> change plan (no payment)
  GET    /me/usage                                  -> plan limits + usage so far
  GET    /me/jobs                                   -> the current user's jobs
  GET    /me/runs                                   -> the current user's Upload page runs
  POST   /me/runs/owned                             -> which of the given session ids are the user's own
  GET    /me/export                                 -> everything we hold, as JSON
  DELETE /me/jobs                                   -> delete scan history, keep account
  DELETE /me                                        -> schedule account deletion
"""

import hashlib
import hmac
import html as _html_mod
import json
import os

from flask import Blueprint, jsonify, make_response, request

from api.auth import (
    COOKIE_NAME, clear_session_cookie, current_user, require_auth, set_session_cookie,
)
from api.rate_limit import Limiter
from services import auth_store, job_store, mailer, plan_store, role_store

auth_blueprint = Blueprint("auth", __name__)

MIN_PASSWORD_LEN = 8

# Both reset endpoints take no auth, and one of them sends mail on demand.
# Without a ceiling, a script can empty a mailbox's sending quota, spam a real
# person's inbox with links they didn't ask for, and grind through reset tokens.
# An hour-long window because asking for a reset is a rare, deliberate act — a
# person doing it legitimately does it once or twice, not ten times.
RESET_WINDOW_S = 3600
RESET_MAX_PER_WINDOW = 10

_reset_limiter = Limiter(RESET_WINDOW_S)

# Verification mail has the same abuse profile as reset mail: a deliberate,
# rare act per person, a spam vector without a ceiling.
_verify_limiter = Limiter(RESET_WINDOW_S)

# Login and register take no auth either. Login is an online password-guessing
# channel (and an argon2 verify per call), so it has two ceilings: one per IP,
# and one per account, because a guesser with many addresses would otherwise
# get a fresh per-IP allowance against the same password each time.
# Register creates an account and sends mail to any address it is given, so it
# gets a per-IP ceiling like the reset endpoints. The per-IP numbers are set
# with a campus NAT in mind, where a whole lab can share one address.
# Only failed sign-ins count, and the right password clears the account's
# count, so a shared lab account or a class behind one NAT is never locked out
# by people signing in successfully.
LOGIN_WINDOW_S = 900
LOGIN_MAX_PER_IP = 60
LOGIN_MAX_PER_EMAIL = 10
REGISTER_WINDOW_S = 3600
REGISTER_MAX_PER_IP = 30

_login_limiter = Limiter(LOGIN_WINDOW_S)
_register_limiter = Limiter(REGISTER_WINDOW_S)

# The access coupon is intentionally checked here, on the server, rather than
# in the model picker.  Keep only a SHA-256 digest in the environment so a
# deployment configuration dump does not reveal the redeemable value.  This
# is an access grant for the unlimited plan, not an admin role grant: the
# latter would also expose the people/analytics administration API.
_ADMIN_COUPON_ENV = "BODYMAPS_ADMIN_COUPON_SHA256"
_COUPON_WINDOW_S = 3600
_COUPON_MAX_ATTEMPTS = 5
_coupon_limiter = Limiter(_COUPON_WINDOW_S)


def _json():
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def _coupon_digest(value: str) -> str:
    """Return the canonical digest for a coupon entered by a user.

    ``encode`` is explicit so this remains stable across Python's locale and
    the comparison below is constant-time.  Length validation happens at the
    route before this helper is called.
    """
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _with_roles(user: dict) -> dict:
    """The user body the client gets, plus the roles it holds.

    Attached here rather than in ``User.to_public_dict`` so the roles query is
    paid on the handful of endpoints that return a user, not on everything that
    resolves a session.
    """
    return {**user, "roles": role_store.roles_for(user["id"])}


def _logged_in_response(user: dict, status: int = 200):
    """JSON user body + a fresh session cookie."""
    raw = auth_store.create_session(user["id"])
    resp = make_response(jsonify({"user": _with_roles(user)}), status)
    return set_session_cookie(resp, raw)


@auth_blueprint.route("/auth/register", methods=["POST"])
def register():
    if _register_limiter.over(request.remote_addr or "unknown", REGISTER_MAX_PER_IP):
        return jsonify({"error": "Too many sign-ups from this network. Try again later."}), 429
    data = _json()
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
    if len(password) < MIN_PASSWORD_LEN:
        return jsonify({
            "error": f"Password must be at least {MIN_PASSWORD_LEN} characters"
        }), 400
    try:
        user = auth_store.create_user(email, password, data.get("name"))
    except auth_store.EmailTakenError:
        return jsonify({"error": "An account with that email already exists"}), 409
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    # Best effort: the account exists either way, and the Settings page can
    # re-send. An unconfigured mailer prints the link to the log (dev flow).
    _send_verification_email(user)
    return _logged_in_response(user, status=201)


@auth_blueprint.route("/auth/login", methods=["POST"])
def login():
    data = _json()
    email = data.get("email") or ""
    ip_key = "ip:" + (request.remote_addr or "unknown")
    email_key = "email:" + str(email).strip().lower()
    if (_login_limiter.at_limit(ip_key, LOGIN_MAX_PER_IP)
            or _login_limiter.at_limit(email_key, LOGIN_MAX_PER_EMAIL)):
        return jsonify({"error": "Too many sign-in attempts. Try again in a few minutes."}), 429
    user = auth_store.authenticate(email, data.get("password") or "")
    if user is None:
        _login_limiter.hit(ip_key)
        _login_limiter.hit(email_key)
        return jsonify({"error": "Invalid email or password"}), 401
    _login_limiter.clear(email_key)
    return _logged_in_response(user)


@auth_blueprint.route("/auth/redeem-admin-coupon", methods=["POST"])
@require_auth
def redeem_admin_coupon():
    """Redeem the deployment's private unlimited-access coupon.

    The coupon is deliberately *not* an ``admin`` role grant.  Admin roles
    control account management and analytics as well as plan limits; handing
    that role out through a shared code would turn a leaked code into a full
    administrative credential.  A successful redemption stores ``enterprise``
    in the account's plan column, so every inference/assistant gate continues
    to make its decision on the server through :mod:`services.plan_store`.

    ``BODYMAPS_ADMIN_COUPON_SHA256`` contains the lower-case SHA-256 digest of
    the coupon.  The plaintext never belongs in the repository or a response.
    The grant is persistent until an administrator changes the account's plan.
    """
    key = request.remote_addr or "unknown"
    if _coupon_limiter.over(key, _COUPON_MAX_ATTEMPTS):
        return jsonify({"error": "Too many coupon attempts. Try again later."}), 429

    expected = (os.environ.get(_ADMIN_COUPON_ENV) or "").strip().lower()
    # A missing or malformed deployment secret is a server configuration error,
    # not an invalid user coupon.  Do not compare against an empty digest.
    if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
        return jsonify({"error": "Admin access coupon is not configured."}), 503

    coupon = _json().get("coupon")
    if not isinstance(coupon, str) or not coupon.strip() or len(coupon) > 256:
        return jsonify({"error": "Enter a valid access coupon."}), 400

    if not hmac.compare_digest(_coupon_digest(coupon.strip()), expected):
        return jsonify({"error": "Invalid access coupon."}), 403

    user = plan_store.set_plan(current_user()["id"], "enterprise")
    if user is None:
        return jsonify({"error": "Account not found"}), 404
    return jsonify({
        "ok": True,
        "access": "admin_coupon",
        "user": _with_roles(user),
    }), 200


@auth_blueprint.route("/auth/logout", methods=["POST"])
def logout():
    auth_store.revoke_session(request.cookies.get(COOKIE_NAME))
    resp = make_response(jsonify({"ok": True}), 200)
    return clear_session_cookie(resp)


# ---- email verification ---------------------------------------------------
#
# Password signups start unverified (OAuth arrives verified when the provider
# says so). Verifying is what, with a complete profile, lifts the account to
# the verified-researcher limits - see services.plan_store.

def _verification_link(raw_token: str) -> str:
    base = (os.environ.get("PUBLIC_BASE_URL") or request.url_root).rstrip("/")
    return f"{base}/verify-email?token={raw_token}"


def _verification_email(name: str | None, link: str) -> tuple[str, str, str]:
    """(subject, text, html) for the verification message."""
    greeting = f"Hi {name}," if name else "Hi,"
    # The name is whatever the registrant typed; escaped, it can't put a link
    # or markup of its own into a real BodyMaps email.
    html_greeting = _html_mod.escape(greeting)
    html_link = _html_mod.escape(link, quote=True)
    hours = auth_store.VERIFY_TTL_MINUTES // 60
    text = (
        f"{greeting}\n\n"
        "Confirm this is your email address to finish setting up your BodyMaps "
        "account:\n\n"
        f"{link}\n\n"
        f"The link works once and expires in {hours} hours.\n\n"
        "If you didn't create a BodyMaps account, you can ignore this email.\n\n"
        "BodyMaps\n"
    )
    html = (
        f"<p>{html_greeting}</p>"
        "<p>Confirm this is your email address to finish setting up your "
        "BodyMaps account:</p>"
        f'<p><a href="{html_link}">Verify your email</a></p>'
        f"<p>The link works once and expires in {hours} hours.</p>"
        "<p>If you didn't create a BodyMaps account, you can ignore this "
        "email.</p>"
        "<p>BodyMaps</p>"
    )
    return "Verify your BodyMaps email", text, html


def _send_verification_email(user: dict) -> bool:
    """Issue a token for the account and mail the link. False when there was
    nothing to send (already verified) or the mailer refused."""
    result = auth_store.create_email_verification(user["id"])
    if result is None:
        return False
    issued, raw_token = result
    subject, text, html = _verification_email(issued.get("name"), _verification_link(raw_token))
    return mailer.send(issued["email"], subject, text, html)


@auth_blueprint.route("/auth/send-verification", methods=["POST"])
@require_auth
def send_verification():
    """(Re)send the verification link for the signed-in account."""
    if _verify_limiter.over(request.remote_addr or "unknown", RESET_MAX_PER_WINDOW):
        return jsonify({"error": "Too many requests. Try again later."}), 429
    user = current_user()
    if user.get("email_verified"):
        return jsonify({"ok": True, "already_verified": True, "sent": False}), 200
    sent = _send_verification_email(user)
    # sent=False with SMTP unconfigured still logged the link server-side; the
    # client copy treats it as "sent" either way, but reports the truth here.
    return jsonify({"ok": True, "already_verified": False, "sent": bool(sent)}), 200


@auth_blueprint.route("/auth/verify-email", methods=["POST"])
def verify_email():
    """Redeem a verification token. Unauthenticated: the link may be opened in
    a browser that has never seen the site - the token itself is the proof."""
    if _verify_limiter.over(request.remote_addr or "unknown", RESET_MAX_PER_WINDOW):
        return jsonify({"error": "Too many requests. Try again later."}), 429
    user = auth_store.verify_email((_json().get("token") or "").strip())
    if user is None:
        return jsonify({
            "error": "This link has expired or has already been used. Ask for a new one from Settings."
        }), 400
    return jsonify({"ok": True, "user": _with_roles(user)}), 200


# ---- password reset -------------------------------------------------------
#
# The pair of endpoints behind "Forgot password?". The first hands out a link,
# the second redeems it. Both are unauthenticated by necessity — the person
# using them is, by definition, the one who can't sign in.

def _reset_link(raw_token: str) -> str:
    """Where the emailed link points.

    PUBLIC_BASE_URL is the same variable the OAuth callback already depends on,
    for the same reason: the server has to state its own public address, because
    request.url_root behind nginx is the proxy hop, not the site.
    """
    base = (os.environ.get("PUBLIC_BASE_URL") or request.url_root).rstrip("/")
    return f"{base}/reset-password?token={raw_token}"


def _reset_email(name: str | None, link: str) -> tuple[str, str, str]:
    """(subject, text, html) for the reset message."""
    greeting = f"Hi {name}," if name else "Hi,"
    html_greeting = _html_mod.escape(greeting)  # see _verification_email
    html_link = _html_mod.escape(link, quote=True)
    minutes = auth_store.RESET_TTL_MINUTES
    text = (
        f"{greeting}\n\n"
        "Someone asked to reset the password for your BodyMaps account. If that "
        "was you, open the link below to choose a new one:\n\n"
        f"{link}\n\n"
        f"The link works once and expires in {minutes} minutes.\n\n"
        "If it wasn't you, you can ignore this email. Nothing has changed and "
        "your current password still works.\n\n"
        "BodyMaps\n"
    )
    html = (
        f"<p>{html_greeting}</p>"
        "<p>Someone asked to reset the password for your BodyMaps account. "
        "If that was you, choose a new one here:</p>"
        f'<p><a href="{html_link}">Reset your password</a></p>'
        f"<p>The link works once and expires in {minutes} minutes.</p>"
        "<p>If it wasn't you, you can ignore this email. Nothing has changed "
        "and your current password still works.</p>"
        "<p>BodyMaps</p>"
    )
    return "Reset your BodyMaps password", text, html


@auth_blueprint.route("/auth/forgot-password", methods=["POST"])
def forgot_password():
    """Email a reset link.

    **Always 200, whatever happens.** Not for tidiness: the response is the only
    thing the caller can observe, so any difference between "sent" and "no such
    account" turns this into a way to test which email addresses have accounts
    here. The same reasoning is why authenticate() verifies against a dummy hash
    for unknown emails. That also means a typo'd address gets the same cheerful
    answer as a real one, which is why the UI says "if an account exists".

    A mail that fails to send is likewise not reported — the user can't fix our
    SMTP config, and the failure is on the server's log where someone can.
    """
    if _reset_limiter.over(request.remote_addr or "unknown", RESET_MAX_PER_WINDOW):
        return jsonify({"error": "Too many requests. Try again later."}), 429

    result = auth_store.create_password_reset((_json().get("email") or "").strip())
    if result is not None:
        user, raw_token = result
        subject, text, html = _reset_email(user.get("name"), _reset_link(raw_token))
        mailer.send(user["email"], subject, text, html)

    return jsonify({"ok": True}), 200


@auth_blueprint.route("/auth/reset-password", methods=["POST"])
def reset_password():
    """Redeem a reset token and sign the user in.

    Signing them in is the point of doing it here rather than bouncing to the
    login form: they have just proved they control the mailbox and chosen a
    password, and asking them to type it again immediately is ceremony.
    """
    if _reset_limiter.over(request.remote_addr or "unknown", RESET_MAX_PER_WINDOW):
        return jsonify({"error": "Too many requests. Try again later."}), 429

    data = _json()
    password = data.get("password") or ""
    if len(password) < MIN_PASSWORD_LEN:
        return jsonify({
            "error": f"Password must be at least {MIN_PASSWORD_LEN} characters"
        }), 400

    user = auth_store.reset_password(data.get("token") or "", password)
    if user is None:
        return jsonify({
            "error": "This link has expired or has already been used. Ask for a new one."
        }), 400
    return _logged_in_response(user)


@auth_blueprint.route("/auth/me", methods=["GET"])
@require_auth
def me():
    return jsonify({"user": _with_roles(current_user())}), 200


@auth_blueprint.route("/auth/me", methods=["PATCH"])
@require_auth
def update_me():
    """Update the display name, the self-reported account type, and/or the
    verified-researcher profile fields (organization, occupation,
    role_description). Any subset may be sent. An empty string clears a field:
    the name falls back to one derived from the email, everything else goes
    back to "not provided"."""
    data = _json()
    profile_patch = {
        key: data.get(key)
        for key in auth_store.PROFILE_FIELD_LIMITS
        if key in data
    }
    if "name" not in data and "account_type" not in data and not profile_patch:
        return jsonify({"error": "Nothing to update"}), 400

    user_id = current_user()["id"]
    user = None

    for key, value in profile_patch.items():
        if value is not None and not isinstance(value, str):
            return jsonify({"error": f"{key} must be text"}), 400
    if profile_patch:
        user = auth_store.update_profile_fields(user_id, profile_patch)

    if "name" in data:
        name = data.get("name")
        if name is not None and not isinstance(name, str):
            return jsonify({"error": "Name must be text"}), 400
        user = auth_store.update_name(user_id, name)

    if "account_type" in data:
        account_type = data.get("account_type")
        if account_type is not None and not isinstance(account_type, str):
            return jsonify({"error": "Account type must be text"}), 400
        try:
            user = auth_store.update_account_type(user_id, account_type)
        except ValueError:
            return jsonify({"error": "Unknown account type"}), 400

    if user is None:
        return jsonify({"error": "Account not found"}), 404
    return jsonify({"user": _with_roles(user)}), 200


@auth_blueprint.route("/me/plan", methods=["POST"])
@require_auth
def set_my_plan():
    """Move to another plan.

    No payment step: pricing hasn't been set, so this is a column write. The
    limits attached to the plan are enforced for real from the next request on.

    The paid plans aren't open yet, so everyone but an admin is held on Free.
    Refused here and not only greyed out in the picker — a disabled button stops
    a click, not a POST.
    """
    plan = (_json().get("plan") or "").strip()
    user_id = current_user()["id"]
    # Only the real, closed plans are refused here; an unknown id falls through
    # to set_plan below and comes back a 400, which is what it is.
    locked = plan in plan_store.PLAN_IDS and plan != plan_store.DEFAULT_PLAN
    if locked and not role_store.has_role(user_id, role_store.ROLE_ADMIN):
        return jsonify({"error": "That plan isn't available yet."}), 403
    try:
        user = plan_store.set_plan(user_id, plan)
    except ValueError:
        return jsonify({"error": "Unknown plan"}), 400
    if user is None:
        return jsonify({"error": "Account not found"}), 404
    return jsonify({"user": _with_roles(user)}), 200


@auth_blueprint.route("/me/usage", methods=["GET"])
@require_auth
def my_usage():
    """Plan, its limits, and what's been used of them in the current window."""
    return jsonify(plan_store.usage_summary(current_user()["id"])), 200


@auth_blueprint.route("/me/jobs", methods=["GET"])
@require_auth
def my_jobs():
    jobs = job_store.list_jobs_for_user(current_user()["id"])
    return jsonify({"jobs": jobs}), 200


@auth_blueprint.route("/me/runs", methods=["GET"])
@require_auth
def my_runs():
    """The signed-in user's own runs from the Upload page, newest first.

    /me/jobs reads the job table, which the path the Upload page uses never
    writes; this reads the per-run records that path keeps. Session id, model,
    status and start time only, capped at job_store.RUN_LIST_LIMIT, so the page
    can show a user's recent scans on a browser that never ran them.
    """
    # Imported here: the inference blueprint is heavy and only this needs it.
    from api.api_blueprint import list_inference_runs_for_user

    return jsonify({"runs": list_inference_runs_for_user(current_user()["id"])}), 200


@auth_blueprint.route("/me/runs/owned", methods=["POST"])
@require_auth
def my_runs_owned():
    """Which of the given session ids are the signed-in user's own.

    Body: {"session_ids": [...]}, at most job_store.OWNED_CHECK_LIMIT. GET
    /me/runs lists only the newest runs, so it cannot say whether an older one
    in a browser is this account's; this answers for exactly the ids asked
    about, by the records deleting the account's history goes by. Only the
    caller's own ids come back, so it says nothing about anyone else's.
    """
    body = request.get_json(silent=True)
    ids = body.get("session_ids") if isinstance(body, dict) else None
    if not isinstance(ids, list) or len(ids) > job_store.OWNED_CHECK_LIMIT:
        return jsonify({"error": f"session_ids must be a list of at most {job_store.OWNED_CHECK_LIMIT} ids"}), 400
    # Imported here: the inference blueprint is heavy and only this needs it.
    from api.api_blueprint import owned_inference_sessions_for_user

    return jsonify({"owned": owned_inference_sessions_for_user(current_user()["id"], ids)}), 200


# The account fields a signed-in user can already see in Settings. Nothing
# internal: no ids, no session or role rows, no job records (real runs never
# write the job table, and its rows carry server paths).
EXPORT_ACCOUNT_FIELDS = (
    "email", "name", "account_type", "plan", "created_at",
    "organization", "occupation", "role_description",
)


@auth_blueprint.route("/me/export", methods=["GET"])
@require_auth
def export_me():
    """A copy of your account details, as a downloadable JSON file.

    Deliberately narrow (see EXPORT_ACCOUNT_FIELDS) and deliberately its own
    endpoint rather than a step inside deletion — wanting a copy of your data
    is not the same as wanting to leave.
    """
    user = current_user()
    account = auth_store.get_user(user["id"]) or {}
    payload = {
        "exported_at": job_store.utcnow().isoformat(),
        "account": {field: account.get(field) for field in EXPORT_ACCOUNT_FIELDS},
    }
    # send as a file rather than a JSON body so the browser saves it directly
    resp = make_response(json.dumps(payload, indent=2, default=str), 200)
    resp.headers["Content-Type"] = "application/json"
    resp.headers["Content-Disposition"] = 'attachment; filename="bodymaps-account.json"'
    return resp


@auth_blueprint.route("/me/jobs", methods=["DELETE"])
@require_auth
def delete_my_jobs():
    """Delete scan history but keep the account."""
    # Imported here: the inference blueprint is heavy and only this needs it.
    from api.api_blueprint import delete_inference_runs_for_user

    user_id = current_user()["id"]
    result = job_store.delete_jobs_for_user(user_id)
    result["runs"] = delete_inference_runs_for_user(user_id)
    return jsonify({"deleted": result}), 200


@auth_blueprint.route("/me", methods=["DELETE"])
@require_auth
def delete_me():
    """Schedule the account for deletion and sign out everywhere.

    Reversible for auth_store.DELETION_GRACE_DAYS: signing back in during that
    window cancels it. The response carries the deadline so the UI can say when.
    """
    result = auth_store.request_deletion(current_user()["id"])
    if result is None:
        return jsonify({"error": "Account not found"}), 404
    resp = make_response(jsonify(result), 200)
    return clear_session_cookie(resp)
