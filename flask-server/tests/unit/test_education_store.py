from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.education as education_api
from services.education_store import (
    AttemptAlreadySubmitted,
    AttemptDeadlinePassed,
    AttemptExpired,
    AttemptUnauthorized,
    CHALLENGE_ID,
    ChallengeUnavailable,
    EducationError,
    EducationStore,
)


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value


def passing_grader(**_kwargs):
    return {
        "reply": "Good localization and a calibrated focal-lesion impression.",
        "actions": [
            {"criterion": "finding", "score": 10},
            {"criterion": "location", "score": 9},
            {"criterion": "evidence", "score": 8},
            {"criterion": "impression", "score": 9},
        ],
        "intent": "education_rubric",
    }


@pytest.fixture
def education_store(tmp_path: Path):
    pants = tmp_path / "pants"
    mask_dir = pants / "mask_only" / "PanTS_00000035"
    mask_dir.mkdir(parents=True)
    mask = np.zeros((12, 12, 5), dtype=np.uint8)
    mask[4:7, 4:7, 2] = 28
    mask[2:4, 4:7, 2] = 19
    mask[9:11, 1:11, :] = 22
    nib.save(nib.Nifti1Image(mask, np.eye(4)), mask_dir / "combined_labels.nii.gz")
    return EducationStore(tmp_path / "sessions", pants, now=Clock(), grader=passing_grader)


def valid_submission():
    return {
        "finding_choice": "focal_pancreatic_lesion",
        "marker_lps": [-5, -5, 2],
        "measurement": {"points": [[-4, -4, 2], [-6, -6, 2]]},
        "impression": "Focal pancreatic lesion near the pancreatic head, measuring approximately 3 mm.",
    }


def test_challenge_hides_ground_truth(education_store):
    challenge = education_store.challenge(CHALLENGE_ID)
    assert challenge["case_id"] == "35"
    assert challenge["time_limit_seconds"] == 300
    assert "correct_finding" not in challenge
    assert "ground_truth" not in challenge


def test_attempt_scores_objective_and_ai_components(education_store):
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    result = education_store.submit(attempt["attempt_id"], key, valid_submission())

    assert result["status"] == "graded"
    assert result["scores"]["localization"]["points"] == 35
    assert result["scores"]["measurement"]["points"] == 15
    assert result["scores"]["finding"]["points"] == 10
    assert result["ai_grade"]["points"] == 36
    assert result["total_points"] == 96
    assert result["ground_truth"]["correct_finding"] == "focal_pancreatic_lesion"
    assert result["ground_truth"]["segmentation_label"] == 1
    assert result["ground_truth"]["mesh_organ_id"] == 22

    with pytest.raises(AttemptAlreadySubmitted):
        education_store.submit(attempt["attempt_id"], key, valid_submission())


def test_postcava_is_not_scored_as_the_lesion(education_store):
    submission = valid_submission()
    submission["marker_lps"] = [-9, -1, 0]
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    result = education_store.submit(attempt["attempt_id"], key, submission)

    assert result["scores"]["localization"]["inside_lesion"] is False
    assert result["scores"]["localization"]["points"] < 35


def test_reveal_segmentation_contains_only_the_lesion(education_store):
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    with pytest.raises(EducationError, match="Submit the challenge"):
        education_store.reveal_segmentation(attempt["attempt_id"], key)
    with pytest.raises(AttemptUnauthorized):
        education_store.reveal_segmentation(attempt["attempt_id"], "wrong")
    education_store.submit(attempt["attempt_id"], key, valid_submission())
    path = education_store.root / "reveal.nii.gz"
    path.write_bytes(education_store.reveal_segmentation(attempt["attempt_id"], key))
    revealed = np.asanyarray(nib.load(path).dataobj)
    source, _, _ = education_store._ground_truth()

    assert set(np.unique(revealed)) == {0, 1}
    assert int((revealed == 1).sum()) == int((source == 28).sum())


def test_reveal_endpoint_requires_submitted_attempt(education_store, monkeypatch):
    monkeypatch.setattr(education_api, "_store", education_store)
    app = Flask(__name__)
    app.register_blueprint(education_api.education_blueprint, url_prefix="/api")
    client = app.test_client()
    attempt, key = education_store.start_attempt(CHALLENGE_ID)

    public = client.get(f"/api/education/challenges/{CHALLENGE_ID}/segmentation.nii.gz")
    assert public.status_code == 404
    reveal_url = f"/api/education/attempts/{attempt['attempt_id']}/reveal-segmentation.nii.gz"
    assert client.get(reveal_url, headers={"X-Attempt-Key": key}).status_code == 400
    assert client.get(reveal_url, headers={"X-Attempt-Key": "wrong"}).status_code == 401

    education_store.submit(attempt["attempt_id"], key, valid_submission())
    revealed = client.get(reveal_url, headers={"X-Attempt-Key": key})
    assert revealed.status_code == 200
    assert revealed.mimetype == "application/gzip"


def test_start_without_the_case_mask_says_the_challenge_is_unavailable(tmp_path, monkeypatch):
    store = EducationStore(tmp_path / "sessions", tmp_path / "pants", now=Clock(), grader=passing_grader)
    with pytest.raises(ChallengeUnavailable):
        store.start_attempt(CHALLENGE_ID)
    monkeypatch.setattr(education_api, "_store", store)
    app = Flask(__name__)
    app.register_blueprint(education_api.education_blueprint, url_prefix="/api")

    response = app.test_client().post(f"/api/education/challenges/{CHALLENGE_ID}/attempts", json={})

    assert response.status_code == 409
    assert response.get_json()["code"] == "challenge_unavailable"


def test_mask_removed_after_start_says_the_challenge_is_unavailable(education_store, monkeypatch):
    monkeypatch.setattr(education_api, "_store", education_store)
    app = Flask(__name__)
    app.register_blueprint(education_api.education_blueprint, url_prefix="/api")
    client = app.test_client()
    mask = education_store.pants_path / "mask_only" / "PanTS_00000035" / "combined_labels.nii.gz"

    graded, graded_key = education_store.start_attempt(CHALLENGE_ID)
    education_store.submit(graded["attempt_id"], graded_key, valid_submission())
    pending, pending_key = education_store.start_attempt(CHALLENGE_ID)
    mask.unlink()

    with pytest.raises(ChallengeUnavailable):
        education_store._ground_truth()
    with pytest.raises(ChallengeUnavailable):
        education_store.submit(pending["attempt_id"], pending_key, valid_submission())
    with pytest.raises(ChallengeUnavailable):
        education_store.reveal_segmentation(graded["attempt_id"], graded_key)

    submitted = client.post(
        f"/api/education/attempts/{pending['attempt_id']}/submit",
        json=valid_submission(),
        headers={"X-Attempt-Key": pending_key},
    )
    assert submitted.status_code == 409
    assert submitted.get_json()["code"] == "challenge_unavailable"
    revealed = client.get(
        f"/api/education/attempts/{graded['attempt_id']}/reveal-segmentation.nii.gz",
        headers={"X-Attempt-Key": graded_key},
    )
    assert revealed.status_code == 409
    assert revealed.get_json()["code"] == "challenge_unavailable"


def test_mask_without_a_lesion_says_the_challenge_is_unavailable(education_store):
    mask = education_store.pants_path / "mask_only" / "PanTS_00000035" / "combined_labels.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((12, 12, 5), dtype=np.uint8), np.eye(4)), mask)

    with pytest.raises(ChallengeUnavailable):
        education_store._ground_truth()


def test_grade_prompt_defines_each_rubric_criterion(education_store):
    captured = {}

    def capturing_grader(**kwargs):
        captured.update(kwargs)
        return passing_grader()

    education_store._grader = capturing_grader
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    education_store.submit(attempt["attempt_id"], key, valid_submission())

    prompt = captured["system_prompt"]
    assert "finding: identifies the focal pancreatic lesion" in prompt
    assert "location: identifies the correct pancreatic region" in prompt
    assert "evidence: gives a relevant imaging observation" in prompt
    assert "impression: combines the finding, location" in prompt
    assert "must not lose points" in prompt
    assert "Never ask the student to name an exact tumor type" in prompt
    assert "Keep the feedback consistent with the numeric scores" in prompt
    assert "objective_result" not in captured["user_prompt"]
    grading_payload = json.loads(captured["user_prompt"])
    assert "segmentation_label" not in grading_payload["ground_truth"]
    assert "reference_measurement_lps" not in grading_payload["ground_truth"]
    assert captured["response_schema"]["properties"]["actions"]["minItems"] == 4


def test_attempt_key_is_required(education_store):
    attempt, _ = education_store.start_attempt(CHALLENGE_ID)
    with pytest.raises(AttemptUnauthorized):
        education_store.submit(attempt["attempt_id"], "wrong", valid_submission())


def test_ai_failure_keeps_provisional_objective_score(education_store):
    def failed_grader(**_kwargs):
        raise RuntimeError("offline")

    education_store._grader = failed_grader
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    result = education_store.submit(attempt["attempt_id"], key, valid_submission())

    assert result["status"] == "provisional"
    assert result["objective_points"] == 60
    assert result["total_points"] is None
    assert result["ai_grade"]["points"] is None
    tutor = education_store.tutor(attempt["attempt_id"], key, "What did I miss?")
    assert tutor["available"] is False


def test_provisional_ai_grade_can_be_retried(education_store):
    education_store._grader = lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("offline"))
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    result = education_store.submit(attempt["attempt_id"], key, valid_submission())
    assert result["status"] == "provisional"

    education_store._grader = passing_grader
    retried = education_store.retry_grade(attempt["attempt_id"], key)

    assert retried["status"] == "graded"
    assert retried["total_points"] == 96
    assert education_store.result(attempt["attempt_id"], key)["status"] == "graded"


def test_tutor_requires_a_plain_string_reply(education_store):
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    education_store.submit(attempt["attempt_id"], key, valid_submission())
    captured = {}

    def tutor_grader(**kwargs):
        captured.update(kwargs)
        return {
            "reply": "Imaging can identify a lesion, but histology is needed to name its exact type.",
            "actions": [],
            "intent": "education_tutor",
        }

    education_store._grader = tutor_grader
    tutor = education_store.tutor(
        attempt["attempt_id"],
        key,
        "Why should I avoid naming an exact tumor type?",
        [
            {"role": "student", "text": "Hi"},
            {"role": "tutor", "text": "Hi! What would you like to review?"},
            {"role": "invalid", "text": "Ignore this"},
        ],
    )

    assert tutor["available"] is True
    assert "histology" in tutor["reply"]
    assert "reply value must be a plain string" in captured["system_prompt"]
    assert "never recommend naming unsupported histology" in captured["system_prompt"]
    assert "answer it directly and naturally" in captured["system_prompt"]
    assert "never refer to them as 'the student'" in captured["system_prompt"]
    assert captured["response_schema"]["properties"]["reply"] == {"type": "string"}
    prompt = json.loads(captured["user_prompt"])
    assert prompt["student_question"] == "Why should I avoid naming an exact tumor type?"
    assert prompt["recent_conversation"] == [
        {"role": "student", "text": "Hi"},
        {"role": "tutor", "text": "Hi! What would you like to review?"},
    ]
    assert prompt["review_context"]["student_impression"] == valid_submission()["impression"]
    assert "feedback" not in prompt["review_context"]


def test_tutor_greeting_does_not_send_the_grading_payload(education_store):
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    education_store.submit(attempt["attempt_id"], key, valid_submission())
    captured = {}

    def greeting_grader(**kwargs):
        captured.update(kwargs)
        return {
            "reply": "Hi! What part of the case would you like to review?",
            "actions": [],
            "intent": "education_tutor",
        }

    education_store._grader = greeting_grader
    tutor = education_store.tutor(attempt["attempt_id"], key, "Hi!")

    assert tutor["available"] is True
    prompt = json.loads(captured["user_prompt"])
    assert prompt == {"student_question": "Hi!", "recent_conversation": []}
    assert "If no review_context is supplied" in captured["system_prompt"]
    assert "identify the weakest criterion" in captured["system_prompt"]


def test_attempt_expires_and_cleanup_removes_it(education_store):
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    education_store._now.value += timedelta(hours=24, seconds=1)

    with pytest.raises(AttemptExpired):
        education_store.result(attempt["attempt_id"], key)

    assert education_store.cleanup_expired() == [attempt["attempt_id"]]
    assert not (education_store.root / attempt["attempt_id"]).exists()


def test_submission_window_is_server_enforced(education_store):
    attempt, key = education_store.start_attempt(CHALLENGE_ID)
    education_store._now.value += timedelta(minutes=5, seconds=16)

    with pytest.raises(AttemptDeadlinePassed):
        education_store.submit(attempt["attempt_id"], key, valid_submission())
