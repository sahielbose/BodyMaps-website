"""Roles: who holds them, who can hand them out, and the account list the admin
UI searches.

One role exists. ``admin`` gates the usage dashboard, this module's own
grant/revoke endpoints, and — through ``plan_store`` — every plan limit.

An unknown role name is refused rather than stored: the set of roles is a fixed
vocabulary, and a typo'd "adminn" that stores cleanly is a grant that silently
does nothing.

Bootstrap is the awkward part of any admin role — nobody can grant the first one.
``ADMIN_EMAILS`` solves it: those addresses are granted admin at startup, so a
fresh database or a wiped local one heals itself. An address with no account yet
is skipped (there is nothing to grant to) and picked up on the next boot after
they sign up; ``scripts/grant_role.py`` covers that case without a restart.
"""

import os
import uuid

from sqlalchemy import func, or_, select

from models.engine import session_scope
from models.job import utcnow
from models.user import User
from models.user_role import UserRole

ROLE_ADMIN = "admin"

ROLES = frozenset({ROLE_ADMIN})

# Guardrails on revoke. Both exist to stop the system reaching a state with no
# admin left, which nothing short of shell access can undo.
LAST_ADMIN = "last_admin"
SELF_DEMOTE = "self_demote"
# The same guardrails applied to deleting an account, which is a way of removing
# an admin too — the difference being that revoke takes a role and this takes
# the whole account with it.
SELF_DELETE = "self_delete"


class RoleError(ValueError):
    """A refused grant/revoke. ``reason`` is one of the constants above."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


# ---- reading ---------------------------------------------------------------

def roles_for(user_id: str) -> list[str]:
    """Sorted role names held by one account. Empty list for an unknown id."""
    with session_scope() as s:
        rows = s.execute(
            select(UserRole.role).where(UserRole.user_id == user_id)
        ).scalars().all()
    return sorted(rows)


def roles_for_many(user_ids: list[str]) -> dict[str, list[str]]:
    """Roles for a batch of accounts, keyed by user id.

    The account list renders a role toggle per row; doing that with roles_for()
    would be one query per person on screen.
    """
    if not user_ids:
        return {}
    with session_scope() as s:
        rows = s.execute(
            select(UserRole.user_id, UserRole.role).where(UserRole.user_id.in_(user_ids))
        ).all()
    out: dict[str, list[str]] = {uid: [] for uid in user_ids}
    for user_id, role in rows:
        out.setdefault(user_id, []).append(role)
    return {uid: sorted(names) for uid, names in out.items()}


def has_role(user_id: str | None, role: str) -> bool:
    if not user_id:
        return False
    with session_scope() as s:
        found = s.execute(
            select(UserRole.id)
            .where(UserRole.user_id == user_id, UserRole.role == role)
        ).first()
    return found is not None


def count_admins() -> int:
    with session_scope() as s:
        return s.execute(
            select(func.count(UserRole.id)).where(UserRole.role == ROLE_ADMIN)
        ).scalar_one()


# ---- writing ---------------------------------------------------------------

def grant(user_id: str, role: str, granted_by: str | None = None) -> list[str]:
    """Give an account a role. Idempotent — granting twice is not an error and
    does not rewrite who granted it first. Returns the account's roles after."""
    if role not in ROLES:
        raise ValueError(f"Unknown role: {role}")
    with session_scope() as s:
        user = s.get(User, user_id)
        if user is None or user.is_system:
            raise LookupError(user_id)
        exists = s.execute(
            select(UserRole).where(UserRole.user_id == user_id, UserRole.role == role)
        ).scalar_one_or_none()
        if exists is None:
            s.add(UserRole(
                id=str(uuid.uuid4()), user_id=user_id, role=role,
                granted_by=granted_by, granted_at=utcnow(),
            ))
    return roles_for(user_id)


def revoke(user_id: str, role: str, acting_user_id: str | None = None) -> list[str]:
    """Take a role away. Idempotent. Returns the account's roles after.

    Refuses two cases for admin, both of which end with nobody able to grant
    anything: removing your own admin, and removing the last one.
    """
    if role not in ROLES:
        raise ValueError(f"Unknown role: {role}")

    if role == ROLE_ADMIN and has_role(user_id, ROLE_ADMIN):
        if acting_user_id is not None and acting_user_id == user_id:
            raise RoleError(
                SELF_DEMOTE,
                "You can't remove your own admin access. Ask another admin to do it.",
            )
        if count_admins() <= 1:
            raise RoleError(
                LAST_ADMIN,
                "This is the only admin account. Make someone else an admin first.",
            )

    with session_scope() as s:
        row = s.execute(
            select(UserRole).where(UserRole.user_id == user_id, UserRole.role == role)
        ).scalar_one_or_none()
        if row is not None:
            s.delete(row)
    return roles_for(user_id)


def guard_deletion(user_id: str, acting_user_id: str | None = None) -> None:
    """Raise RoleError if deleting this account would be a mistake we can't undo.

    Deleting an account is another way of removing an admin, so it inherits
    revoke()'s two refusals for the same reason: an install with no admin left
    cannot be repaired through the UI.

    Self-deletion is refused here rather than allowed, even though the account
    page lets anyone delete their own: on this page the button sits in a row of
    other people, and "delete" reading as "that person" while doing "you" is the
    kind of misfire the confirmation dialog exists to prevent. Someone who means
    to leave can still do it from their own privacy settings.
    """
    if acting_user_id is not None and acting_user_id == user_id:
        raise RoleError(
            SELF_DELETE,
            "You can't delete your own account here. Use Settings › Privacy if "
            "you mean to.",
        )
    if has_role(user_id, ROLE_ADMIN) and count_admins() <= 1:
        raise RoleError(
            LAST_ADMIN,
            "This is the only admin account. Make someone else an admin first.",
        )


# ---- the admin UI's account list -------------------------------------------

def search_people(query: str | None = None, limit: int = 25, offset: int = 0) -> dict:
    """Accounts (newest first) with their roles, for the admin People page.

    ``query`` matches email or display name, case-insensitively, anywhere in the
    string — an admin looking for someone has part of an address, not all of it.
    The reserved system account is never listed; it isn't a person.
    """
    limit = max(1, min(int(limit or 25), 100))
    offset = max(0, int(offset or 0))

    where = [User.is_system.is_(False)]
    if query:
        like = f"%{query.strip().lower()}%"
        where.append(or_(
            func.lower(User.email).like(like),
            func.lower(func.coalesce(User.name, "")).like(like),
        ))

    with session_scope() as s:
        total = s.execute(select(func.count(User.id)).where(*where)).scalar_one()
        users = s.execute(
            select(User).where(*where)
            .order_by(User.created_at.desc())
            .limit(limit).offset(offset)
        ).scalars().all()
        # Not in to_public_dict(): every other caller of it is showing you your
        # own account, where a pending deletion is already the reason you can't
        # be signed in. This page is the one place it has to be visible on
        # someone else's row.
        people = [
            {
                **u.to_public_dict(),
                "deletion_requested_at": (
                    u.deletion_requested_at.isoformat()
                    if u.deletion_requested_at else None
                ),
            }
            for u in users
        ]

    by_user = roles_for_many([p["id"] for p in people])
    for person in people:
        person["roles"] = by_user.get(person["id"], [])

    return {"people": people, "total": total, "limit": limit, "offset": offset}


# ---- bootstrap -------------------------------------------------------------

def bootstrap_emails() -> list[str]:
    """ADMIN_EMAILS, normalised the way user_account.email is stored."""
    raw = os.environ.get("ADMIN_EMAILS", "")
    return [e for e in (p.strip().lower() for p in raw.split(",")) if e]


def ensure_bootstrap_admins() -> list[str]:
    """Grant admin to every ADMIN_EMAILS address that has a verified account.

    Additive only: it never revokes. Taking admin away from someone dropped from
    the env var should be a deliberate act through the UI, not a side effect of
    a deploy editing a variable.

    Registering needs no proof of the mailbox, so anyone could sign up as a
    listed address before its owner does. Only an account that proved the
    email (the verification link, or a provider that vouches for it) is
    promoted; an unverified one is picked up on the first boot after it is
    verified.
    """
    emails = bootstrap_emails()
    if not emails:
        return []

    with session_scope() as s:
        rows = s.execute(
            select(User.id, User.email_verified_at).where(
                User.email.in_(emails), User.is_system.is_(False))
        ).all()

    granted = [user_id for user_id, verified_at in rows if verified_at is not None]
    waiting = len(rows) - len(granted)
    if waiting:
        print(f"[role_store] {waiting} ADMIN_EMAILS account(s) left without admin "
              "until the email is verified", flush=True)
    for user_id in granted:
        grant(user_id, ROLE_ADMIN, granted_by=None)
    return granted
