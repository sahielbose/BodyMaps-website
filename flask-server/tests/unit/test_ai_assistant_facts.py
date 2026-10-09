"""The assistant's facts must agree with the Organ statistics table.

A mask that reaches the first or last slice has a clipped volume, which the
table shows as n/a; the assistant must not give that number as the full
measurement. Organ names and view names also read in sentence case.
"""

import numpy as np

from api import api_blueprint as bp


def _metrics(truncated):
    return [
        bp._ai_public_metric(
            {"organ_name": "liver", "volume_cm3": 812.4, "mean_hu": 60.0, "truncated": truncated}
        ),
        bp._ai_public_metric({"organ_name": "spleen", "volume_cm3": 200.0, "mean_hu": 50.0}),
        bp._ai_public_metric({"organ_name": "kidney_left", "volume_cm3": 151.2, "mean_hu": 40.0}),
    ]


ORGANS = ["liver", "spleen", "kidney_left"]


def test_public_metric_keeps_the_clipped_flag():
    assert bp._ai_public_metric({"organ_name": "liver", "truncated": True})["truncated"] is True
    assert bp._ai_public_metric({"organ_name": "liver"})["truncated"] is False


def test_required_fact_for_a_clipped_organ_is_not_an_exact_volume():
    actions = [{"type": "get_organ_metric", "organ": "liver", "metric": "volume_cm3"}]
    fact = bp._ai_required_metric_facts(actions, _metrics(True), ORGANS)[0]
    assert "reaches the edge of the scan" in fact
    assert "at least **812.40 cm³**" in fact
    assert "volume is **" not in fact


def test_required_fact_for_a_whole_organ_is_unchanged():
    actions = [{"type": "get_organ_metric", "organ": "liver", "metric": "volume_cm3"}]
    assert bp._ai_required_metric_facts(actions, _metrics(False), ORGANS) == [
        "The segmented liver volume is **812.40 cm³**."
    ]


def test_agent_tool_result_flags_a_clipped_volume_and_skips_the_percentile():
    refs = [{"organ_name": "liver", "percentile": 80, "basis": "age"}]
    status, text, _actions, is_fact = bp._ai_agent_execute(
        "get_organ_metric",
        {"organ": "liver"},
        metrics=_metrics(True),
        metadata={},
        available_organs=ORGANS,
        references=refs,
    )
    assert status == "Measuring the liver"
    assert "reaches the edge of the scan" in text
    assert "percentile" not in text
    assert is_fact


def test_case_facts_and_grounded_reply_flag_a_clipped_volume():
    facts = bp._ai_case_facts("is the liver volume normal", _metrics(True), {})
    assert "**Liver:** segmented volume at least 812.40 cm³" in facts[0]
    reply = bp._ai_grounded_reply(
        "what is the volume of the liver?",
        [{"type": "get_organ_metric", "organ": "liver", "metric": "volume_cm3"}],
        _metrics(True),
        ORGANS,
        {},
        None,
        "case_measurement",
    )
    assert "reaches the edge of the scan" in reply
    assert "volume is **812.40" not in reply


def test_largest_structure_skips_a_clipped_organ():
    reply = bp._ai_grounded_reply(
        "which is the largest structure?",
        [{"type": "get_largest_structure"}],
        _metrics(True),
        ORGANS,
        {},
        None,
        "case_measurement",
    )
    assert "**spleen**" in reply
    assert "reaches the edge of the scan" in reply
    assert "already measures more than this" in reply
    assert "full volume cannot be measured" in reply


def _reply_for(action, metrics):
    return bp._ai_grounded_reply(
        "which is it?", [{"type": action}], metrics, ORGANS, {}, None, "case_measurement"
    )


def test_largest_structure_notes_a_clipped_organ_that_is_smaller_so_far():
    metrics = [
        bp._ai_public_metric({"organ_name": "liver", "volume_cm3": 50.0, "truncated": True}),
        bp._ai_public_metric({"organ_name": "spleen", "volume_cm3": 200.0}),
    ]
    reply = _reply_for("get_largest_structure", metrics)
    assert "**spleen**" in reply
    assert "leaves out organs that are cut off at the edge of the scan" in reply


def test_largest_structure_has_no_caveat_when_nothing_is_clipped():
    reply = _reply_for("get_largest_structure", _metrics(False))
    assert "**liver**" in reply
    assert "edge of the scan" not in reply


def test_smallest_structure_notes_only_a_clipped_organ_that_could_be_smaller():
    metrics = [
        bp._ai_public_metric({"organ_name": "liver", "volume_cm3": 1500.0, "truncated": True}),
        bp._ai_public_metric({"organ_name": "spleen", "volume_cm3": 200.0}),
    ]
    assert "edge of the scan" not in _reply_for("get_smallest_structure", metrics)
    metrics[0]["volume_cm3"] = 50.0
    reply = _reply_for("get_smallest_structure", metrics)
    assert "**spleen**" in reply
    assert "leaves out organs that are cut off at the edge of the scan" in reply


def test_all_metric_reply_gives_a_clipped_volume_as_a_lower_bound():
    reply = bp._ai_grounded_reply(
        "give me the liver statistics",
        [{"type": "get_organ_metric", "organ": "liver", "metric": "all"}],
        _metrics(True),
        ORGANS,
        {},
        None,
        "case_measurement",
    )
    assert "volume at least **812.40 cm³**" in reply
    assert "mean attenuation **60.0 HU**" in reply
    assert "volume **812.40" not in reply


def test_organ_names_read_in_sentence_case():
    assert bp._ai_display("kidney_left") == "kidney left"
    assert bp._ai_display("adrenal_gland_left.nii.gz") == "adrenal gland left"
    assert bp._ai_display("cbd_stent") == "CBD stent"
    assert bp._ai_cap(bp._ai_display("kidney_left")) == "Kidney left"
    assert bp._ai_cap(bp._ai_display("cbd_stent")) == "CBD stent"
    fact = bp._ai_required_metric_facts(
        [{"type": "get_organ_metric", "organ": "kidney_left", "metric": "volume_cm3"}],
        _metrics(False),
        ORGANS,
    )[0]
    assert fact == "The segmented kidney left volume is **151.20 cm³**."


def test_action_confirmations_use_lower_case_view_and_tool_names():
    text = bp._ai_action_confirmation(
        [
            {"type": "set_view", "view": "axial"},
            {"type": "set_view", "view": "mpr"},
            {"type": "set_view", "view": "3d"},
            {"type": "activate_measurement_tool", "tool": "distance"},
            {"type": "set_zoom", "value": 2},
            {"type": "isolate_organs", "organs": ["kidney_left"]},
        ]
    )
    assert "Switched to the axial view." in text
    assert "Switched to the MPR view." in text
    assert "Switched to the 3D view." in text
    assert "Activated the distance tool." in text
    assert "Set zoom to 2x." in text
    assert "Isolated kidney left." in text


def test_roi_tool_keeps_its_capitals():
    text = bp._ai_action_confirmation([{"type": "activate_measurement_tool", "tool": "roi"}])
    assert text == "Activated the ROI tool."


def test_component_facts_give_a_clipped_combined_total_as_a_lower_bound():
    metrics = [
        bp._ai_public_metric({"organ_name": "kidney_left", "volume_cm3": 150.0, "truncated": True}),
        bp._ai_public_metric({"organ_name": "kidney_right", "volume_cm3": 140.0}),
    ]
    facts = bp._ai_component_facts(
        "what is the volume of the kidney", metrics, ["kidney_left", "kidney_right"]
    )
    assert len(facts) == 1
    assert "kidney left 150.00 cm³, kidney right 140.00 cm³" in facts[0]
    assert "at least **290.00 cm³**" in facts[0]
    whole = [dict(m, truncated=False) for m in metrics]
    facts = bp._ai_component_facts(
        "what is the volume of the kidney", whole, ["kidney_left", "kidney_right"]
    )
    assert "at least" not in facts[0]


LABELS = {
    1: {"key": "adrenal_gland_left", "name": "Left Adrenal Gland"},
    2: {"key": "liver", "name": "Liver"},
}
STRUCTURES = {
    1: {"volume_cm3": 1.2, "slice_range": [10, 20], "centre_slice": 15},
    2: {"volume_cm3": 812.4, "slice_range": [0, 90], "centre_slice": 45},
}


def _labelmap(monkeypatch):
    monkeypatch.setattr(bp, "MESH_LABELS", LABELS)
    monkeypatch.setattr(bp, "_ai_mask_path_for", lambda _case: "labels.nii.gz")
    monkeypatch.setattr(
        bp.lesion_grounding,
        "analyze_structures",
        lambda *_a, **_k: {"available": True, "structures": STRUCTURES},
    )
    monkeypatch.setattr(
        bp.lesion_grounding, "analyze_lesions", lambda *_a, **_k: {"available": False}
    )


def test_case_inventory_uses_sentence_case_and_marks_a_clipped_organ(monkeypatch):
    _labelmap(monkeypatch)
    block = bp._ai_case_inventory("1", _metrics(True)[:1])
    assert "- Liver: at least 812.40 cm³ (reaches the edge of the scan, volume cut off)" in block
    assert "- Adrenal gland left: 1.20 cm³" in block
    assert "Left Adrenal Gland" not in block
    whole = bp._ai_case_inventory("1", _metrics(False)[:1])
    assert "- Liver: 812.40 cm³" in whole
    assert "edge of the scan" not in whole


def test_case_inventory_fallback_marks_a_clipped_organ(monkeypatch):
    monkeypatch.setattr(bp, "_ai_mask_path_for", lambda _case: None)
    monkeypatch.setattr(
        bp.lesion_grounding, "analyze_structures", lambda *_a, **_k: {"available": False}
    )
    monkeypatch.setattr(
        bp.lesion_grounding, "analyze_lesions", lambda *_a, **_k: {"available": False}
    )
    block = bp._ai_case_inventory("1", _metrics(True))
    assert "- Liver: at least 812.40 cm³ (reaches the edge of the scan, volume cut off)" in block
    assert "- Kidney left: 151.20 cm³" in block


def test_structure_facts_inventory_marks_a_clipped_organ(monkeypatch):
    _labelmap(monkeypatch)
    facts = bp._ai_structure_facts("1", "what structures are segmented?", _metrics(True)[:1])
    assert len(facts) == 1
    assert "adrenal gland left 1.20 cm³, liver at least 812.40 cm³" in facts[0]
    assert "cut off" in facts[0]
    assert "Left Adrenal Gland" not in facts[0]
    whole = bp._ai_structure_facts("1", "what structures are segmented?", _metrics(False)[:1])
    assert "liver 812.40 cm³" in whole[0]
    assert "at least" not in whole[0]


def test_structure_facts_slice_range_marks_a_clipped_organ(monkeypatch):
    _labelmap(monkeypatch)
    fact = bp._ai_structure_facts("1", "which slice is the liver on?", _metrics(True)[:1])[0]
    assert "the liver spans axial slices **0–90**" in fact
    assert "at least **812.40 cm³** is shown" in fact
    assert "measures" not in fact
    fact = bp._ai_structure_facts("1", "which slice is the liver on?", _metrics(False)[:1])[0]
    assert "it measures **812.40 cm³**" in fact


class _FakeNii:
    def __init__(self, data):
        self.dataobj = data

        class _Header:
            @staticmethod
            def get_zooms():
                return (10.0, 10.0, 10.0)

        self.header = _Header()


def test_labelmap_metrics_flag_a_mask_that_reaches_the_first_or_last_slice(monkeypatch):
    data = np.zeros((12, 12, 4), dtype=np.int32)
    data[2:6, 2:6, 0:2] = 1  # a large piece on the first slice
    data[2:6, 6:10, 1:3] = 2  # interior only
    monkeypatch.setattr(bp, "MESH_LABELS", LABELS | {2: {"key": "spleen", "name": "Spleen"}})
    monkeypatch.setattr(bp, "_ai_mask_path_for", lambda _case: "labels.nii.gz")
    monkeypatch.setattr(bp, "_ai_local_image_path", lambda _case: None)
    monkeypatch.setattr(bp.nib, "load", lambda _path: _FakeNii(data))
    by_name = {
        m["organ_name"]: m for m in bp._ai_compute_organ_metrics_from_labels("1")["organ_metrics"]
    }
    assert by_name["adrenal_gland_left"]["truncated"] is True
    assert by_name["spleen"]["truncated"] is False


def test_ordinal_suffixes_for_the_percentile_sentence():
    assert [bp._ai_ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100, 111)] == [
        "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "100th", "111th",
    ]


def test_agent_tool_result_names_the_percentile_with_its_ordinal_and_cohort():
    refs = [{"organ_name": "liver", "percentile": 22.4, "basis": "males 60–69"}]
    _status, text, _actions, _is_fact = bp._ai_agent_execute(
        "get_organ_metric",
        {"organ": "liver"},
        metrics=_metrics(False),
        metadata={},
        available_organs=ORGANS,
        references=refs,
    )
    assert "**22nd percentile** of the reference cohort (males 60–69)." in text
