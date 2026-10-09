"""Answer-shaping rules for the BodyMaps AI assistant.

Each test below is a regression: the assistant shipped the failing behavior at
some point, and the case is written the way it was actually reported.
"""

import services.ai_reasoning as ai_reasoning


BILIRUBIN_MESSAGE = """Total Bilirubin: 4.2 mg/dL (Elevated)
Direct (Conjugated) Bilirubin: 3.1 mg/dL (Conjugated predominance)
Indirect (Unconjugated) Bilirubin: 1.1 mg/dL

RUQ Abdominal Ultrasound: Cholelithiasis present without gallbladder wall
thickening. Common bile duct (CBD) is dilated at 9.5 mm.
MRCP: Confirms a 5 mm gallstone in the distal common bile duct with upstream
intrahepatic and extrahepatic biliary ductal dilation."""

CASE_FACTS = [
    "**Liver:** segmented volume 1209.11 cm³, mean attenuation 67.9 HU",
    "**Age:** 52.0",
    "**Sex:** M",
    "**Spleen:** segmented volume 180.40 cm³",
]


# ---------------------------------------------------------------------------
# Relevance gate
# ---------------------------------------------------------------------------

def test_demographics_are_not_appended_to_a_lab_result_question():
    # Reported failure: pasting bilirubin values and an MRCP report was answered
    # with "The liver volume is 1209.11 cm3 ... Age: 52.0".
    kept = ai_reasoning.relevant_facts(CASE_FACTS, BILIRUBIN_MESSAGE)

    assert not any("Age" in fact for fact in kept)
    assert not any("Sex" in fact for fact in kept)


def test_an_unrelated_organ_is_not_appended():
    kept = ai_reasoning.relevant_facts(CASE_FACTS, BILIRUBIN_MESSAGE)

    assert not any("Spleen" in fact for fact in kept)


def test_a_hepatobiliary_question_keeps_the_liver_fact():
    # "intrahepatic" is a liver reference, so the liver measurement is on topic.
    kept = ai_reasoning.relevant_facts(CASE_FACTS, BILIRUBIN_MESSAGE)

    assert any("Liver" in fact for fact in kept)


def test_an_explicit_measurement_question_keeps_its_fact():
    kept = ai_reasoning.relevant_facts(CASE_FACTS, "What is the liver volume in this case?")

    assert any("1209.11" in fact for fact in kept)


def test_a_demographics_question_keeps_the_age():
    kept = ai_reasoning.relevant_facts(CASE_FACTS, "How old is this patient?")

    assert any("Age" in fact for fact in kept)


def test_forced_facts_survive_the_gate():
    forced = ["The segmented Pancreas volume is **82.10 cm³**."]
    kept = ai_reasoning.relevant_facts([], "anything at all", always_include=forced)

    assert kept == forced


# ---------------------------------------------------------------------------
# Follow-up question guarantee
# ---------------------------------------------------------------------------

def test_a_vision_answer_always_ends_by_asking_what_to_look_at_next():
    reply = (
        "In the axial pane the pancreatic head sits medial to the duodenum. "
        "The contrast phase cannot be determined from this capture."
    )

    out = ai_reasoning.ensure_followup(
        reply,
        "trace the pancreas across the panes",
        has_images=True,
        has_case=True,
        force=True,
    )

    assert out.rstrip().endswith("?")
    assert "pancreas" in out.lower()


def test_an_answer_that_admits_missing_information_asks_for_it():
    reply = "I would need more information to say whether this is normal."

    out = ai_reasoning.ensure_followup(
        reply, "is the pancreas normal", has_images=False, has_case=True
    )

    assert out.rstrip().endswith("?")


def test_a_complete_text_answer_is_left_alone():
    reply = "Hemochromatosis is the most likely diagnosis; check ferritin and the HFE gene."

    out = ai_reasoning.ensure_followup(
        reply, "52-year-old man with fatigue", has_images=False, has_case=False
    )

    assert out == reply


def test_an_existing_closing_question_is_not_duplicated():
    reply = "The kidneys look symmetric. Want me to check a lower slice?"

    out = ai_reasoning.ensure_followup(
        reply, "compare the kidneys", has_images=True, has_case=True, force=True
    )

    assert out == reply


def test_a_mid_paragraph_question_does_not_count_as_a_closing_question():
    reply = (
        "Why does a head tumor jaundice earlier? Because it obstructs the bile "
        "duct sooner than a tail tumor does."
    )

    out = ai_reasoning.ensure_followup(
        reply, "explain pancreatic head versus tail", has_images=True, has_case=True, force=True
    )

    assert out != reply
    assert out.rstrip().endswith("?")


# ---------------------------------------------------------------------------
# Failure text
# ---------------------------------------------------------------------------

def test_a_missing_vision_model_reply_is_plain_language(capsys):
    reply = ai_reasoning.model_offline_reply(
        has_images=True,
        vision_model_missing=True,
        configured_vision_model="qwen3-vl:4b",
    )

    # The bubble is read by a visitor who cannot pull a model or restart the
    # backend; the admin hint goes to the server log.
    assert "ollama" not in reply.lower()
    assert "backend" not in reply
    assert "`" not in reply
    assert "?" not in reply
    assert "without them" in reply
    assert "ollama pull qwen3-vl:4b" in capsys.readouterr().out


def test_the_offline_reply_never_recites_measurements():
    reply = ai_reasoning.model_offline_reply(has_images=False)

    assert "cm³" not in reply
    assert "HU" not in reply


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def test_the_vision_prompt_is_only_attached_when_images_are():
    with_images = ai_reasoning.build_system_prompt(has_images=True)
    without_images = ai_reasoning.build_system_prompt(has_images=False)

    assert "ATTACHED CT VIEWER SCREENSHOTS" in with_images
    assert "ATTACHED CT VIEWER SCREENSHOTS" not in without_images


def test_the_vision_prompt_covers_the_screenshot_artifacts():
    prompt = ai_reasoning.build_system_prompt(has_images=True)

    # The artifacts a model misreads without being told: mask colors read as
    # pathology, crosshairs read as hardware, corner numbers read as patient data.
    assert "SEGMENTATION MASKS" in prompt
    assert "crosshair" in prompt.lower()
    assert "window width/level" in prompt


def test_every_prompt_forbids_substituting_measurements_for_an_answer():
    prompt = ai_reasoning.build_system_prompt(has_images=False)

    assert "STAY ON THE QUESTION" in prompt


def test_the_legend_fact_lists_every_visible_organ_color():
    legend = [
        {"organ": "liver", "color": "brownish red"},
        {"organ": "left_kidney", "color": "teal"},
    ]

    fact = ai_reasoning.build_legend_fact(legend)

    assert "liver: brownish red" in fact
    assert "left kidney: teal" in fact


def test_no_legend_produces_no_fact():
    assert ai_reasoning.build_legend_fact([]) is None
