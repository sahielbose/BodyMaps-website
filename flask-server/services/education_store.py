"""Server-owned education challenges, attempts, and deterministic scoring."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import secrets
import shutil
import tempfile
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

import nibabel as nib
import numpy as np

from services.advanced_analysis import lps_to_ijk
from services.case35 import (
    CASE_ID,
    LESION_LABEL,
    load_ground_truth as load_case35_ground_truth,
    mask_path as case35_mask_path,
    reveal_segmentation as case35_reveal_segmentation,
)
from services.ollama_client import DEFAULT_OLLAMA_MODEL, chat_json

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None


CHALLENGE_ID = "pancreas-case-35"
TIME_LIMIT_SECONDS = 300
SUBMISSION_GRACE_SECONDS = 15
ATTEMPT_RETENTION = timedelta(hours=24)
MAX_IMPRESSION_LENGTH = 2_000
MAX_TUTOR_MESSAGE_LENGTH = 1_000
MAX_TUTOR_HISTORY_MESSAGES = 6

RUBRIC_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "actions": {
            "type": "array",
            "minItems": 4,
            "maxItems": 4,
            "items": {
                "type": "object",
                "properties": {
                    "criterion": {
                        "type": "string",
                        "enum": ["finding", "location", "evidence", "impression"],
                    },
                    "score": {"type": "integer", "minimum": 0, "maximum": 10},
                },
                "required": ["criterion", "score"],
                "additionalProperties": False,
            },
        },
        "intent": {"type": "string", "const": "education_rubric"},
    },
    "required": ["reply", "actions", "intent"],
    "additionalProperties": False,
}

TUTOR_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "actions": {"type": "array", "maxItems": 0},
        "intent": {"type": "string", "const": "education_tutor"},
    },
    "required": ["reply", "actions", "intent"],
    "additionalProperties": False,
}

FINDING_CHOICES = [
    {"id": "no_focal_lesion", "label": "No focal pancreatic lesion"},
    {"id": "focal_pancreatic_lesion", "label": "Focal pancreatic lesion"},
    {"id": "diffuse_pancreatic_abnormality", "label": "Diffuse pancreatic abnormality"},
    {"id": "extra_pancreatic_abnormality", "label": "Abnormality centered outside the pancreas"},
]

PUBLIC_CHALLENGE = {
    "challenge_id": CHALLENGE_ID,
    "case_id": CASE_ID,
    "title": "Find the abnormal area in the pancreas",
    "eyebrow": "BodyMaps Solo Challenge 01",
    "prompt": "Review the CT scan, find the most important abnormal area in the pancreas, measure it, and write what you think it shows.",
    "time_limit_seconds": TIME_LIMIT_SECONDS,
    "finding_choices": FINDING_CHOICES,
    "requirements": [
        "Choose what you see on the scan",
        "Place the crosshair in the center of the abnormal area",
        "Measure its widest size in the axial (top-down) view",
        "Write a short conclusion",
    ],
    "scoring": {
        "localization": 35,
        "measurement": 15,
        "finding": 10,
        "impression": 40,
        "time": "tie_break",
    },
}


class EducationError(RuntimeError):
    status_code = 400
    code = "invalid_request"


class ChallengeNotFound(EducationError):
    status_code = 404
    code = "challenge_not_found"


class AttemptNotFound(EducationError):
    status_code = 404
    code = "attempt_not_found"


class AttemptUnauthorized(EducationError):
    status_code = 401
    code = "invalid_attempt_key"


class AttemptAlreadySubmitted(EducationError):
    status_code = 409
    code = "attempt_already_submitted"


class AttemptExpired(EducationError):
    status_code = 410
    code = "attempt_expired"


class AttemptDeadlinePassed(EducationError):
    status_code = 409
    code = "attempt_deadline_passed"


class ChallengeUnavailable(EducationError):
    # The challenge's answer data is not installed. Retrying will not help, so this is a 4xx.
    status_code = 409
    code = "challenge_unavailable"


class AIGradeUnavailable(EducationError):
    status_code = 503
    code = "ai_grade_unavailable"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean_text(value: Any, limit: int, *, required: bool = True) -> str:
    if not isinstance(value, str):
        raise EducationError("Text value must be a string")
    cleaned = "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32).strip()
    if required and not cleaned:
        raise EducationError("Text value cannot be empty")
    if len(cleaned) > limit:
        raise EducationError(f"Text value exceeds {limit} characters")
    return cleaned


def _clean_tutor_history(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    cleaned: list[dict[str, str]] = []
    for item in value[-MAX_TUTOR_HISTORY_MESSAGES:]:
        if not isinstance(item, dict) or item.get("role") not in {"student", "tutor"}:
            continue
        try:
            text = _clean_text(item.get("text", ""), MAX_TUTOR_MESSAGE_LENGTH)
        except EducationError:
            continue
        cleaned.append({"role": item["role"], "text": text})
    return cleaned


def _point(value: Any, label: str) -> list[float] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 3:
        raise EducationError(f"{label} must contain three coordinates")
    result = [float(item) for item in value]
    if not all(math.isfinite(item) for item in result):
        raise EducationError(f"{label} coordinates must be finite")
    return result


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


def _score_localization(mask: np.ndarray, affine: np.ndarray, marker_lps: list[float] | None) -> dict[str, Any]:
    if marker_lps is None:
        return {"points": 0, "max_points": 35, "distance_mm": None, "inside_lesion": False}
    ijk = np.asarray(lps_to_ijk(affine, marker_lps), dtype=int)
    shape = np.asarray(mask.shape[:3], dtype=int)
    if np.all(ijk >= 0) and np.all(ijk < shape) and int(mask[tuple(ijk)]) == LESION_LABEL:
        return {"points": 35, "max_points": 35, "distance_mm": 0.0, "inside_lesion": True}
    lesion_ijk = np.argwhere(mask == LESION_LABEL)
    if lesion_ijk.size == 0:
        return {"points": 0, "max_points": 35, "distance_mm": None, "inside_lesion": False}
    marker_ras = np.asarray([-marker_lps[0], -marker_lps[1], marker_lps[2]], dtype=float)
    lesion_ras = nib.affines.apply_affine(affine, lesion_ijk)
    nearest = float(np.min(np.linalg.norm(lesion_ras - marker_ras, axis=1)))
    points = 20 if nearest <= 10 else 10 if nearest <= 25 else 0
    return {"points": points, "max_points": 35, "distance_mm": round(nearest, 1), "inside_lesion": False}


def _line_intersects_lesion(mask: np.ndarray, affine: np.ndarray, start: list[float], end: list[float]) -> bool:
    for point in np.linspace(np.asarray(start), np.asarray(end), 160):
        ijk = np.asarray(lps_to_ijk(affine, point), dtype=int)
        if np.all(ijk >= 0) and np.all(ijk < np.asarray(mask.shape[:3])) and int(mask[tuple(ijk)]) == LESION_LABEL:
            return True
    return False


def _score_measurement(
    mask: np.ndarray,
    affine: np.ndarray,
    measurement: dict[str, Any] | None,
    reference_mm: float,
) -> dict[str, Any]:
    base = {"points": 0, "max_points": 15, "measured_mm": None, "reference_mm": round(reference_mm, 1), "error_percent": None, "crosses_lesion": False}
    if not isinstance(measurement, dict):
        return base
    points = measurement.get("points")
    if not isinstance(points, list) or len(points) != 2:
        return base
    start = _point(points[0], "measurement start")
    end = _point(points[1], "measurement end")
    if start is None or end is None:
        return base
    measured = float(np.linalg.norm(np.asarray(end) - np.asarray(start)))
    crosses = _line_intersects_lesion(mask, affine, start, end)
    axial = abs(start[2] - end[2]) <= max(2.5, float(nib.affines.voxel_sizes(affine)[2]))
    error = abs(measured - reference_mm) / reference_mm * 100 if reference_mm > 0 else 100.0
    points_awarded = 15 if crosses and axial and error <= 20 else 7.5 if crosses and axial and error <= 40 else 0
    return {
        "points": points_awarded,
        "max_points": 15,
        "measured_mm": round(measured, 1),
        "reference_mm": round(reference_mm, 1),
        "error_percent": round(error, 1),
        "crosses_lesion": crosses,
        "axial": axial,
    }


def _validate_rubric(value: Any) -> tuple[dict[str, int], str] | None:
    if not isinstance(value, dict) or not isinstance(value.get("actions"), list):
        return None
    scores: dict[str, int] = {}
    for item in value["actions"]:
        if not isinstance(item, dict):
            continue
        criterion = str(item.get("criterion", ""))
        if criterion not in {"finding", "location", "evidence", "impression"}:
            continue
        try:
            scores[criterion] = max(0, min(10, int(round(float(item.get("score", 0))))))
        except (TypeError, ValueError):
            continue
    if set(scores) != {"finding", "location", "evidence", "impression"}:
        return None
    reply = _clean_text(value.get("reply", ""), 4_000)
    return scores, reply


class EducationStore:
    def __init__(
        self,
        sessions_dir: str | os.PathLike[str],
        pants_path: str | os.PathLike[str],
        *,
        now: Callable[[], datetime] = utcnow,
        grader: Callable[..., dict[str, Any]] = chat_json,
    ) -> None:
        self.root = Path(sessions_dir).resolve() / "education_attempts"
        self.root.mkdir(parents=True, exist_ok=True)
        self.pants_path = Path(pants_path).resolve()
        self._now = now
        self._grader = grader
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()

    @staticmethod
    def challenge(challenge_id: str) -> dict[str, Any]:
        if challenge_id != CHALLENGE_ID:
            raise ChallengeNotFound("Challenge not found")
        return dict(PUBLIC_CHALLENGE)

    def _mask_path(self) -> Path:
        try:
            return case35_mask_path(self.pants_path)
        except FileNotFoundError as exc:
            raise ChallengeUnavailable(str(exc)) from exc

    @staticmethod
    def _attempt_id(value: str) -> str:
        try:
            parsed = uuid.UUID(str(value))
        except (ValueError, AttributeError) as exc:
            raise AttemptNotFound("Attempt not found") from exc
        return str(parsed)

    def _attempt_dir(self, attempt_id: str) -> Path:
        return self.root / self._attempt_id(attempt_id)

    @contextmanager
    def _locked(self, attempt_id: str) -> Iterator[Path]:
        attempt_id = self._attempt_id(attempt_id)
        with self._locks_guard:
            lock = self._locks.setdefault(attempt_id, threading.RLock())
        with lock:
            directory = self._attempt_dir(attempt_id)
            if not (directory / "attempt.json").is_file():
                raise AttemptNotFound("Attempt not found")
            with (directory / ".lock").open("a+b") as lock_file:
                if fcntl is not None:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    yield directory
                finally:
                    if fcntl is not None:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _read(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            raise AttemptNotFound("Attempt not found") from exc
        if not isinstance(value, dict):
            raise AttemptNotFound("Attempt not found")
        return value

    @staticmethod
    def _public_attempt(attempt: dict[str, Any]) -> dict[str, Any]:
        return {key: attempt[key] for key in ("attempt_id", "challenge_id", "started_at", "deadline_at", "delete_at", "status") if key in attempt}

    def start_attempt(self, challenge_id: str) -> tuple[dict[str, Any], str]:
        self.challenge(challenge_id)
        self._mask_path()
        attempt_id = str(uuid.uuid4())
        key = secrets.token_urlsafe(32)
        started = self._now()
        attempt = {
            "attempt_id": attempt_id,
            "challenge_id": challenge_id,
            "key_hash": _hash_secret(key),
            "started_at": isoformat(started),
            "deadline_at": isoformat(started + timedelta(seconds=TIME_LIMIT_SECONDS)),
            "delete_at": isoformat(started + ATTEMPT_RETENTION),
            "status": "active",
        }
        directory = self.root / attempt_id
        directory.mkdir(mode=0o700)
        _atomic_json(directory / "attempt.json", attempt)
        return self._public_attempt(attempt), key

    def _authorized(self, directory: Path, key: str) -> dict[str, Any]:
        attempt = self._read(directory / "attempt.json")
        if not key or not hmac.compare_digest(_hash_secret(key), attempt.get("key_hash", "")):
            raise AttemptUnauthorized("Invalid attempt key")
        if parse_time(attempt["delete_at"]) <= self._now():
            raise AttemptExpired("Attempt has expired")
        return attempt

    def _ground_truth(self) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
        try:
            mask, affine, ground_truth = load_case35_ground_truth(self.pants_path)
        except (FileNotFoundError, ValueError) as exc:
            # The mask is missing or holds no usable lesion, which no retry can fix.
            raise ChallengeUnavailable(str(exc)) from exc
        ground_truth["teaching_points"] = [
            f"The highlighted area shows the abnormality in the {ground_truth['location']}.",
            "Use the top-down (axial) CT view and measure the slice where the abnormality looks widest.",
            "In your conclusion, say what you found, where it is, and what you saw on the scan. Do not guess the exact tumor type.",
        ]
        return mask, affine, ground_truth

    def reveal_segmentation(self, attempt_id: str, key: str) -> bytes:
        """Return the lesion overlay only for an authorized submitted attempt."""
        with self._locked(attempt_id) as directory:
            attempt = self._authorized(directory, key)
            if not isinstance(attempt.get("result"), dict):
                raise EducationError("Submit the challenge before revealing the segmentation")
            try:
                return case35_reveal_segmentation(self.pants_path)
            except (FileNotFoundError, ValueError) as exc:
                raise ChallengeUnavailable(str(exc)) from exc

    def _grade_impression(self, impression: str, ground_truth: dict[str, Any], _objective: dict[str, Any]) -> dict[str, Any]:
        system_prompt = """
You are grading only the student's written impression in a low-stakes medical-student CT interpretation exercise. Grade clinical content, not prose style, and use only the supplied student impression and ground truth. Do not infer credit from any finding choice, marker, measurement tool, or objective score; those are graded separately.

Score each criterion independently from 0 to 10:
- finding: identifies the focal pancreatic lesion or equivalent abnormal area.
- location: identifies the correct pancreatic region.
- evidence: gives a relevant imaging observation, such as the approximate axial measurement.
- impression: combines the finding, location, and supporting observation into a concise conclusion without inventing an exact tumor type or unsupported histology.

Use 10 when the criterion is explicitly correct, 5 when it is partly correct or vague, and 0 when it is absent or contradicted. A statement that the exact tumor type cannot be determined from this scan is appropriately calibrated and must not lose points. Never ask the student to name an exact tumor type or unsupported histology. Keep the feedback consistent with the numeric scores. Return JSON only as {"reply":"brief specific teaching feedback","actions":[{"criterion":"finding","score":0},{"criterion":"location","score":0},{"criterion":"evidence","score":0},{"criterion":"impression","score":0}],"intent":"education_rubric"}.
""".strip()
        clinical_ground_truth = {
            "finding": ground_truth["correct_finding_label"],
            "location": ground_truth["location"],
            "reference_diameter_mm": ground_truth["reference_diameter_mm"],
            "teaching_points": ground_truth["teaching_points"],
        }
        response = self._grader(
            model=DEFAULT_OLLAMA_MODEL,
            system_prompt=system_prompt,
            user_prompt=json.dumps({
                "student_impression": impression,
                "ground_truth": clinical_ground_truth,
            }, ensure_ascii=False),
            response_schema=RUBRIC_RESPONSE_SCHEMA,
            temperature=0.0,
        )
        validated = _validate_rubric(response)
        if validated is None:
            raise EducationError("AI rubric returned an invalid result")
        scores, feedback = validated
        return {
            "status": "graded",
            "model": DEFAULT_OLLAMA_MODEL,
            "rubric_version": 1,
            "criteria": scores,
            "points": sum(scores.values()),
            "max_points": 40,
            "feedback": feedback,
        }

    def submit(self, attempt_id: str, key: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._locked(attempt_id) as directory:
            attempt = self._authorized(directory, key)
            if attempt.get("status") != "active":
                raise AttemptAlreadySubmitted("Attempt has already been submitted")
            submitted = self._now()
            deadline = parse_time(attempt["deadline_at"]) + timedelta(seconds=SUBMISSION_GRACE_SECONDS)
            if submitted > deadline:
                raise AttemptDeadlinePassed("The submission window has closed")
            finding = _clean_text(payload.get("finding_choice", ""), 80)
            if finding not in {choice["id"] for choice in FINDING_CHOICES}:
                raise EducationError("Choose a valid imaging finding")
            impression = _clean_text(payload.get("impression", ""), MAX_IMPRESSION_LENGTH)
            marker = _point(payload.get("marker_lps"), "marker")
            measurement = payload.get("measurement") if isinstance(payload.get("measurement"), dict) else None
            mask, affine, ground_truth = self._ground_truth()
            localization = _score_localization(mask, affine, marker)
            measurement_score = _score_measurement(mask, affine, measurement, float(ground_truth["reference_diameter_mm"]))
            finding_score = {"points": 10 if finding == ground_truth["correct_finding"] else 0, "max_points": 10, "selected": finding, "correct": ground_truth["correct_finding"]}
            objective = {
                "localization": localization,
                "measurement": measurement_score,
                "finding": finding_score,
            }
            objective_points = float(localization["points"]) + float(measurement_score["points"]) + float(finding_score["points"])
            elapsed = min(TIME_LIMIT_SECONDS, max(0, round((submitted - parse_time(attempt["started_at"])).total_seconds())))
            try:
                ai_grade = self._grade_impression(impression, ground_truth, objective)
                status = "graded"
            except Exception:
                ai_grade = {
                    "status": "provisional",
                    "model": DEFAULT_OLLAMA_MODEL,
                    "rubric_version": 1,
                    "criteria": None,
                    "points": None,
                    "max_points": 40,
                    "feedback": None,
                }
                status = "provisional"
            total = round(objective_points + (float(ai_grade["points"]) if ai_grade["points"] is not None else 0), 1)
            result = {
                "attempt_id": attempt_id,
                "challenge_id": CHALLENGE_ID,
                "status": status,
                "submitted_at": isoformat(submitted),
                "elapsed_seconds": elapsed,
                "objective_points": round(objective_points, 1),
                "total_points": total if status == "graded" else None,
                "max_points": 100,
                "scores": objective,
                "ai_grade": ai_grade,
                "ground_truth": ground_truth,
                "student": {
                    "finding_choice": finding,
                    "marker_lps": marker,
                    "measurement": measurement,
                    "impression": impression,
                },
            }
            attempt["status"] = status
            attempt["result"] = result
            _atomic_json(directory / "attempt.json", attempt)
            return result

    def result(self, attempt_id: str, key: str) -> dict[str, Any]:
        with self._locked(attempt_id) as directory:
            attempt = self._authorized(directory, key)
            result = attempt.get("result")
            if not isinstance(result, dict):
                raise EducationError("Attempt has not been submitted")
            return result

    def retry_grade(self, attempt_id: str, key: str) -> dict[str, Any]:
        with self._locked(attempt_id) as directory:
            attempt = self._authorized(directory, key)
            result = attempt.get("result")
            if not isinstance(result, dict):
                raise EducationError("Submit the challenge before retrying the AI grade")
            if result.get("status") == "graded":
                return result
            try:
                ai_grade = self._grade_impression(
                    result["student"]["impression"],
                    result["ground_truth"],
                    result["scores"],
                )
            except Exception as exc:
                raise AIGradeUnavailable("AI grading remains unavailable; your objective score is preserved") from exc
            result["status"] = "graded"
            result["ai_grade"] = ai_grade
            result["total_points"] = round(float(result["objective_points"]) + float(ai_grade["points"]), 1)
            attempt["status"] = "graded"
            attempt["result"] = result
            _atomic_json(directory / "attempt.json", attempt)
            return result

    def tutor(self, attempt_id: str, key: str, message: str, history: Any = None) -> dict[str, Any]:
        with self._locked(attempt_id) as directory:
            attempt = self._authorized(directory, key)
            result = attempt.get("result")
            if not isinstance(result, dict):
                raise EducationError("Submit the challenge before opening the tutor")
            clean_message = _clean_text(message, MAX_TUTOR_MESSAGE_LENGTH)
            if result.get("status") != "graded":
                return {"available": False, "reply": "The AI tutor is unavailable. Use the revealed overlay and teaching points to review this case."}
            recent_history = _clean_tutor_history(history)
            review_context = {
                "student_impression": result["student"]["impression"],
                "rubric_scores": result["ai_grade"]["criteria"],
                "objective_scores": result["scores"],
                "ground_truth": {
                    "finding": result["ground_truth"]["correct_finding_label"],
                    "location": result["ground_truth"]["location"],
                    "reference_diameter_mm": result["ground_truth"]["reference_diameter_mm"],
                    "teaching_points": result["ground_truth"]["teaching_points"],
                },
            }
            normalized_message = clean_message.casefold().strip(" \n\t.!?")
            is_greeting = normalized_message in {
                "hi", "hello", "hey", "hi there", "hello there", "hey there",
            }
            prompt_payload = {
                "student_question": clean_message,
                "recent_conversation": recent_history,
            }
            if not is_greeting:
                prompt_payload["review_context"] = review_context
            try:
                response = self._grader(
                    model=DEFAULT_OLLAMA_MODEL,
                    system_prompt="You are a friendly medical-imaging tutor speaking directly with a student after a low-stakes exercise. The student's latest question is the primary task: answer it directly and naturally in 1 to 3 short sentences. Address the student as 'you'; never refer to them as 'the student'. Do not repeat or summarize the entire grade unless the question asks for it. If no review_context is supplied, respond conversationally and invite a case-related question. For improvement questions, use the rubric scores to identify the weakest criterion and give one concrete next step; do not claim something is missing when it is already present in the student's impression. Use only the supplied review context, acknowledge uncertainty, and do not invent pathology or personalized medical advice. A CT finding alone does not establish an exact tumor type, so praise calibrated uncertainty and never recommend naming unsupported histology. Return exactly one JSON object as {\"reply\":\"direct answer to the latest question\",\"actions\":[],\"intent\":\"education_tutor\"}. The reply value must be a plain string, not an object or list.",
                    user_prompt=json.dumps(prompt_payload, ensure_ascii=False),
                    response_schema=TUTOR_RESPONSE_SCHEMA,
                    temperature=0.2,
                )
                reply = _clean_text(response.get("reply", ""), 4_000)
            except Exception:
                return {"available": False, "reply": "The AI tutor is temporarily unavailable. Use the revealed overlay and teaching points to review this case."}
            return {"available": True, "reply": reply, "model": DEFAULT_OLLAMA_MODEL}

    def cleanup_expired(self) -> list[str]:
        removed: list[str] = []
        for child in list(self.root.iterdir()):
            if not child.is_dir():
                continue
            try:
                attempt_id = self._attempt_id(child.name)
                with self._locked(attempt_id) as directory:
                    attempt = self._read(directory / "attempt.json")
                    if parse_time(attempt["delete_at"]) > self._now():
                        continue
                shutil.rmtree(child, ignore_errors=True)
                if not child.exists():
                    removed.append(attempt_id)
            except (EducationError, OSError, ValueError, KeyError):
                continue
        return removed
