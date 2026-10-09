"""Keyword routing reads whole words, not substrings.

"average", "image" and "stage" contain "age", and "body mass index" contains
"mass", so they were routed to the patient-age reply and the lesion grounding.
"""

import pytest

from api import api_blueprint as bp
import services.ai_reasoning as ai_reasoning


@pytest.mark.parametrize(
    "question",
    [
        "What is the average liver volume for this case?",
        "What is the image resolution of this scan?",
        "Which stage is this case at?",
        "Can you send a message about this case?",
    ],
)
def test_words_that_only_contain_age_are_not_age_questions(question):
    norm = bp._ai_norm(question)
    assert not bp._ai_asks_age(norm)
    assert bp._ai_question_mode(question, []) != "case_metadata"
    reply = bp._ai_case_metadata_reply(norm, {"age": 52})
    assert not reply or "years" not in reply


@pytest.mark.parametrize(
    "question",
    [
        "How old is this patient?",
        "What is this patient's age?",
    ],
)
def test_real_age_questions_still_reach_the_metadata_reply(question):
    assert bp._ai_question_mode(question, []) == "case_metadata"
    reply = bp._ai_case_metadata_reply(bp._ai_norm(question), {"age": 52})
    assert "52 years" in reply


@pytest.mark.parametrize(
    "question",
    [
        "What is body mass index?",
        "How is body mass index calculated?",
        "Is lean body mass different from muscle mass?",
    ],
)
def test_body_measurements_are_not_lesion_questions(question):
    assert not ai_reasoning.asks_about_lesion(question)


@pytest.mark.parametrize(
    "question",
    [
        "Any sign of a pancreatic mass?",
        "Is there a mass in the liver?",
        "Are there any masses?",
        "Is that a cyst?",
        "Is there a nodule on the kidney?",
        "Is there tumor growth?",
    ],
)
def test_real_lesion_words_still_route_to_grounding(question):
    assert ai_reasoning.asks_about_lesion(question)
