"""Product analytics: recording tracked events, and the aggregates the
dashboard reads back.

The single seam for the ``analytics_event`` table — nothing else writes to it or
queries it.

Two rules shape everything here:

1. **The client is not trusted.** It says what happened and when; the server
   decides who it belongs to. ``plan`` and ``account_type`` are read from the
   account, never from the request body, and timestamps are clamped to a sane
   window so a wrong clock (or a hand-crafted POST) can't park rows in 2041.

2. **Cardinality is bounded on the way in.** Event names and routes are checked
   against the lists below and anything unrecognised is dropped. That keeps a
   case id or a filename from ever reaching this table — the events describe
   which feature was used, not what it was used on — and it keeps "top features"
   a list of features rather than a list of typos.
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, delete, distinct, func, select

from models.analytics_event import KIND_ACTION, KIND_PAGE_VIEW, KINDS, AnalyticsEvent
from models.engine import session_scope
from models.job import utcnow
from models.user import User

# The curated list. Adding a tracked action means adding it here and calling
# track() with it on the client; an unlisted name is dropped on arrival, which
# is what keeps the dashboard readable.
ACTION_NAMES = frozenset({
    # upload + inference
    "upload_files_selected", "upload_start_inference", "upload_cancel_inference",
    "upload_select_model", "upload_select_postprocessing", "upload_open_batch_details",
    # viewer
    "viewer_open_case", "viewer_change_layout", "viewer_toggle_organ", "viewer_measure",
    # reports
    "report_open",
    # assistant
    "assistant_open", "assistant_send_message",
    # search + browse
    "dataset_search", "dataset_open_compare",
    # account
    "account_open_settings", "account_change_plan", "account_set_account_type",
    "auth_open_modal", "auth_sign_in", "auth_sign_up", "auth_sign_out",
    "auth_forgot_password_request", "auth_reset_password",
    # plan limits
    "plan_limit_hit", "plan_limit_dialog_cta",
    # admin
    "admin_grant_role", "admin_revoke_role",
    "admin_delete_account", "admin_restore_account",
})

# Route patterns, never raw URLs — "/case/:caseId", not "/case/BDMAP_00000123".
# Mirrors the route table in PanTS-Demo/src/App.tsx.
ROUTE_PATTERNS = frozenset({
    "/", "/dashboard", "/case/:caseId", "/session/:sessionId",
    "/reconstruction/:reconstructionId", "/dicom", "/local-nifti",
    "/upload", "/compare", "/compare-viewer", "/team", "/contact", "/signup",
    "/reset-password",
    "/account", "/account/plan", "/account/history", "/account/privacy",
    "/account/analytics", "/account/people",
    "/terms", "/privacy",
})

# A batch bigger than this is a bug or an attack; take the first N and move on.
MAX_BATCH = 100
# Reject events claiming to be older than this. Long enough that a laptop closed
# overnight still reports its last batch, short enough to bound backfill.
MAX_AGE = timedelta(hours=48)
# A page view longer than this is a tab left open, not time spent. Clamped
# rather than dropped so the visit still counts.
MAX_DURATION_MS = 60 * 60 * 1000  # 1 hour
# Cities returned when the map is drilled into a country. A long tail of one
# session each isn't worth the rows; the country total above it is the number
# that matters.
CITY_ROWS = 25

AUDIENCE_ALL = "all"
AUDIENCE_SIGNED_IN = "signed_in"
AUDIENCE_ANONYMOUS = "anonymous"


# ---- recording -------------------------------------------------------------

def _clean(event: dict, now) -> dict | None:
    """One event from the wire -> row kwargs, or None if it doesn't belong here."""
    kind = event.get("kind")
    name = event.get("name")
    if kind not in KINDS or not isinstance(name, str):
        return None

    if kind == KIND_ACTION and name not in ACTION_NAMES:
        return None
    if kind == KIND_PAGE_VIEW and name not in ROUTE_PATTERNS:
        return None

    route = event.get("route")
    if route not in ROUTE_PATTERNS:
        route = None

    anon_id = event.get("anon_id")
    session_id = event.get("session_id")
    if not isinstance(anon_id, str) or not isinstance(session_id, str):
        return None
    if not anon_id or not session_id or len(anon_id) > 64 or len(session_id) > 64:
        return None

    # The client's id, used as the primary key so a resent batch collapses onto
    # the rows it already wrote. Falls back to a fresh one when it's missing or
    # malformed: a tab running a cached older build sends no id at all, and its
    # events are worth more than the dedup guarantee they can't participate in.
    event_id = event.get("id")
    if not isinstance(event_id, str) or not (0 < len(event_id) <= 36):
        event_id = str(uuid.uuid4())

    duration = event.get("duration_ms")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        duration = None
    else:
        duration = max(0, min(int(duration), MAX_DURATION_MS))

    # The client's clock, clamped: never in the future, never older than MAX_AGE.
    created_at = now
    ts = event.get("ts")
    if isinstance(ts, (int, float)) and not isinstance(ts, bool):
        try:
            claimed = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).replace(tzinfo=None)
            created_at = min(max(claimed, now - MAX_AGE), now)
        except (OverflowError, OSError, ValueError):
            created_at = now

    return {
        "id": event_id,
        "kind": kind,
        "name": name,
        "route": route,
        "duration_ms": duration,
        "anon_id": anon_id,
        "session_id": session_id,
        "created_at": created_at,
    }


def record_events(events: list, user_id: str | None = None, ip: str | None = None,
                  geo: dict | None = None, device: str | None = None) -> int:
    """Write a batch. Returns how many rows were actually stored.

    Anything unrecognised is dropped silently rather than failing the batch: one
    stale event name from a cached tab shouldn't cost the other 19 events in the
    request.

    Events the client has already delivered are dropped the same way. The browser
    flushes with ``keepalive`` on pagehide, and a request the browser retries
    resends the identical body — without this, every retry would double-count.

    ``ip``, ``geo`` and ``device`` come from the caller, which reads them off the
    request — never out of the event body. They are stamped onto every row in the
    batch, the same way ``plan``/``account_type`` are: one HTTP request comes
    from one address on one device, whatever the events inside it claim.
    """
    if not isinstance(events, list) or not events:
        return 0

    now = utcnow()
    cleaned = [c for c in (_clean(e, now) for e in events[:MAX_BATCH] if isinstance(e, dict)) if c]
    if not cleaned:
        return 0

    # Within the batch first, so a body that repeats an id doesn't fail the
    # INSERT on itself.
    seen = set()
    cleaned = [c for c in cleaned if not (c["id"] in seen or seen.add(c["id"]))]

    with session_scope() as s:
        # Then against what's stored. A primary-key lookup over at most MAX_BATCH
        # ids, so this is one indexed query per batch.
        already = set(s.execute(
            select(AnalyticsEvent.id).where(
                AnalyticsEvent.id.in_([c["id"] for c in cleaned])
            )
        ).scalars())
        cleaned = [c for c in cleaned if c["id"] not in already]
        if not cleaned:
            return 0

        # Snapshot the account's plan/type once for the whole batch. Read from
        # the row, never from the request.
        plan = account_type = None
        if user_id:
            user = s.get(User, user_id)
            if user is not None and not user.is_system:
                plan = user.plan or "free"
                account_type = user.account_type
            else:
                user_id = None

        place = geo or {}
        for row in cleaned:
            s.add(AnalyticsEvent(
                user_id=user_id,
                plan=plan,
                account_type=account_type,
                ip_address=ip,
                country_code=place.get("country_code"),
                country_name=place.get("country_name"),
                region=place.get("region"),
                city=place.get("city"),
                latitude=place.get("latitude"),
                longitude=place.get("longitude"),
                device_type=device,
                **row,
            ))
        return len(cleaned)


# ---- retention -------------------------------------------------------------

# How long an event is kept. Analytics rows are personal data once they carry a
# user_id, and pseudonymous data even when they don't (anon_id is a stable
# per-browser identifier), so "keep forever" isn't a defensible default. 400 days
# is GA4's longest offered window — a full year of comparisons, plus slack.
DEFAULT_RETENTION_DAYS = 400
# A shorter window is a legitimate policy, so this floor is only here to catch a
# value that can't have been meant — 0 or negative would delete the table on the
# next boot. Anything at or above it is taken at face value.
MIN_RETENTION_DAYS = 1


def retention_days() -> int:
    """The configured window, clamped. Read live so a restart is enough to
    change it, matching how ANALYTICS_DASHBOARD is handled in the blueprint."""
    raw = os.environ.get("ANALYTICS_RETENTION_DAYS")
    if not raw:
        return DEFAULT_RETENTION_DAYS
    try:
        days = int(raw)
    except ValueError:
        return DEFAULT_RETENTION_DAYS
    return days if days >= MIN_RETENTION_DAYS else DEFAULT_RETENTION_DAYS


def purge_old_events(days: int | None = None) -> int:
    """Delete events past the retention window. Returns how many rows went.

    Deleted outright rather than anonymised: the row's identifying parts ARE the
    row (anon_id, session_id), so anonymising one leaves nothing worth keeping.
    """
    cutoff = utcnow() - timedelta(days=days if days is not None else retention_days())
    with session_scope() as s:
        return s.execute(
            delete(AnalyticsEvent).where(AnalyticsEvent.created_at < cutoff)
        ).rowcount or 0


# ---- reading ---------------------------------------------------------------

def _apply_filters(stmt, start, end, plan, account_type, audience, country=None):
    stmt = stmt.where(AnalyticsEvent.created_at >= start, AnalyticsEvent.created_at < end)
    if plan:
        stmt = stmt.where(AnalyticsEvent.plan == plan)
    if account_type:
        stmt = stmt.where(AnalyticsEvent.account_type == account_type)
    if country:
        stmt = stmt.where(AnalyticsEvent.country_code == country)
    if audience == AUDIENCE_SIGNED_IN:
        stmt = stmt.where(AnalyticsEvent.user_id.isnot(None))
    elif audience == AUDIENCE_ANONYMOUS:
        stmt = stmt.where(AnalyticsEvent.user_id.is_(None))
    return stmt


def _rows(s, stmt):
    return list(s.execute(stmt).all())


def earliest_event():
    """When the oldest stored event happened, or None if there are none.

    Backs the dashboard's "all time" range: the alternative is an arbitrary
    epoch, which makes the range the response reports back a fiction.
    """
    with session_scope() as s:
        return s.execute(select(func.min(AnalyticsEvent.created_at))).scalar_one_or_none()


def overview(start, end, plan=None, account_type=None, audience=AUDIENCE_ALL,
             country=None) -> dict:
    """Everything the dashboard shows, in one query set.

    One call rather than six endpoints: every panel shares the same filters, so
    splitting them up would mean the panels could disagree with each other while
    a range change was in flight.

    ``country`` narrows to one country (alpha-2) so the map can be clicked into.
    It filters the *whole* response rather than just the place panels: having
    clicked into Germany, "most-used features" should be Germany's too, or the
    page is two things at once.
    """
    def f(stmt):
        return _apply_filters(stmt, start, end, plan, account_type, audience, country)

    people = func.count(distinct(AnalyticsEvent.anon_id))
    sessions = func.count(distinct(AnalyticsEvent.session_id))

    with session_scope() as s:
        totals = s.execute(f(select(
            func.count(AnalyticsEvent.id),
            people,
            sessions,
            func.count(distinct(AnalyticsEvent.user_id)),
        ))).one()

        actions = _rows(s, f(
            select(AnalyticsEvent.name, func.count(AnalyticsEvent.id), people)
            .where(AnalyticsEvent.kind == KIND_ACTION)
            .group_by(AnalyticsEvent.name)
            .order_by(func.count(AnalyticsEvent.id).desc())
        ))

        # Time spent is per route: a page view carries the dwell time for the
        # feature the route represents.
        routes = _rows(s, f(
            select(
                AnalyticsEvent.name,
                func.count(AnalyticsEvent.id),
                func.coalesce(func.sum(AnalyticsEvent.duration_ms), 0),
                people,
            )
            .where(AnalyticsEvent.kind == KIND_PAGE_VIEW)
            .group_by(AnalyticsEvent.name)
            .order_by(func.coalesce(func.sum(AnalyticsEvent.duration_ms), 0).desc())
        ))

        by_plan = _rows(s, f(
            select(AnalyticsEvent.plan, func.count(AnalyticsEvent.id), people)
            .group_by(AnalyticsEvent.plan)
            .order_by(func.count(AnalyticsEvent.id).desc())
        ))

        # Grouped by the anonymous flag as well as the value, so a signed-in user
        # who never picked a type ("not set") stays distinct from a signed-out
        # visitor — both have a null account_type, and merging them would read as
        # if half the anonymous traffic had declined to answer a question they
        # were never asked.
        is_anon = case((AnalyticsEvent.user_id.is_(None), 1), else_=0)
        by_type = _rows(s, f(
            select(is_anon, AnalyticsEvent.account_type, func.count(AnalyticsEvent.id), people)
            .group_by(is_anon, AnalyticsEvent.account_type)
            .order_by(func.count(AnalyticsEvent.id).desc())
        ))

        day = func.date(AnalyticsEvent.created_at)
        daily = _rows(s, f(
            select(day, func.count(AnalyticsEvent.id), people)
            .group_by(day).order_by(day)
        ))

        # ---- where the visitors were ----
        #
        # Grouped by code and name together so the name travels with the code
        # without a second lookup. Rows with no country (a private address in
        # development, or an event recorded before locations were collected) are
        # left out rather than bucketed as "unknown": on a map there is nowhere
        # to draw them, and the country list sits beside the map.
        by_country = _rows(s, f(
            select(
                AnalyticsEvent.country_code, AnalyticsEvent.country_name,
                sessions, people, func.count(AnalyticsEvent.id),
            )
            .where(AnalyticsEvent.country_code.isnot(None))
            .group_by(AnalyticsEvent.country_code, AnalyticsEvent.country_name)
            .order_by(sessions.desc())
        ))

        # Only meaningful once a country is picked, and only queried then — on
        # the whole world this would be thousands of rows nothing draws.
        by_city = _rows(s, f(
            select(
                AnalyticsEvent.city, AnalyticsEvent.region,
                func.avg(AnalyticsEvent.latitude), func.avg(AnalyticsEvent.longitude),
                sessions, people,
            )
            .where(AnalyticsEvent.city.isnot(None))
            .group_by(AnalyticsEvent.city, AnalyticsEvent.region)
            .order_by(sessions.desc())
            .limit(CITY_ROWS)
        )) if country else []

        by_device = _rows(s, f(
            select(AnalyticsEvent.device_type, sessions, people)
            .where(AnalyticsEvent.device_type.isnot(None))
            .group_by(AnalyticsEvent.device_type)
            .order_by(sessions.desc())
        ))

        # New vs returning, without a column for it: a visitor is returning if
        # this browser was seen before the range began. Deliberately measured
        # against all of history rather than against a previous window of the
        # same length — "have they been here before" is the question, and the
        # answer shouldn't change with the size of the range being viewed.
        seen_before = select(distinct(AnalyticsEvent.anon_id)).where(
            AnalyticsEvent.created_at < start
        ).scalar_subquery()
        returning = s.execute(f(
            select(people).where(AnalyticsEvent.anon_id.in_(seen_before))
        )).scalar_one() or 0

        # Hour and weekday come out of the timestamp. strftime is SQLite's, as
        # is func.date() above — this store has one backend in practice.
        weekday = func.strftime("%w", AnalyticsEvent.created_at)
        by_weekday = _rows(s, f(
            select(weekday, sessions, people).group_by(weekday).order_by(weekday)
        ))
        hour = func.strftime("%H", AnalyticsEvent.created_at)
        by_hour = _rows(s, f(
            select(hour, sessions, people).group_by(hour).order_by(hour)
        ))

        # The immediately preceding window of the same length, for the "up 12%
        # on the previous 30 days" line under each headline number. Only the
        # four totals — a previous-period figure for every panel would be a lot
        # of query for a comparison nothing draws.
        span = end - start
        previous = s.execute(_apply_filters(
            select(func.count(AnalyticsEvent.id), people, sessions),
            start - span, start, plan, account_type, audience, country,
        )).one()

    total_events, total_people, total_sessions, signed_in_people = totals
    return {
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "filters": {
            "plan": plan, "account_type": account_type, "audience": audience or AUDIENCE_ALL,
            "country": country,
        },
        "totals": {
            "events": total_events or 0,
            "people": total_people or 0,
            "sessions": total_sessions or 0,
            "signed_in_people": signed_in_people or 0,
            "time_ms": sum(int(r[2] or 0) for r in routes),
        },
        # The same three counted over the window immediately before this one.
        # Time is left out: it is summed from the route rows rather than counted,
        # and a second pass over those for one comparison isn't worth it.
        "previous": {
            "events": previous[0] or 0,
            "people": previous[1] or 0,
            "sessions": previous[2] or 0,
        },
        "top_actions": [
            {"name": name, "count": count, "people": ppl} for name, count, ppl in actions
        ],
        "time_by_route": [
            {
                "route": name,
                "views": views,
                "total_ms": int(total_ms or 0),
                "avg_ms": int((total_ms or 0) / views) if views else 0,
                "people": ppl,
            }
            for name, views, total_ms, ppl in routes
        ],
        "by_plan": [
            {"plan": p or "anonymous", "events": count, "people": ppl}
            for p, count, ppl in by_plan
        ],
        "by_account_type": [
            {
                "account_type": "anonymous" if anon else (t or "not set"),
                "events": count,
                "people": ppl,
            }
            for anon, t, count, ppl in by_type
        ],
        "daily": [
            {"day": str(d), "events": count, "people": ppl} for d, count, ppl in daily
        ],
        "by_country": [
            {
                "country_code": code,
                "country_name": name or code,
                "sessions": sess,
                "people": ppl,
                "events": events,
            }
            for code, name, sess, ppl, events in by_country
        ],
        "by_city": [
            {
                "city": city,
                "region": region,
                # Averaged over the rows, which for one city is that city's
                # centroid repeated — the average is just how it comes back out
                # of a GROUP BY.
                "latitude": float(lat) if lat is not None else None,
                "longitude": float(lon) if lon is not None else None,
                "sessions": sess,
                "people": ppl,
            }
            for city, region, lat, lon, sess, ppl in by_city
        ],
        "by_device": [
            {"device_type": device, "sessions": sess, "people": ppl}
            for device, sess, ppl in by_device
        ],
        "new_vs_returning": {
            "returning": returning,
            # Everyone counted in the range who wasn't seen before it. Derived
            # rather than queried: the two must add up to the headline "people"
            # figure, and computing them separately is how they stop doing that.
            "new": max(0, (total_people or 0) - returning),
        },
        # "0".."6", Sunday first, as SQLite's %w reports it. Left as the raw
        # index for the client to name, because the day names belong in the
        # user's locale, not in the API.
        "by_weekday": [
            {"weekday": int(w), "sessions": sess, "people": ppl}
            for w, sess, ppl in by_weekday
        ],
        "by_hour": [
            {"hour": int(h), "sessions": sess, "people": ppl}
            for h, sess, ppl in by_hour
        ],
    }
