"""Analytics: one write endpoint for the product, one read endpoint for the
internal dashboard.

Routes (registered under <BASE_PATH>/api):
  POST /analytics/collect              {events: [...]}  -> {stored: n}
  GET  /analytics/overview?from&to&... -> aggregates for the dashboard
  GET  /analytics/meta                 -> the filter values the UI offers

/analytics/collect also records where the request came from — the client IP, the
place GeoLite2 resolves it to, and the device class from the User-Agent. All
three are read off the request here, never from the event body, and the stored
IP is served back only through /analytics/overview, which is admin-only.

**The read endpoints need two things: ANALYTICS_DASHBOARD=true, and an admin.**
They report on every account's activity, so one lock is the deploy opting in at
all, and the other is who is asking.

Order matters, and it's why the flag is checked inside the handler rather than
by a decorator above it: with @require_role on top, a deploy that never enabled
analytics would answer 401/403 and confirm the endpoints are there. Flag first
means off is indistinguishable from absent — a 404, because a 403 confirms the
endpoint exists.

Collecting is deliberately NOT gated: the main site should keep recording
whether or not anyone is looking at the dashboard, and the events it writes are
feature names, not content. It is rate-limited per IP instead — see below.
"""

import os
from datetime import datetime, timedelta

from flask import Blueprint, current_app, jsonify, request

from api.auth import current_user, refuse_unless_role
from api.rate_limit import Limiter
from models.job import utcnow
from services import analytics_store, geoip, role_store

analytics_blueprint = Blueprint("analytics", __name__)

DEFAULT_DAYS = 30
MAX_DAYS = 365


# ---- rate limiting ---------------------------------------------------------
#
# /analytics/collect takes no auth by design, so without this anyone can write
# rows into the app's primary database as fast as they can POST — at MAX_BATCH
# per request, that is the cheapest way there is to make the server slower for
# everyone using it.
#
# The counter itself lives in api/rate_limit.py, shared with the password-reset
# endpoints. Going over here costs a dropped batch, not a broken page — the
# client swallows the response either way.

RATE_WINDOW_S = 60
DEFAULT_RATE_MAX = 120

_limiter = Limiter(RATE_WINDOW_S)


def rate_max() -> int:
    """Read live, like ANALYTICS_DASHBOARD: tunable without a code change, and
    settable to 0 to turn the limit off entirely."""
    raw = os.environ.get("ANALYTICS_RATE_LIMIT_PER_MIN")
    if not raw:
        return DEFAULT_RATE_MAX
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_RATE_MAX


def _over_rate_limit(ip: str) -> bool:
    """Count this request against `ip`'s window. True if it should be refused."""
    return _limiter.over(ip, rate_max())


def _dashboard_enabled() -> bool:
    """Read live rather than at import: tests flip it per-case, and it means a
    restart is enough to turn the dashboard off."""
    return os.environ.get("ANALYTICS_DASHBOARD", "false").lower() == "true"


@analytics_blueprint.route("/analytics/collect", methods=["POST"])
def collect():
    """Take a batch of events. Anonymous is fine — signed-out visitors are half
    the point — so there's no require_auth here; the session cookie is read only
    to attribute the batch when one happens to be present.

    Always 200 with a count. A tracking call must never surface as an error in
    the app it is measuring, so a batch that is entirely junk is a stored:0, not
    a 400. A rate-limited caller is the one exception: 429 is the honest answer,
    and the client discards it like any other failed flush.
    """
    if _over_rate_limit(request.remote_addr or "unknown"):
        return jsonify({"stored": 0, "error": "Too many requests"}), 429

    raw_body = request.get_json(silent=True)
    body = raw_body if isinstance(raw_body, dict) else {}
    user = current_user()

    # Resolved once for the whole batch rather than per event: one request comes
    # from one address on one device, and the mmdb read (plus its cache lookup)
    # has no business running twenty times for twenty clicks in one flush.
    ip = request.remote_addr
    try:
        stored = analytics_store.record_events(
            body.get("events"),
            user_id=user["id"] if user else None,
            ip=ip,
            geo=geoip.lookup(ip),
            device=geoip.device_type(request.headers.get("User-Agent")),
        )
    except Exception:
        # Storage trouble (e.g. a database whose migrations haven't run) must
        # honor the never-error contract above rather than 500 on every page
        # view of the app being measured.
        current_app.logger.exception("analytics collect failed; dropping batch")
        return jsonify({"stored": 0}), 200
    return jsonify({"stored": stored}), 200


def _parse_range():
    """(start, end) from ?from=&to= ISO dates, defaulting to the last 30 days.

    `to` is inclusive of the whole day: a range picker that says 1st-8th should
    include everything that happened on the 8th.

    ?range=all is "ever": it starts at the oldest event rather than at a made-up
    epoch, so the range echoed back in the response describes real data, and it
    skips the MAX_DAYS clamp — that clamp exists to bound an accidental huge
    range, not to refuse a deliberate one.
    """
    now = utcnow()
    end = now
    start = now - timedelta(days=DEFAULT_DAYS)

    if request.args.get("range") == "all":
        return (analytics_store.earliest_event() or start), end

    raw_from = request.args.get("from")
    raw_to = request.args.get("to")
    try:
        if raw_from:
            start = datetime.fromisoformat(raw_from)
        if raw_to:
            end = datetime.fromisoformat(raw_to) + timedelta(days=1)
    except ValueError:
        return None, None

    if end <= start:
        return None, None
    if end - start > timedelta(days=MAX_DAYS):
        start = end - timedelta(days=MAX_DAYS)
    return start, end


@analytics_blueprint.route("/analytics/overview", methods=["GET"])
def overview():
    if not _dashboard_enabled():
        return jsonify({"error": "Not found"}), 404
    refusal = refuse_unless_role(role_store.ROLE_ADMIN)
    if refusal:
        return refusal

    start, end = _parse_range()
    if start is None:
        return jsonify({"error": "Invalid date range"}), 400

    audience = request.args.get("audience") or analytics_store.AUDIENCE_ALL
    if audience not in (
        analytics_store.AUDIENCE_ALL,
        analytics_store.AUDIENCE_SIGNED_IN,
        analytics_store.AUDIENCE_ANONYMOUS,
    ):
        return jsonify({"error": "Invalid audience"}), 400

    # Upper-cased and length-checked rather than validated against a country
    # list: the stored codes come from GeoLite2, and an unknown one is an empty
    # result, not an error worth its own message.
    country = (request.args.get("country") or "").strip().upper() or None
    if country and len(country) != 2:
        return jsonify({"error": "Country must be a two-letter code"}), 400

    return jsonify(analytics_store.overview(
        start, end,
        plan=request.args.get("plan") or None,
        account_type=request.args.get("account_type") or None,
        audience=audience,
        country=country,
    )), 200


@analytics_blueprint.route("/analytics/meta", methods=["GET"])
def meta():
    """The filter values the dashboard offers, so its dropdowns come from the
    server's idea of the world rather than a second hardcoded copy."""
    if not _dashboard_enabled():
        return jsonify({"error": "Not found"}), 404
    refusal = refuse_unless_role(role_store.ROLE_ADMIN)
    if refusal:
        return refusal

    from services.plan_store import PLAN_IDS
    return jsonify({
        "plans": list(PLAN_IDS),
        "account_types": ["patient", "clinician", "researcher", "student"],
        "audiences": [
            analytics_store.AUDIENCE_ALL,
            analytics_store.AUDIENCE_SIGNED_IN,
            analytics_store.AUDIENCE_ANONYMOUS,
        ],
        "action_names": sorted(analytics_store.ACTION_NAMES),
        "routes": sorted(analytics_store.ROUTE_PATTERNS),
    }), 200
