"""models/engine.py is the ONE canonical model registry: migrations/env.py
takes Alembic's metadata from it alone. A model module missing from it is
invisible to autogenerate, which then proposes DROP TABLE for a live table
(email_verification_token went missing that way in an upstream merge). Every
module under models/ that defines a table must be registered."""
import importlib
import json
import os
import pkgutil
import subprocess
import sys

import models

SERVER_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _tables_registered_by_engine_alone() -> set[str]:
    # A fresh interpreter, so nothing else this test run imported can
    # register a table on the engine's behalf.
    code = (
        "import json, models.engine\n"
        "from models.base import ModelBase\n"
        "print(json.dumps(sorted(ModelBase.metadata.tables)))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=SERVER_ROOT, capture_output=True,
                         text=True, check=True)
    return set(json.loads(out.stdout.strip().splitlines()[-1]))


def _tables_defined_under_models() -> set[str]:
    defined = set()
    for info in pkgutil.iter_modules(models.__path__):
        if info.name in ("base", "engine"):
            continue
        module = importlib.import_module(f"models.{info.name}")
        for value in vars(module).values():
            table = getattr(value, "__table__", None)
            if table is not None and getattr(value, "__module__", None) == module.__name__:
                defined.add(table.name)
    return defined


def test_every_model_table_is_in_the_canonical_registry():
    defined = _tables_defined_under_models()
    registered = _tables_registered_by_engine_alone()

    assert "email_verification_token" in defined
    assert defined <= registered, f"not registered in models/engine.py: {sorted(defined - registered)}"
