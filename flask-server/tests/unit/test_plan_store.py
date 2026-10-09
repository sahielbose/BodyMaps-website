"""Unit tests for plan limits: which models a plan may run, the rolling daily
quota, the concurrency slot, and the assistant allowance.

Each test gets its own temp-file database, following test_job_store's fixture.
"""

import importlib

import pytest


@pytest.fixture()
def plans(tmp_path, monkeypatch):
    """Fresh temp DB; hands back (plan_store, user_id) for a free-plan account."""
    db_path = tmp_path / "plans.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.job  # noqa: F401
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import models.user_role  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.role_store as role_store
    importlib.reload(role_store)
    import services.plan_store as plan_store
    importlib.reload(plan_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    user = auth_store.create_user("limits@example.com", "correct-horse-battery")
    yield plan_store, user["id"]
    engine.reset_engine_for_tests()


def test_new_accounts_start_on_free(plans):
    plan_store, user_id = plans
    assert plan_store.get_plan(user_id) == "free"


def test_free_may_only_run_the_free_model(plans):
    plan_store, user_id = plans
    assert plan_store.check_inference(user_id, "LesionSegmenter") is None

    blocked = plan_store.check_inference(user_id, "ePAI")
    assert blocked is not None
    assert blocked["reason"] == "model_locked"
    assert blocked["feature"] == "ePAI"


def test_upgrading_unlocks_every_model(plans):
    plan_store, user_id = plans
    plan_store.set_plan(user_id, "pro")
    assert plan_store.check_inference(user_id, "ePAI") is None


def test_unknown_plan_is_refused(plans):
    plan_store, user_id = plans
    with pytest.raises(ValueError):
        plan_store.set_plan(user_id, "platinum")


def test_daily_quota_blocks_the_second_scan(plans):
    plan_store, user_id = plans
    for i in range(1):
        assert plan_store.check_inference(user_id, "LesionSegmenter") is None
        plan_store.record_inference(user_id, f"session-{i}", "LesionSegmenter")
        plan_store.finish_inference(f"session-{i}")  # free the concurrency slot

    blocked = plan_store.check_inference(user_id, "LesionSegmenter")
    assert blocked is not None
    assert blocked["reason"] == "daily_scans"
    assert blocked["limit"] == 1
    assert blocked["used"] == 1
    assert blocked["message"] == "You've used your scan for today."
    # The column is naive UTC; the string must carry the offset or a browser reads it as local time.
    assert blocked["resets_at"].endswith("+00:00")


def test_concurrency_blocks_a_second_run_still_in_flight(plans):
    plan_store, user_id = plans
    plan_store.record_inference(user_id, "session-a", "LesionSegmenter")

    blocked = plan_store.check_inference(user_id, "LesionSegmenter")
    assert blocked is not None
    assert blocked["reason"] == "concurrent_scans"

    # Finishing the run frees the slot without refunding the quota: with the
    # 1/day Free limit the next refusal is the daily quota, not the slot.
    plan_store.finish_inference("session-a")
    blocked = plan_store.check_inference(user_id, "LesionSegmenter")
    assert blocked is not None
    assert blocked["reason"] == "daily_scans"
    summary = plan_store.usage_summary(user_id)
    assert summary["scans"]["used"] == 1
    assert summary["scans"]["in_flight"] == 0


def test_boot_reap_frees_a_slot_held_by_a_run_that_died(plans):
    """A restart mid-run left finished_at NULL, and nothing closed it: once the
    daily window rolled over, the account was still refused as "one scan at a
    time" for good."""
    from datetime import timedelta

    from models.engine import session_scope
    from models.job import utcnow
    from models.usage_event import UsageEvent

    plan_store, user_id = plans
    plan_store.record_inference(user_id, "session-dead", "LesionSegmenter")
    plan_store.record_ai_message(user_id)
    with session_scope() as s:
        for event in s.query(UsageEvent).all():
            event.created_at = utcnow() - timedelta(days=2)

    blocked = plan_store.check_inference(user_id, "LesionSegmenter")
    assert blocked is not None
    assert blocked["reason"] == "concurrent_scans"

    assert plan_store.reap_orphaned_usage() == 1
    assert plan_store.check_inference(user_id, "LesionSegmenter") is None
    assert plan_store.reap_orphaned_usage() == 0


def test_rerunning_a_session_id_does_not_charge_twice(plans):
    plan_store, user_id = plans
    plan_store.record_inference(user_id, "session-a", "LesionSegmenter")
    plan_store.finish_inference("session-a")
    plan_store.record_inference(user_id, "session-a", "LesionSegmenter")

    assert plan_store.usage_summary(user_id)["scans"]["used"] == 1


def test_postprocessing_is_gated_but_not_metered(plans):
    plan_store, user_id = plans
    blocked = plan_store.check_inference(user_id, "ShapeKit")
    assert blocked is not None
    assert blocked["reason"] == "postprocessing"

    plan_store.set_plan(user_id, "pro")
    assert plan_store.check_inference(user_id, "ShapeKit") is None
    plan_store.record_inference(user_id, "session-shape", "ShapeKit")
    assert plan_store.usage_summary(user_id)["scans"]["used"] == 0


def test_assistant_needs_an_account(plans):
    plan_store, _ = plans
    blocked = plan_store.check_assistant(None)
    assert blocked is not None
    assert blocked["reason"] == "auth_required"


def test_assistant_lets_a_signed_in_user_through(plans):
    plan_store, user_id = plans
    assert plan_store.check_assistant(user_id) is None


def test_assistant_gate_still_applies_the_daily_allowance(plans):
    plan_store, user_id = plans
    for _ in range(10):
        plan_store.record_ai_message(user_id)
    blocked = plan_store.check_assistant(user_id)
    assert blocked is not None
    assert blocked["reason"] == "daily_ai_messages"


def test_assistant_allowance(plans):
    plan_store, user_id = plans
    for _ in range(10):
        assert plan_store.check_ai_message(user_id) is None
        plan_store.record_ai_message(user_id)

    blocked = plan_store.check_ai_message(user_id)
    assert blocked is not None
    assert blocked["reason"] == "daily_ai_messages"
    assert blocked["limit"] == 10


def test_enterprise_is_unmetered(plans):
    plan_store, user_id = plans
    plan_store.set_plan(user_id, "enterprise")
    for i in range(60):
        plan_store.record_inference(user_id, f"session-{i}", "ePAI")
    assert plan_store.check_inference(user_id, "ePAI") is None
    assert plan_store.check_ai_message(user_id) is None


def test_usage_summary_reports_the_plan_limits(plans):
    plan_store, user_id = plans
    summary = plan_store.usage_summary(user_id)
    assert summary["plan"] == "free"
    assert summary["limits"]["daily_scans"] == 1
    assert summary["scans"] == {
        "used": 0, "limit": 1, "in_flight": 0, "resets_at": None
    }


def _make_verified_researcher(user_id, **overrides):
    """Verified email + full profile, straight onto the row - the flows that
    set these for real are covered by their own test files."""
    from models.engine import session_scope
    from models.user import User
    with session_scope() as s:
        u = s.get(User, user_id)
        u.email_verified_at = u.created_at
        u.organization = overrides.get("organization", "Example University")
        u.occupation = overrides.get("occupation", "Radiologist")
        u.role_description = overrides.get("role_description", "Research annotation")


def test_a_verified_complete_profile_is_promoted_to_pro(plans):
    plan_store, user_id = plans
    _make_verified_researcher(user_id)
    plan, limits = plan_store.limits_for_user(user_id)
    assert plan == "pro"
    assert limits["daily_scans"] == 10
    # The stored column is untouched: the promotion is computed and reversible.
    assert plan_store.get_plan(user_id) == "free"
    assert plan_store.usage_summary(user_id)["plan"] == "pro"


def test_promotion_needs_every_ingredient(plans):
    plan_store, user_id = plans
    from models.engine import session_scope
    from models.user import User
    _make_verified_researcher(user_id)
    with session_scope() as s:
        s.get(User, user_id).occupation = "   "
    plan, limits = plan_store.limits_for_user(user_id)
    assert plan == "free"
    assert limits["daily_scans"] == 1


def test_a_complete_profile_without_a_verified_email_stays_free(plans):
    plan_store, user_id = plans
    from models.engine import session_scope
    from models.user import User
    with session_scope() as s:
        u = s.get(User, user_id)
        u.organization = "Example University"
        u.occupation = "Radiologist"
        u.role_description = "Research annotation"
    plan, limits = plan_store.limits_for_user(user_id)
    assert plan == "free"
    assert limits["daily_scans"] == 1


def test_an_admin_is_not_metered(plans):
    """Admins run everything on whatever plan they're on — the site's operators
    have to be able to exercise the parts they're gating everyone else out of."""
    plan_store, user_id = plans
    from services import role_store
    role_store.grant(user_id, role_store.ROLE_ADMIN)

    assert plan_store.check_inference(user_id, "ePAI") is None
    assert plan_store.check_inference(user_id, "ShapeKit") is None
    for i in range(60):
        plan_store.record_inference(user_id, f"session-{i}", "ePAI")
    assert plan_store.check_inference(user_id, "ePAI") is None

    for _ in range(20):
        plan_store.record_ai_message(user_id)
    assert plan_store.check_ai_message(user_id) is None


def test_an_admin_keeps_the_plan_their_account_is_on(plans):
    """The bypass changes the limits, not the record: the settings page names
    the stored plan, and Free is what this account is on."""
    plan_store, user_id = plans
    from services import role_store
    role_store.grant(user_id, role_store.ROLE_ADMIN)

    summary = plan_store.usage_summary(user_id)
    assert summary["plan"] == "free"
    assert summary["limits"]["daily_scans"] is None
    assert summary["ai_messages"]["limit"] is None
