"""Database housekeeping that runs once when the app boots.

Lives outside app.py so it can be tested without importing the app, which loads
.env and builds every blueprint at import time.

Each step has its own try/except. One step failing (a missing table, a bad env
value) must not skip the steps after it: the admin grant and the analytics purge
were once dropped from boot without anyone noticing, and a shared try block
makes that kind of silent skip the default.
"""


def _run_step(label, step):
    try:
        step()
    except Exception as e:
        print(f"[boot] {label} skipped: {e}")


def _jobs(sessions_dir):
    from services import auth_store, job_store

    # Seed the reserved system user first (legacy-imported jobs are assigned to
    # it, and job.user_id is NOT NULL with an FK), then import any pre-DB
    # job.json, then fail jobs orphaned by the restart.
    auth_store.ensure_system_user()
    imported = job_store.import_legacy_job_json(sessions_dir)
    if imported:
        print(f"[boot] imported {imported} legacy job.json record(s)")
    reaped = job_store.reap_orphaned_jobs()
    if reaped:
        print(f"[boot] reaped {reaped} orphaned inference job(s)")


def _reap_orphaned_usage():
    from services import plan_store

    # The usage side of the same restart: a run the old process never finished
    # still holds a concurrent-scan slot until its row is closed.
    closed = plan_store.reap_orphaned_usage()
    if closed:
        print(f"[boot] closed {closed} orphaned inference usage row(s)")


def _bootstrap_admins():
    from services import role_store

    # ADMIN_EMAILS -> the admin role, so a fresh or wiped database still has
    # someone who can grant roles. Additive: it never takes admin away. An
    # account registered after boot is picked up on the next boot.
    bootstrapped = role_store.ensure_bootstrap_admins()
    if bootstrapped:
        print(f"[boot] ensured admin for {len(bootstrapped)} account(s) from ADMIN_EMAILS")


def _purge_deleted_accounts():
    from services import auth_store

    # Accounts whose 30-day grace period elapsed while the server was up (or
    # down) are removed for good here. Boot is the only trigger for now: a
    # long-running server won't purge until its next restart, which is fine,
    # the account is already unusable from the moment it's requested.
    purged = auth_store.purge_expired_deletions()
    if purged:
        print(f"[boot] purged {purged} account(s) past the deletion grace period")


def _purge_spent_tokens():
    from services import auth_store

    # Same deal for spent reset tokens: housekeeping, not security. They
    # are already refused on redemption, this just stops the table growing.
    dropped = auth_store.purge_expired_reset_tokens()
    dropped += auth_store.purge_expired_verification_tokens()
    if dropped:
        print(f"[boot] dropped {dropped} spent password reset token(s)")


def _purge_old_analytics():
    from services import analytics_store

    # Same boot-only trigger, and the same caveat: a server that stays up for
    # months holds its oldest events a little past the window. Acceptable for
    # a retention bound, and it avoids a scheduler this app doesn't have.
    expired = analytics_store.purge_old_events()
    if expired:
        print(f"[boot] purged {expired} analytics event(s) past "
              f"{analytics_store.retention_days()}-day retention")


def run(sessions_dir: str) -> None:
    _run_step("account/job store init", lambda: _jobs(sessions_dir))
    _run_step("inference usage reconcile", _reap_orphaned_usage)
    _run_step("admin bootstrap", _bootstrap_admins)
    _run_step("account deletion purge", _purge_deleted_accounts)
    _run_step("spent token purge", _purge_spent_tokens)
    _run_step("analytics retention purge", _purge_old_analytics)
