"""role_store: granting, revoking, the two lock-out guards, and bootstrap.

The guards are the reason this file exists. Everything else here is a table
write; "the last admin can't remove themselves" is the rule that decides whether
this feature can strand its own owner.
"""

import importlib

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'roles.db'}")
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.role_store as role_store
    importlib.reload(role_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    yield role_store
    engine.reset_engine_for_tests()


@pytest.fixture()
def make_user():
    def _make(email, verified=True):
        from models.engine import session_scope
        from models.job import utcnow
        from models.user import User
        from services import auth_store
        user_id = auth_store.create_user(email, "password1")["id"]
        if verified:
            with session_scope() as s:
                s.get(User, user_id).email_verified_at = utcnow()
        return user_id
    return _make


# ---- granting --------------------------------------------------------------

def test_a_new_account_holds_nothing(store, make_user):
    assert store.roles_for(make_user("a@b.com")) == []


def test_grant_then_read_back(store, make_user):
    user_id = make_user("a@b.com")
    assert store.grant(user_id, store.ROLE_ADMIN) == ["admin"]
    assert store.roles_for(user_id) == ["admin"]


def test_granting_twice_is_a_no_op(store, make_user):
    user_id = make_user("a@b.com")
    store.grant(user_id, store.ROLE_ADMIN)
    assert store.grant(user_id, store.ROLE_ADMIN) == ["admin"]
    assert store.count_admins() == 1


def test_an_unknown_role_is_refused(store, make_user):
    """A typo that stores cleanly is a grant that silently does nothing."""
    with pytest.raises(ValueError):
        store.grant(make_user("a@b.com"), "adminn")


def test_granting_to_a_missing_account_raises(store):
    with pytest.raises(LookupError):
        store.grant("no-such-id", store.ROLE_ADMIN)


def test_the_system_account_cannot_hold_a_role(store):
    """It isn't a login; giving it admin would be an unreachable back door."""
    from models.user import SYSTEM_USER_ID
    with pytest.raises(LookupError):
        store.grant(SYSTEM_USER_ID, store.ROLE_ADMIN)


def test_granted_by_is_recorded(store, make_user):
    granter = make_user("boss@b.com")
    subject = make_user("new@b.com")
    store.grant(subject, store.ROLE_ADMIN, granted_by=granter)

    from models.engine import session_scope
    from models.user_role import UserRole
    from sqlalchemy import select
    with session_scope() as s:
        row = s.execute(select(UserRole).where(UserRole.user_id == subject)).scalar_one()
        assert row.granted_by == granter


# ---- revoking and its guards ------------------------------------------------

def test_revoke_removes_it(store, make_user):
    a, b = make_user("a@b.com"), make_user("b@b.com")
    store.grant(a, store.ROLE_ADMIN)
    store.grant(b, store.ROLE_ADMIN)
    assert store.revoke(b, store.ROLE_ADMIN, acting_user_id=a) == []


def test_revoking_something_not_held_is_a_no_op(store, make_user):
    user_id = make_user("a@b.com")
    assert store.revoke(user_id, store.ROLE_ADMIN) == []


def test_the_last_admin_cannot_be_removed(store, make_user):
    only = make_user("only@b.com")
    store.grant(only, store.ROLE_ADMIN)
    with pytest.raises(store.RoleError) as e:
        store.revoke(only, store.ROLE_ADMIN)
    assert e.value.reason == store.LAST_ADMIN
    assert store.roles_for(only) == ["admin"]


def test_you_cannot_remove_your_own_admin(store, make_user):
    a, b = make_user("a@b.com"), make_user("b@b.com")
    store.grant(a, store.ROLE_ADMIN)
    store.grant(b, store.ROLE_ADMIN)

    with pytest.raises(store.RoleError) as e:
        store.revoke(a, store.ROLE_ADMIN, acting_user_id=a)
    assert e.value.reason == store.SELF_DEMOTE
    assert store.roles_for(a) == ["admin"]


# ---- the account list -------------------------------------------------------

def test_search_matches_part_of_an_email(store, make_user):
    make_user("alice@hospital.org")
    make_user("bob@university.edu")

    found = store.search_people(query="hospital")["people"]
    assert [p["email"] for p in found] == ["alice@hospital.org"]


def test_search_is_case_insensitive(store, make_user):
    make_user("alice@hospital.org")
    assert store.search_people(query="ALICE")["total"] == 1


def test_the_list_carries_roles(store, make_user):
    user_id = make_user("a@b.com")
    store.grant(user_id, store.ROLE_ADMIN)
    assert store.search_people()["people"][0]["roles"] == ["admin"]


def test_the_system_account_is_never_listed(store, make_user):
    make_user("a@b.com")
    emails = [p["email"] for p in store.search_people()["people"]]
    assert emails == ["a@b.com"]


def test_paging_reports_the_full_total(store, make_user):
    for i in range(5):
        make_user(f"user{i}@b.com")
    page = store.search_people(limit=2)
    assert len(page["people"]) == 2
    assert page["total"] == 5


def test_no_password_hash_reaches_the_list(store, make_user):
    make_user("a@b.com")
    assert "password_hash" not in store.search_people()["people"][0]


# ---- bootstrap --------------------------------------------------------------

def test_bootstrap_grants_admin_to_listed_emails(store, make_user, monkeypatch):
    user_id = make_user("boss@b.com")
    make_user("other@b.com")
    monkeypatch.setenv("ADMIN_EMAILS", "boss@b.com")

    assert store.ensure_bootstrap_admins() == [user_id]
    assert store.count_admins() == 1


def test_bootstrap_handles_spacing_and_case(store, make_user, monkeypatch):
    make_user("boss@b.com")
    make_user("second@b.com")
    monkeypatch.setenv("ADMIN_EMAILS", " BOSS@b.com , second@b.com ")
    assert len(store.ensure_bootstrap_admins()) == 2


def test_bootstrap_skips_an_email_with_no_account(store, monkeypatch):
    """They haven't signed up yet; the next boot picks them up."""
    monkeypatch.setenv("ADMIN_EMAILS", "ghost@b.com")
    assert store.ensure_bootstrap_admins() == []


def test_bootstrap_never_promotes_an_unverified_account(store, make_user, monkeypatch):
    """Registering proves nothing about the mailbox, so a squatter who signs
    up as a listed address before its owner must not become admin."""
    squatter = make_user("boss@b.com", verified=False)
    monkeypatch.setenv("ADMIN_EMAILS", "boss@b.com")

    assert store.ensure_bootstrap_admins() == []
    assert store.roles_for(squatter) == []
    assert store.count_admins() == 0


def test_bootstrap_promotes_the_account_once_it_is_verified(store, make_user, monkeypatch):
    from services import auth_store
    user_id = make_user("boss@b.com", verified=False)
    monkeypatch.setenv("ADMIN_EMAILS", "boss@b.com")
    assert store.ensure_bootstrap_admins() == []

    _, token = auth_store.create_email_verification(user_id)
    assert auth_store.verify_email(token) is not None
    assert store.ensure_bootstrap_admins() == [user_id]


def test_bootstrap_is_repeatable(store, make_user, monkeypatch):
    make_user("boss@b.com")
    monkeypatch.setenv("ADMIN_EMAILS", "boss@b.com")
    store.ensure_bootstrap_admins()
    store.ensure_bootstrap_admins()
    assert store.count_admins() == 1


def test_bootstrap_never_revokes(store, make_user, monkeypatch):
    """Dropping someone from the env var must not quietly strip their admin —
    that should be a deliberate act, not a side effect of editing a variable."""
    user_id = make_user("boss@b.com")
    store.grant(user_id, store.ROLE_ADMIN)
    monkeypatch.setenv("ADMIN_EMAILS", "someone-else@b.com")

    store.ensure_bootstrap_admins()
    assert store.roles_for(user_id) == ["admin"]
