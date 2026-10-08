"""REST API for BodyMaps education challenges."""

from __future__ import annotations

import io
import threading
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from constants import Constants
from services.education_store import EducationError, EducationStore
from services.live_quiz import QuizPackError, get_registry, public_pack
from services.quiz_practice_store import QuizPracticeError, QuizPracticeStore
from services.quiz_telemetry import ALLOWED_REPORT_CATEGORIES
from services.request_limits import PersistentRateLimiter, trusted_client_ip


education_blueprint = Blueprint("education", __name__)
_quiz_creation_limiter: PersistentRateLimiter | None = None
_quiz_creation_limiter_lock = threading.Lock()
QUIZ_CREATION_LIMIT = 30
QUIZ_CREATION_WINDOW_SECONDS = 60 * 60
_store: EducationStore | None = None
_store_lock = threading.Lock()
_quiz_practice_store: QuizPracticeStore | None = None
_quiz_practice_lock = threading.Lock()


def get_education_store() -> EducationStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = EducationStore(Constants.SESSIONS_DIR_NAME, Constants.PANTS_PATH)
    return _store


def get_quiz_practice_store() -> QuizPracticeStore:
    global _quiz_practice_store
    if _quiz_practice_store is None:
        with _quiz_practice_lock:
            if _quiz_practice_store is None:
                _quiz_practice_store = QuizPracticeStore(
                    Constants.SESSIONS_DIR_NAME,
                    Constants.PANTS_PATH,
                )
    return _quiz_practice_store


def _attempt_key() -> str:
    return request.headers.get("X-Attempt-Key", "")


def _json_object() -> dict:
    body = request.get_json(silent=True)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise EducationError("JSON body must be an object")
    return body


@education_blueprint.errorhandler(EducationError)
def handle_education_error(error: EducationError):
    return jsonify({"error": str(error), "code": error.code}), error.status_code


@education_blueprint.errorhandler(QuizPackError)
def handle_quiz_pack_error(error: QuizPackError):
    return jsonify({"error": str(error), "code": "invalid_quiz_pack_request"}), 400


@education_blueprint.errorhandler(QuizPracticeError)
def handle_quiz_practice_error(error: QuizPracticeError):
    return jsonify({"error": str(error), "code": error.code}), error.status_code


@education_blueprint.after_request
def education_headers(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@education_blueprint.get("/education/challenges/<challenge_id>")
def get_challenge(challenge_id: str):
    return jsonify(get_education_store().challenge(challenge_id))


@education_blueprint.get("/education/quiz-playlists")
def get_quiz_playlists():
    return jsonify({"playlists": get_registry().public_playlists()})


@education_blueprint.post("/education/quiz-playlists/<playlist_id>/select")
def select_quiz_playlist_pack(playlist_id: str):
    body = _json_object()
    excluded = body.get("exclude_pack_ids") or []
    if not isinstance(excluded, list) or not all(isinstance(item, str) for item in excluded):
        raise QuizPackError("exclude_pack_ids must be a string list")
    pack = get_registry().select(
        playlist_id,
        seed=str(body.get("seed", "default")),
        exclude_pack_ids=excluded,
    )
    return jsonify({"pack": public_pack(pack, choice_seed=f"select:{body.get('seed', 'default')}")})


@education_blueprint.get("/education/quiz-packs")
def find_quiz_pack():
    """The quiz pack for one case (?case_id=35), so a case page can offer practice on it."""
    case_id = request.args.get("case_id", "").strip()
    if not case_id:
        raise QuizPackError("case_id is required")
    pack = get_registry().pack_for_case(case_id)
    if pack is None:
        return jsonify({"pack": None})
    return jsonify({"pack": {
        "pack_id": pack["pack_id"],
        "case_id": pack["case_id"],
        "title": pack["title"],
        "difficulty": pack["difficulty"],
    }})


@education_blueprint.get("/education/quiz-packs/<pack_id>")
def get_quiz_pack(pack_id: str):
    return jsonify(public_pack(get_registry().get(pack_id), choice_seed=f"preview:{pack_id}"))


@education_blueprint.post("/education/quiz-packs/<pack_id>/reports")
def report_quiz_pack(pack_id: str):
    pack = get_registry().get(pack_id)
    body = _json_object()
    category = body.get("category")
    if category not in ALLOWED_REPORT_CATEGORIES:
        raise QuizPackError("Content report category is invalid")
    report_id = get_quiz_practice_store().telemetry.record(
        "content_report",
        pack_id=pack["pack_id"],
        case_id=pack["case_id"],
        mode=str(body.get("mode")) if body.get("mode") in {"solo", "race"} else "unspecified",
        payload={"category": category},
    )
    return jsonify({"report_id": report_id, "status": "recorded"}), 201


def _quiz_attempt_key() -> str:
    return request.headers.get("X-Quiz-Attempt-Key", "")


def _check_attempt_creation_rate(namespace: str) -> None:
    global _quiz_creation_limiter
    if _quiz_creation_limiter is None:
        with _quiz_creation_limiter_lock:
            if _quiz_creation_limiter is None:
                path = Path(Constants.SESSIONS_DIR_NAME) / "request-rate-limits.sqlite3"
                _quiz_creation_limiter = PersistentRateLimiter(path)
    ip = trusted_client_ip(request.remote_addr, request.headers)
    if not _quiz_creation_limiter.allow(
        namespace, ip, QUIZ_CREATION_LIMIT, QUIZ_CREATION_WINDOW_SECONDS
    ):
        error = QuizPracticeError("Too many quiz attempts created; try again later")
        error.status_code = 429
        error.code = "quiz_attempt_rate_limited"
        raise error


@education_blueprint.post("/education/quiz-packs/<pack_id>/attempts")
def start_quiz_practice_attempt(pack_id: str):
    _check_attempt_creation_rate("quiz_attempt_create")
    attempt, key = get_quiz_practice_store().start(pack_id)
    return jsonify({**attempt, "attempt_key": key}), 201


@education_blueprint.post("/education/quiz-attempts/<attempt_id>/submit")
def submit_quiz_practice_attempt(attempt_id: str):
    body = _json_object()
    return jsonify(get_quiz_practice_store().submit(
        attempt_id,
        _quiz_attempt_key(),
        body.get("answers"),
    ))


@education_blueprint.get("/education/quiz-attempts/<attempt_id>/result")
def get_quiz_practice_result(attempt_id: str):
    return jsonify(get_quiz_practice_store().result(attempt_id, _quiz_attempt_key()))


@education_blueprint.get("/education/quiz-attempts/<attempt_id>/reveal-segmentation.nii.gz")
def get_quiz_practice_reveal(attempt_id: str):
    return send_file(
        io.BytesIO(get_quiz_practice_store().reveal_segmentation(attempt_id, _quiz_attempt_key())),
        mimetype="application/gzip",
        download_name=f"{attempt_id}-quiz-reveal.nii.gz",
    )


@education_blueprint.get("/education/attempts/<attempt_id>/reveal-segmentation.nii.gz")
def get_challenge_segmentation(attempt_id: str):
    return send_file(
        io.BytesIO(get_education_store().reveal_segmentation(attempt_id, _attempt_key())),
        mimetype="application/gzip",
        download_name=f"{attempt_id}-lesion-reveal.nii.gz",
    )


@education_blueprint.post("/education/challenges/<challenge_id>/attempts")
def start_attempt(challenge_id: str):
    _check_attempt_creation_rate("challenge_attempt_create")
    attempt, key = get_education_store().start_attempt(challenge_id)
    return jsonify({**attempt, "attempt_key": key}), 201


@education_blueprint.post("/education/attempts/<attempt_id>/submit")
def submit_attempt(attempt_id: str):
    body = _json_object()
    return jsonify(get_education_store().submit(attempt_id, _attempt_key(), body))


@education_blueprint.get("/education/attempts/<attempt_id>/result")
def get_attempt_result(attempt_id: str):
    return jsonify(get_education_store().result(attempt_id, _attempt_key()))


@education_blueprint.post("/education/attempts/<attempt_id>/retry-grade")
def retry_attempt_grade(attempt_id: str):
    return jsonify(get_education_store().retry_grade(attempt_id, _attempt_key()))


@education_blueprint.post("/education/attempts/<attempt_id>/tutor")
def tutor(attempt_id: str):
    body = _json_object()
    return jsonify(get_education_store().tutor(
        attempt_id,
        _attempt_key(),
        body.get("message", ""),
        body.get("history"),
    ))
