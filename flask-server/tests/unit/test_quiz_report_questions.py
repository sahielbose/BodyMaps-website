from __future__ import annotations

import copy
import json

import pytest

from services.live_quiz import (
    QuizPackError,
    consistency_for,
    get_pack,
    public_pack,
    public_question,
    reveal_for,
    validate_pack,
)
from services.quiz_generation import (
    REPORT_PARSER_VERSION,
    normalize_structured_report,
    parse_structured_report,
    report_finding_for,
    report_mask_diameter_matches,
    _report_text_from_metadata,
)


def structured_report(
    *,
    pancreas_size: str = "Normal size",
    mean_hu: str = "53.0",
    lesions: str = "",
    impression: str = "No liver, pancreatic, or kidney tumor.",
) -> str:
    return (
        "CT Venous Phase_x000D__x000D_FINDINGS:_x000D_"
        "Spleen:_x000D_Normal size (volume: 210.0 cm³)._x000D_Mean HU value: 48.0 +/- 8.0._x000D_"
        f"Pancreas:_x000D_{pancreas_size} (volume: 72.0 cm^3)._x000D_"
        f"Mean HU value: {mean_hu} +/- 10.0._x000D_{lesions}"
        "Kidney:_x000D_Normal size (right kidney volume: 150.0 cm^3; left kidney volume: 151.0 cm^3)._x000D_"
        "Liver:_x000D_Normal size (volume: 1500.0 cm^3)._x000D_"
        f"IMPRESSION:_x000D_{impression}"
    )


def lesion_block(
    number: int,
    *,
    region: str,
    size: str,
    attenuation: str,
    unit: str = "cm",
) -> str:
    return (
        f"Pancreas lesion {number}:_x000D_Location: pancreas {region}._x000D_"
        f"Size: {size} {unit} (image 42). Volume: 2.0 cm^3._x000D_"
        f"Enhancement relative to pancreas: {attenuation} (HU value is 80+/-5)._x000D_"
    )


def v2_pack(*, with_report_question: bool = True) -> dict:
    pack = copy.deepcopy(get_pack("radworld-case-35-v1"))
    pack.update({
        "pack_id": "radworld-case-35-v2",
        "version": 2,
        "generator_version": "bodymaps-vqa-generator/2.0.0",
        "validator_version": "bodymaps-vqa-validator/2.0.0",
        "approval": {"status": "pending"},
    })
    if with_report_question:
        question = {
            "id": "report_finding",
            "prompt": "How does the report describe the pancreatic-tail lesion relative to the pancreas?",
            "choices": [
                {"id": "hyperattenuating", "label": "Hyperattenuating", "claims": {}},
                {"id": "isoattenuating", "label": "Isoattenuating", "claims": {}},
                {"id": "hypoattenuating", "label": "Hypoattenuating", "claims": {}},
                {"id": "not_described", "label": "Not described", "claims": {}},
            ],
            "correct_choice_id": "hyperattenuating",
            "explanation": "The structured report describes the pancreatic-tail lesion as hyperattenuating relative to the pancreas.",
            "source_label": "Structured report finding",
            "viewer_cue": copy.deepcopy(pack["questions"][0]["viewer_cue"]),
        }
        pack["questions"].insert(3, question)
        pack["report_ground_truth"] = {
            "report_sha256": "a" * 64,
            "selected_field": "lesion_attenuation",
            "evidence_sentence": "Pancreas lesion 1. Location: pancreas tail.",
            "parser_version": REPORT_PARSER_VERSION,
            "validation_outcome": "matched_report_lesion_to_mask",
        }
    else:
        pack["report_ground_truth"] = {
            "report_sha256": None,
            "selected_field": None,
            "evidence_sentence": None,
            "parser_version": REPORT_PARSER_VERSION,
            "validation_outcome": "report_missing",
        }
    return pack


def test_parser_normalizes_artifacts_headings_units_and_extracts_sections():
    raw = structured_report(
        lesions=lesion_block(1, region="tail", size="2.3 x 1.2", attenuation="Hyperattenuating")
    )
    normalized = normalize_structured_report(raw)
    assert "_x000D_" not in normalized
    assert "cm^3" in normalized
    assert "FINDINGS:\n" in normalized and "IMPRESSION:\n" in normalized
    parsed = parse_structured_report(raw)
    assert parsed.valid is True
    assert parsed.impression == "No liver, pancreatic, or kidney tumor."
    assert parsed.organ_sizes["pancreas"]["state"] == "normal"
    assert parsed.pancreatic_mean_hu == 53.0
    assert parsed.pancreatic_lesions[0]["regions"] == ("tail",)
    assert parsed.pancreatic_lesions[0]["dimensions_mm"] == (23.0, 12.0)


def test_metadata_selects_raw_structured_report_before_fusion_or_narrative():
    assert _report_text_from_metadata({
        "fusion structured report": "fusion",
        "narrative report": "narrative",
        "structured report": "raw structured",
    }) == "raw structured"
    assert _report_text_from_metadata({"structured report": float("nan")}) is None


def test_lesion_hierarchy_uses_largest_matching_report_lesion():
    raw = structured_report(lesions=(
        lesion_block(1, region="tail", size="2.3 x 1.2", attenuation="Hyperattenuating")
        + lesion_block(2, region="head", size="0.8 x 0.5", attenuation="Hypoattenuating")
    ))
    question, truth, warnings = report_finding_for(
        raw, lesion_present=True, region="tail", diameter_mm=23.0, viewer_cue={"clear_overlays": True}
    )
    assert question and question["correct_choice_id"] == "hyperattenuating"
    assert question["prompt"] == "How does the report describe the pancreatic-tail lesion relative to the pancreas?"
    assert truth["selected_field"] == "lesion_attenuation"
    assert truth["report_sha256"] and len(truth["report_sha256"]) == 64
    assert warnings == []


def test_conflict_and_mask_mismatch_fall_back_without_lesion_claims():
    conflict = structured_report(lesions=lesion_block(
        1,
        region="tail",
        size="2.3 x 1.2",
        attenuation="Hyperattenuating and hypoattenuating",
    ))
    question, truth, warnings = report_finding_for(
        conflict, lesion_present=True, region="tail", diameter_mm=23.0, viewer_cue={}
    )
    assert question and question["correct_choice_id"] == "normal"
    assert truth["selected_field"] == "organ_size.pancreas"
    assert {item["code"] for item in warnings} == {"report_lesion_conflict"}
    assert all(choice["claims"] == {} for choice in question["choices"])

    mismatch = structured_report(lesions=lesion_block(
        1, region="head", size="6.0 x 2.0", attenuation="Hyperattenuating"
    ))
    _, _, mismatch_warnings = report_finding_for(
        mismatch, lesion_present=True, region="tail", diameter_mm=23.0, viewer_cue={}
    )
    assert {item["code"] for item in mismatch_warnings} == {"report_mask_mismatch"}


def test_organ_size_then_hu_fallback_and_ambiguous_or_malformed_reports():
    organ_question, organ_truth, organ_warnings = report_finding_for(
        structured_report(lesions=""), lesion_present=False, region=None, diameter_mm=None, viewer_cue={}
    )
    assert organ_question and organ_question["correct_choice_id"] == "normal"
    assert organ_truth["selected_field"] == "organ_size.pancreas"
    assert organ_warnings == []

    hu_report = structured_report(
        pancreas_size="Contour is smooth",
        mean_hu="-4.5",
    ).replace("Spleen:_x000D_Normal size", "Spleen:_x000D_Contour is smooth").replace(
        "Kidney:_x000D_Normal size", "Kidney:_x000D_Contours are smooth"
    ).replace("Liver:_x000D_Normal size", "Liver:_x000D_Contour is smooth")
    hu_question, hu_truth, hu_warnings = report_finding_for(
        hu_report, lesion_present=False, region=None, diameter_mm=None, viewer_cue={}
    )
    assert hu_question and hu_question["correct_choice_id"] == "below_0"
    assert hu_truth["selected_field"] == "pancreatic_mean_hu"
    assert {item["code"] for item in hu_warnings} == {"report_hu_fallback"}

    missing_question, missing_truth, missing_warnings = report_finding_for(
        None, lesion_present=False, region=None, diameter_mm=None, viewer_cue={}
    )
    assert missing_question is None and missing_truth["report_sha256"] is None
    assert {item["code"] for item in missing_warnings} == {"report_missing"}

    malformed_question, malformed_truth, malformed_warnings = report_finding_for(
        "FINDINGS: Pancreas normal", lesion_present=False, region=None, diameter_mm=None, viewer_cue={}
    )
    assert malformed_question is None and malformed_truth["validation_outcome"] == "missing_or_empty_section"
    assert {item["code"] for item in malformed_warnings} == {"report_ambiguous"}


@pytest.mark.parametrize(
    ("report_mm", "mask_mm", "expected"),
    [(25.0, 20.0, True), (25.0001, 20.0, False), (125.0, 100.0, True), (125.0001, 100.0, False)],
)
def test_report_mask_matching_uses_inclusive_max_five_mm_or_twenty_five_percent(
    report_mm: float, mask_mm: float, expected: bool
):
    assert report_mask_diameter_matches(report_mm, mask_mm) is expected


def test_v1_and_v2_pack_contracts_and_report_privacy():
    v1 = get_pack("radworld-case-35-v1")
    assert v1["version"] == 1
    assert [item["id"] for item in validate_pack(v1)["questions"]] == [
        "organ", "presence", "location", "conclusion"
    ]

    five = validate_pack(v2_pack())
    assert [item["id"] for item in five["questions"]] == [
        "organ", "presence", "location", "report_finding", "conclusion"
    ]
    four = validate_pack(v2_pack(with_report_question=False))
    assert len(four["questions"]) == 4

    public = public_pack(five)
    pre_reveal = public_question(five, 3)
    encoded = json.dumps({"public": public, "pre_reveal": pre_reveal})
    for secret in ("report_ground_truth", "report_sha256", "evidence_sentence", "selected_field", "correct_choice_id", "source_label"):
        assert secret not in encoded
    reveal = reveal_for(five, "report_finding", {"student": {"choice_id": "hyperattenuating"}})
    assert reveal["source_label"] == "Structured report finding"
    assert "evidence_sentence" not in reveal and "report_sha256" not in reveal

    invalid = v2_pack(with_report_question=False)
    invalid["questions"].insert(3, copy.deepcopy(v2_pack()["questions"][3]))
    with pytest.raises(QuizPackError, match="selected_field"):
        validate_pack(invalid)


def test_report_question_does_not_change_lesion_chain_consistency():
    pack = validate_pack(v2_pack())
    answers = {
        "organ": "pancreas",
        "presence": "yes",
        "location": "tail",
        "report_finding": "isoattenuating",
        "conclusion": "focal_tail_23mm",
    }
    assert consistency_for(answers, pack)["status"] == "consistent"
