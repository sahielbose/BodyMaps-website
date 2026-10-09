"""Boot housekeeping: every step runs, and one failing step skips none of the rest.

The admin grant and the analytics retention purge were once dropped from the
boot block without a test noticing, so ADMIN_EMAILS stopped granting anything
and analytics rows (IP address included) were kept forever. These tests call
the same function app.py calls at boot.
"""

import importlib
from datetime import timedelta

import pytest

from models.job import utcnow


@pytest.fixture()
def boot(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'boot.db'}")
    monkeypatch.setenv("ADMIN_EMAILS", "Owner@Example.com")

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.job  # noqa: F401
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import models.user_role  # noqa: F401
    import models.analytics_event  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.role_store as role_store
    importlib.reload(role_store)
    import services.analytics_store as analytics_store
    importlib.reload(analytics_store)
    import services.job_store as job_store
    importlib.reload(job_store)
    import services.plan_store as plan_store
    importlib.reload(plan_store)
    import services.boot_housekeeping as boot_housekeeping
    importlib.reload(boot_housekeeping)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()
    yield boot_housekeeping, str(tmp_path / "sessions")
    engine.reset_engine_for_tests()


def _old_analytics_event():
    from models.analytics_event import AnalyticsEvent
    from models.engine import session_scope
    from services import analytics_store

    analytics_store.record_events([{
        "kind": "action", "name": "viewer_open_case", "id": "old",
        "anon_id": "anon-1", "session_id": "sess-1",
    }])
    with session_scope() as s:
        s.get(AnalyticsEvent, "old").created_at = utcnow() - timedelta(days=500)


def _analytics_rows():
    from sqlalchemy import func, select

    from models.analytics_event import AnalyticsEvent
    from models.engine import session_scope

    with session_scope() as s:
        return s.execute(select(func.count(AnalyticsEvent.id))).scalar_one()


def _verified_user(email):
    from services import auth_store
    user_id = auth_store.create_user(email, "password1")["id"]
    _, token = auth_store.create_email_verification(user_id)
    auth_store.verify_email(token)
    return user_id


def test_boot_grants_admin_emails_and_purges_old_analytics(boot):
    boot_housekeeping, sessions_dir = boot
    from services import role_store

    owner = _verified_user("owner@example.com")
    bystander = _verified_user("someone@example.com")
    _old_analytics_event()
    assert _analytics_rows() == 1

    boot_housekeeping.run(sessions_dir)

    assert role_store.has_role(owner, role_store.ROLE_ADMIN)
    assert not role_store.has_role(bystander, role_store.ROLE_ADMIN)
    assert _analytics_rows() == 0


def test_a_failing_step_does_not_skip_the_others(boot, monkeypatch, capsys):
    boot_housekeeping, sessions_dir = boot
    from services import job_store, role_store

    owner = _verified_user("owner@example.com")
    _old_analytics_event()

    def broken():
        raise RuntimeError("job table unavailable")

    monkeypatch.setattr(job_store, "reap_orphaned_jobs", broken)
    boot_housekeeping.run(sessions_dir)

    assert "job table unavailable" in capsys.readouterr().out
    assert role_store.has_role(owner, role_store.ROLE_ADMIN)
    assert _analytics_rows() == 0


def test_boot_closes_usage_rows_left_open_by_the_last_process(boot):
    boot_housekeeping, sessions_dir = boot
    from services import auth_store, plan_store

    user_id = auth_store.create_user("scanner@example.com", "password1")["id"]
    plan_store.record_inference(user_id, "session-dead", "LesionSegmenter")
    assert plan_store.usage_summary(user_id)["scans"]["in_flight"] == 1

    boot_housekeeping.run(sessions_dir)

    summary = plan_store.usage_summary(user_id)
    assert summary["scans"]["in_flight"] == 0
    # The run still counts against the day; only the concurrent slot comes back.
    assert summary["scans"]["used"] == 1
