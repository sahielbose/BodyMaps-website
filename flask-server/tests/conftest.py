import sys

import pytest


@pytest.fixture(autouse=True)
def _labelmap_cache_in_tmp(tmp_path, monkeypatch):
    """Converted dataset masks go to the test's own directory, never the system temp."""
    monkeypatch.setenv("PANTS_LABELMAP_CACHE", str(tmp_path / "labelmap-cache"))


@pytest.fixture(autouse=True)
def _no_mask_data_carried_between_tests():
    """A /mask-data answer one test caches (often from a stub) never reaches the next."""
    yield
    blueprint = sys.modules.get("api.api_blueprint")
    if blueprint is not None and hasattr(blueprint, "_MASK_DATA_CACHE"):
        blueprint._MASK_DATA_CACHE.clear()
