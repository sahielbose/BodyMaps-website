"""Alembic environment. DB URL comes from Constants.DATABASE_URL (the env var),
not alembic.ini, so migrations target the same database as the app and worker."""

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make the flask-server package root importable (migrations/ is one level down).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from constants import Constants  # noqa: E402
from models.base import ModelBase  # noqa: E402

# models.engine imports every model module for its registration side effects;
# reusing it here (instead of a second hand-maintained list) means a table
# Alembic can't see cannot exist — this file's old copy of the list had
# drifted three tables behind, which would have made the next autogenerate
# emit DROP TABLE for analytics_event, usage_event, and password_reset_token.
from models import engine as _models_registry  # noqa: E402,F401

config = context.config
config.set_main_option("sqlalchemy.url", Constants.DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = ModelBase.metadata


def _is_sqlite() -> bool:
    return Constants.DATABASE_URL.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=Constants.DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_is_sqlite(),  # SQLite can't ALTER in place
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=_is_sqlite(),
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
