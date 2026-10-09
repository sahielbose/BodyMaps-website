"""The workbook stores age as 52.0; the assistant must read it as 52.

A float age made the case fact say "Age: 52.0", and the safety net that checks
numbers in the reply then appended that line when the model said "52 years old".
"""

from api import api_blueprint as bp


def _metadata_with_age(monkeypatch, age):
    monkeypatch.setattr(bp, "_METADATA_CACHE", {bp.get_panTS_id("7"): {"age": age, "sex": "F"}})
    return bp._ai_metadata("7", None)


def test_a_whole_workbook_age_is_a_whole_number(monkeypatch):
    metadata = _metadata_with_age(monkeypatch, 52.0)
    assert metadata["age"] == 52
    assert isinstance(metadata["age"], int)


def test_the_age_fact_has_no_decimal(monkeypatch):
    facts = bp._ai_case_facts("how old is the patient", [], _metadata_with_age(monkeypatch, "52.0"))
    assert "**Age:** 52" in facts
    assert not any("52.0" in fact for fact in facts)


def test_a_fractional_age_keeps_one_decimal(monkeypatch):
    assert _metadata_with_age(monkeypatch, 52.46)["age"] == 52.5


def test_an_age_that_is_not_a_number_is_passed_through(monkeypatch):
    assert _metadata_with_age(monkeypatch, "unknown")["age"] == "unknown"
