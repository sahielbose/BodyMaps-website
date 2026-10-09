"""Lesion answers must come from the labelmap, never from the model.

Two failures from testing are pinned here:

  * "Where is the pancreatic lesion?" names no case, so it was scored as a
    general question and answered with no data at all;
  * with no grounding, one model reported no lesion while another pointed at
    "the reddish-brown one" — a mask colour, not a finding.
"""

import pytest

import services.ai_reasoning as ai_reasoning
import services.lesion_grounding as lesion_grounding


PRESENT = {
    "key": "pancreatic_lesion",
    "display": "pancreatic lesion",
    "organ": "pancreas",
    "present": True,
    "volume_cm3": 12.44,
    "max_diameter_mm": 31.0,
    "region": "head",
    "axial_slice": 142,
    "slice_range": [131, 155],
    "side": "near the midline",
    "foci": 1,
    "contacts": ["pancreatic duct", "common bile duct"],
}

ABSENT = {
    "key": "pancreatic_lesion",
    "display": "pancreatic lesion",
    "organ": "pancreas",
    "present": False,
}


# ---------------------------------------------------------------------------
# Routing: a lesion question must reach the grounding path at all
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "question",
    [
        "Where is the pancreatic lesion?",
        "What is the pancreatic lesion?",
        "Does this case have a pancreatic lesion?",
        "Is there a tumor?",
        "Where is the pancreatic tumour located?",
        "Any sign of a pancreatic mass?",
        "Is this cancer?",
    ],
)
def test_lesion_questions_are_detected(question):
    assert ai_reasoning.asks_about_lesion(question)


@pytest.mark.parametrize(
    "question",
    ["What is the liver volume?", "How old is this patient?", "What is BMI?"],
)
def test_ordinary_questions_are_not_lesion_questions(question):
    assert not ai_reasoning.asks_about_lesion(question)


def test_the_focus_organ_is_extracted():
    assert ai_reasoning.lesion_focus_organs("Where is the pancreatic lesion?") == ["pancreas"]


def test_an_unqualified_tumour_question_has_no_focus():
    # Empty means "report every lesion class" — the question is about all of them.
    assert ai_reasoning.lesion_focus_organs("Is there a tumor?") == []


# ---------------------------------------------------------------------------
# Facts: absence must be stated as plainly as presence
# ---------------------------------------------------------------------------

def test_absence_is_stated_explicitly():
    facts = lesion_grounding.lesion_facts(
        {"available": True, "lesions": [ABSENT]}, ["pancreas"]
    )
    assert len(facts) == 1
    assert "no pancreatic lesion is present" in facts[0].lower()


def test_presence_carries_location_and_size():
    facts = lesion_grounding.lesion_facts(
        {"available": True, "lesions": [PRESENT]}, ["pancreas"]
    )
    joined = " ".join(facts)
    assert "IS present" in joined
    assert "pancreatic head" in joined
    assert "12.44" in joined
    assert "142" in joined
    assert "pancreatic duct" in joined


def test_an_unavailable_labelmap_produces_no_claims():
    assert lesion_grounding.lesion_facts({"available": False}, ["pancreas"]) == []


def test_focus_filters_other_organs():
    analysis = {
        "available": True,
        "lesions": [PRESENT, {**ABSENT, "display": "liver lesion", "organ": "liver"}],
    }
    facts = lesion_grounding.lesion_facts(analysis, ["pancreas"])
    assert len(facts) == 1
    assert "liver" not in facts[0].lower()


def test_has_lesion_reports_none_when_unreadable():
    assert lesion_grounding.has_lesion({"available": False}, "pancreas") is None
    assert lesion_grounding.has_lesion({"available": True, "lesions": [ABSENT]}, "pancreas") is False
    assert lesion_grounding.has_lesion({"available": True, "lesions": [PRESENT]}, "pancreas") is True


# ---------------------------------------------------------------------------
# Reconciliation: a hallucinated tumour must not survive
# ---------------------------------------------------------------------------

def test_a_hallucinated_lesion_is_replaced():
    hallucination = (
        "There is a lesion visible in the pancreatic head, shown as the "
        "reddish-brown region on the scan."
    )
    out = ai_reasoning.reconcile_lesion_answer(
        hallucination, absent_displays=["pancreatic lesion"], present_displays=[]
    )
    assert out != hallucination
    assert "no pancreatic lesion" in out.lower()
    assert "reddish-brown" not in out


def test_a_correct_negative_answer_is_left_alone():
    correct = "No pancreatic lesion is present in this segmentation."
    out = ai_reasoning.reconcile_lesion_answer(
        correct, absent_displays=["pancreatic lesion"], present_displays=[]
    )
    assert out == correct


def test_denying_a_measured_lesion_is_corrected():
    denial = "There is no pancreatic lesion in this case."
    out = ai_reasoning.reconcile_lesion_answer(
        denial, absent_displays=[], present_displays=["pancreatic lesion"]
    )
    assert out != denial
    assert "does contain" in out.lower()


def test_a_grounded_positive_answer_is_left_alone():
    grounded = "This case contains a pancreatic lesion measuring 12.44 cm3 in the head."
    out = ai_reasoning.reconcile_lesion_answer(
        grounded, absent_displays=[], present_displays=["pancreatic lesion"]
    )
    assert out == grounded


# ---------------------------------------------------------------------------
# Prompt scaffolding must never reach the user
# ---------------------------------------------------------------------------

def test_the_segmentation_fact_marker_is_stripped_for_display():
    shown = ai_reasoning.presentable_fact(
        "SEGMENTATION FACT: a pancreatic lesion IS present in this case."
    )
    assert "SEGMENTATION FACT" not in shown
    assert shown.startswith("A pancreatic lesion")
    assert "IS" not in shown.split()
    assert "is present" in shown


def test_instruction_only_facts_are_never_shown():
    assert ai_reasoning.presentable_fact(
        "SEGMENTATION FACT: the lesion classes could not be checked for this "
        "case. Say the segmentation could not be verified and do not state "
        "whether a lesion exists."
    ) == ""


def test_the_prompts_forbid_naming_a_lesion_from_colour():
    for prompt in (
        ai_reasoning.build_system_prompt(has_images=False),
        ai_reasoning.build_system_prompt(has_images=True),
    ):
        assert "SEGMENTATION FACT" in prompt
    vision = ai_reasoning.build_system_prompt(has_images=True)
    assert "colour" in vision.lower() or "color" in vision.lower()


# ---------------------------------------------------------------------------
# Real labelmap analysis (needs scipy; skipped where it isn't installed)
# ---------------------------------------------------------------------------

def _build_mask(tmp_path, with_lesion):
    np = pytest.importorskip("numpy")
    nib = pytest.importorskip("nibabel")
    pytest.importorskip("scipy")

    volume = np.zeros((64, 64, 64), dtype=np.int16)
    volume[20:28, 30:38, 28:36] = 19   # pancreas head
    volume[28:36, 30:38, 28:36] = 18   # pancreas body
    volume[36:44, 30:38, 28:36] = 20   # pancreas tail
    volume[24:40, 34:36, 31:33] = 21   # pancreatic duct
    if with_lesion:
        volume[22:27, 31:36, 29:34] = 22

    path = tmp_path / f"mask_{with_lesion}.nii.gz"
    nib.save(nib.Nifti1Image(volume, np.diag([1.5, 1.5, 2.0, 1.0])), str(path))
    return str(path)


def test_a_lesion_in_the_head_is_located(tmp_path):
    analysis = lesion_grounding.analyze_lesions(_build_mask(tmp_path, True))
    assert analysis["available"]
    entry = next(e for e in analysis["lesions"] if e["organ"] == "pancreas")
    assert entry["present"]
    assert entry["region"] == "head"
    assert entry["volume_cm3"] > 0
    assert "pancreatic duct" in entry.get("contacts", [])


def test_a_clean_case_reports_no_lesion(tmp_path):
    analysis = lesion_grounding.analyze_lesions(_build_mask(tmp_path, False))
    assert analysis["available"]
    entry = next(e for e in analysis["lesions"] if e["organ"] == "pancreas")
    assert entry["present"] is False


def test_a_missing_labelmap_is_reported_as_unavailable():
    analysis = lesion_grounding.analyze_lesions("/nonexistent/mask.nii.gz")
    assert analysis["available"] is False


# ---------------------------------------------------------------------------
# Structure inventory and slice level (the questions that returned nothing)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "question",
    [
        "what are the segmentation values of this case and how many structures are there?",
        "how many structures are there?",
        "list the structures in this scan",
        "what organs are segmented?",
    ],
)
def test_inventory_questions_are_detected(question):
    assert ai_reasoning.asks_for_inventory(question)


@pytest.mark.parametrize(
    "question",
    [
        "What is the slice level of the pancreas head?",
        "which slice is the liver on?",
        "where is the pancreas head?",
    ],
)
def test_slice_level_questions_are_detected(question):
    assert ai_reasoning.asks_for_slice_level(question)


def test_a_volume_question_is_not_a_slice_question():
    assert not ai_reasoning.asks_for_slice_level("what is the volume of the pancreas?")


def test_structures_are_measured_from_the_labelmap(tmp_path):
    np = pytest.importorskip("numpy")
    nib = pytest.importorskip("nibabel")
    pytest.importorskip("scipy")

    volume = np.zeros((64, 64, 64), dtype=np.int16)
    volume[10:30, 10:30, 10:40] = 14   # liver
    volume[30:38, 30:38, 28:36] = 17   # pancreas
    path = tmp_path / "structures.nii.gz"
    nib.save(nib.Nifti1Image(volume, np.diag([1.5, 1.5, 2.0, 1.0])), str(path))

    analysis = lesion_grounding.analyze_structures(str(path))
    assert analysis["available"]
    assert 14 in analysis["structures"] and 17 in analysis["structures"]
    liver = analysis["structures"][14]
    assert liver["volume_cm3"] > 0
    assert liver["slice_range"] == [10, 39]
    assert liver["centre_slice"] == pytest.approx(24, abs=2)


def test_a_missing_labelmap_yields_no_structures():
    assert lesion_grounding.analyze_structures("/nonexistent.nii.gz")["available"] is False


# ---------------------------------------------------------------------------
# Implausible "lesions" must not be given a precise location
# ---------------------------------------------------------------------------

def _lesion_mask(tmp_path, filler, name):
    np = pytest.importorskip("numpy")
    nib = pytest.importorskip("nibabel")
    pytest.importorskip("scipy")
    volume = np.zeros((80, 80, 90), dtype=np.int16)
    volume[30:38, 40:48, 40:50] = 17
    filler(volume, np)
    path = tmp_path / name
    nib.save(nib.Nifti1Image(volume, np.diag([1.5, 1.5, 2.0, 1.0])), str(path))
    return str(path)


def test_an_enormous_blob_is_flagged_as_scattered(tmp_path):
    def fill(volume, np):
        volume[5:75, 5:75, 5:85] = 22   # a "lesion" filling the abdomen
    analysis = lesion_grounding.analyze_lesions(_lesion_mask(tmp_path, fill, "blob.nii.gz"))
    entry = next(e for e in analysis["lesions"] if e["organ"] == "pancreas")
    assert entry["present"] and entry["diffuse"]


def test_speckled_false_positives_are_flagged(tmp_path):
    def fill(volume, np):
        noise = np.random.RandomState(0).rand(70, 70, 80) > 0.997
        region = volume[5:75, 5:75, 5:85]
        volume[5:75, 5:75, 5:85] = np.where(noise, 22, region)
    analysis = lesion_grounding.analyze_lesions(_lesion_mask(tmp_path, fill, "speckle.nii.gz"))
    entry = next(e for e in analysis["lesions"] if e["organ"] == "pancreas")
    assert entry["present"] and entry["diffuse"]


def test_a_compact_lesion_is_not_flagged(tmp_path):
    def fill(volume, np):
        volume[32:36, 42:46, 43:47] = 22
    analysis = lesion_grounding.analyze_lesions(_lesion_mask(tmp_path, fill, "compact.nii.gz"))
    entry = next(e for e in analysis["lesions"] if e["organ"] == "pancreas")
    assert entry["present"] and not entry.get("diffuse")


def test_a_scattered_class_states_no_location():
    entry = {
        "key": "pancreatic_lesion", "display": "pancreatic lesion",
        "organ": "pancreas", "present": True, "volume_cm3": 104.42, "diffuse": True,
    }
    facts = lesion_grounding.lesion_facts({"available": True, "lesions": [entry]}, ["pancreas"])
    text = " ".join(facts)
    assert "104.42" in text
    assert "no single lesion location" in text.lower()
    assert "slice" not in text.lower()


# ---------------------------------------------------------------------------
# Case relevance: the assistant must not depend on enumerating question shapes
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "question",
    [
        "what is the biggest structure in this case?",
        "is the liver enlarged?",
        "which organs are on slice 45?",
        "compare the pancreas and the spleen",
        "how many organs were segmented?",
        "what is the smallest structure here?",
        "does this scan show both kidneys?",
        "what is the mean HU of the kidney?",
        "what values do you have for this case?",
    ],
)
def test_case_questions_are_recognised(question):
    assert ai_reasoning.touches_case(question)


@pytest.mark.parametrize(
    "question",
    [
        "What is BMI?",
        "explain hemochromatosis",
        "what causes obstructive jaundice?",
    ],
)
def test_general_questions_do_not_pull_in_the_case(question):
    assert not ai_reasoning.touches_case(question)


# ---------------------------------------------------------------------------
# A parent structure segmented only in parts
# ---------------------------------------------------------------------------

def test_a_reply_that_is_only_a_question_is_detected():
    assert ai_reasoning.is_only_a_question(
        "What is the window preset used to display the pancreatic lesion?"
    )


def test_an_answer_with_a_closing_question_is_fine():
    assert not ai_reasoning.is_only_a_question(
        "The pancreas measures 64.93 cm3 in total. Want the slice range?"
    )


def test_facts_become_an_answer_when_the_model_gives_none():
    out = ai_reasoning.answer_from_facts([
        "SEGMENTATION FACT: the pancreas is segmented in parts, totalling **64.93 cm³**."
    ])
    assert "SEGMENTATION FACT" not in out
    assert "64.93" in out
