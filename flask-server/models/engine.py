"""Engine + session factory shared by the web tier and the inference worker.

The engine lives here as plain SQLAlchemy so the (future) worker process, which
is not a Flask app, can use it too. app.py points db.init_app at the same URL.
"""

import os
import sqlite3
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from constants import Constants
from models.base import ModelBase


# Registered on the base Engine class so it applies to every SQLite connection
# in the process — this engine and Flask-SQLAlchemy's own engine both. PRAGMAs
# are per-connection, so they must be set on each connect. No-op on Postgres.
@event.listens_for(Engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _record):
    if not isinstance(dbapi_conn, sqlite3.Connection):
        return
    cur = dbapi_conn.cursor()
    try:
        cur.execute("PRAGMA journal_mode=WAL")      # readers don't block writer
        cur.execute("PRAGMA busy_timeout=30000")    # wait, don't raise, on lock
        cur.execute("PRAGMA foreign_keys=ON")       # off by default in SQLite
        cur.execute("PRAGMA synchronous=NORMAL")    # durable + fast under WAL
    finally:
        cur.close()

# Imported for their side effect: registering the tables on ModelBase.metadata.
# This list is the ONE canonical registry — migrations/env.py imports this
# module instead of keeping its own copy, so a model missing here is invisible
# to Alembic autogenerate (which would then emit DROP TABLE for its table).
from models import job as _job  # noqa: F401,E402
from models import user as _user  # noqa: F401,E402
from models import auth_session as _auth_session  # noqa: F401,E402
from models import oauth_identity as _oauth_identity  # noqa: F401,E402
from models import application_session as _application_session  # noqa: F401,E402
from models import combined_labels as _combined_labels  # noqa: F401,E402
from models import usage_event as _usage_event  # noqa: F401,E402
from models import analytics_event as _analytics_event  # noqa: F401,E402
from models import user_role as _user_role  # noqa: F401,E402
from models import password_reset as _password_reset  # noqa: F401,E402

_engine = None
_SessionLocal = None


def _is_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


def _ensure_parent_dir(url: str) -> None:
    """Create the SQLite file's parent dir so a fresh deploy doesn't fail on it."""
    if not _is_sqlite(url):
        return
    path = url.split("sqlite:///", 1)[-1]
    if not path or path == ":memory:":
        return
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def get_engine():
    global _engine
    if _engine is not None:
        return _engine

    url = Constants.DATABASE_URL
    _ensure_parent_dir(url)

    kwargs = {"future": True, "pool_pre_ping": True}
    if _is_sqlite(url):
        # gthread workers can hand a connection to a different thread than made it.
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}

    _engine = create_engine(url, **kwargs)
    return _engine


def get_sessionmaker():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), future=True, expire_on_commit=False)
    return _SessionLocal


@contextmanager
def session_scope():
    """Transactional scope. Commits on success, rolls back on exception."""
    session = get_sessionmaker()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def create_all():
    """Create tables directly (tests + first-run dev only; server uses Alembic)."""
    ModelBase.metadata.create_all(get_engine())


def reset_engine_for_tests():
    """Drop the cached engine so a test can point at a different URL."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None
