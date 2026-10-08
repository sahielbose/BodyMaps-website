"""Immutable quiz-pack registry, public projections, scoring, and playlists."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


QUIZ_PACK_ID = "radworld-case-35-v1"
CATALOG_VERSION = 1
ALLOWED_TIMERS = {None, 15, 30, 60}
QUESTION_ORDER = ("organ", "presence", "location", "conclusion")
V2_QUESTION_ORDER = ("organ", "presence", "location", "report_finding", "conclusion")
APPROVED_STATUSES = {"approved"}
DEFAULT_CATALOG_PATH = Path(__file__).with_name("quiz_catalog.v1.json")

PLAYLIST_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {
        "playlist_id": "foundations-v1",
        "version": 1,
        "title": "Foundations",
        "description": "Easier available cases with a 70/30 positive-to-normal mix.",
        "difficulty": {"easy"},
        "positive_weight": 7,
        "normal_weight": 3,
    },
    {
        "playlist_id": "localization-measurement-v1",
        "version": 1,
        "title": "Localization & Measurement",
        "description": "Tumor-positive cases emphasizing pancreatic region and axial size.",
        "difficulty": {"easy", "medium", "hard"},
        "positive_weight": 1,
        "normal_weight": 0,
    },
    {
        "playlist_id": "mixed-challenge-v1",
        "version": 1,
        "title": "Mixed Challenge",
        "description": "Full available bank with a seeded 70/30 positive-to-normal mix.",
        "difficulty": {"easy", "medium", "hard"},
        "positive_weight": 7,
        "normal_weight": 3,
    },
)


class QuizPackError(ValueError):
    """Raised when catalog content or selection input violates pack contracts."""


def _clone(value: Any) -> Any:
    return copy.deepcopy(value)


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise QuizPackError(f"{field} must be a non-empty string")
    return value.strip()


def validate_pack(pack: Any) -> dict[str, Any]:
    """Validate one full server-side pack and return a detached copy."""
    if not isinstance(pack, dict):
        raise QuizPackError("Quiz pack must be an object")
    result = _clone(pack)
    _require_string(result.get("pack_id"), "pack_id")
    if not isinstance(result.get("version"), int) or result["version"] < 1:
        raise QuizPackError("version must be a positive integer")
    case_id = _require_string(str(result.get("case_id", "")), "case_id")
    if not case_id.isdigit():
        raise QuizPackError("case_id must be numeric")
    if result.get("difficulty") not in {"easy", "medium", "hard"}:
        raise QuizPackError("difficulty must be easy, medium, or hard")
    if not isinstance(result.get("tags"), list) or not all(
        isinstance(tag, str) and tag for tag in result["tags"]
    ):
        raise QuizPackError("tags must be a non-empty string list")
    for field in ("provenance", "generator_version", "validator_version"):
        if field == "provenance":
            if not isinstance(result.get(field), dict):
                raise QuizPackError("provenance must be an object")
        else:
            _require_string(result.get(field), field)
    approval = result.get("approval")
    if not isinstance(approval, dict) or approval.get("status") not in {
        "pending", "approved", "quarantined", "rejected"
    }:
        raise QuizPackError("approval.status is invalid")
    truth = result.get("ground_truth")
    if not isinstance(truth, dict):
        raise QuizPackError("ground_truth must be an object")
    if not isinstance(truth.get("lesion_present"), bool):
        raise QuizPackError("ground_truth.lesion_present must be boolean")
    center = truth.get("crosshair_lps")
    if not isinstance(center, list) or len(center) != 3 or not all(
        isinstance(value, (int, float)) and math.isfinite(float(value)) for value in center
    ):
        raise QuizPackError("ground_truth.crosshair_lps must contain three finite numbers")
    descriptor = truth.get("reveal_mask")
    if not isinstance(descriptor, dict):
        raise QuizPackError("ground_truth.reveal_mask must be an object")
    if truth["lesion_present"]:
        if not isinstance(truth.get("lesion_labels"), list) or not truth["lesion_labels"]:
            raise QuizPackError("Positive packs need ground_truth.lesion_labels")
        if truth.get("pancreatic_region") not in {"head", "body", "tail"}:
            raise QuizPackError("Positive packs need a pancreatic region")
        if (
            not isinstance(truth.get("max_axial_diameter_mm"), (int, float))
            or not math.isfinite(float(truth["max_axial_diameter_mm"]))
            or truth["max_axial_diameter_mm"] <= 0
        ):
            raise QuizPackError("Positive packs need a positive axial diameter")
        centroid = truth.get("lesion_centroid_lps")
        if not isinstance(centroid, list) or len(centroid) != 3 or not all(
            isinstance(value, (int, float)) and math.isfinite(float(value)) for value in centroid
        ):
            raise QuizPackError("Positive packs need a finite lesion centroid")
        measurement = truth.get("reference_measurement_lps")
        if (
            not isinstance(measurement, list)
            or len(measurement) != 2
            or any(
                not isinstance(point, list)
                or len(point) != 3
                or not all(isinstance(value, (int, float)) and math.isfinite(float(value)) for value in point)
                for point in measurement
            )
        ):
            raise QuizPackError("Positive packs need finite reference measurement endpoints")
        if result.get("validator_version") in {
            "bodymaps-vqa-validator/1.1.0",
            "bodymaps-vqa-validator/2.0.0",
        }:
            measured = math.dist(measurement[0], measurement[1])
            if abs(measured - float(truth["max_axial_diameter_mm"])) > 0.11:
                raise QuizPackError("Reference measurement does not match axial diameter")
    else:
        if truth.get("pancreatic_region") is not None or truth.get("max_axial_diameter_mm") is not None:
            raise QuizPackError("Normal packs cannot contain lesion location or size")

    questions = result.get("questions")
    question_order = tuple(item.get("id") for item in questions) if isinstance(questions, list) else ()
    allowed_orders = {QUESTION_ORDER} if result["version"] == 1 else {QUESTION_ORDER, V2_QUESTION_ORDER}
    if question_order not in allowed_orders:
        raise QuizPackError(
            "v1 questions must contain organ, presence, location, conclusion in order; "
            "v2 may add report_finding before conclusion"
        )
    if result["version"] >= 2:
        report_truth = result.get("report_ground_truth")
        if not isinstance(report_truth, dict):
            raise QuizPackError("v2 packs need server-only report_ground_truth")
        _require_string(report_truth.get("parser_version"), "report_ground_truth.parser_version")
        _require_string(report_truth.get("validation_outcome"), "report_ground_truth.validation_outcome")
        report_hash = report_truth.get("report_sha256")
        if report_hash is not None and (
            not isinstance(report_hash, str)
            or len(report_hash) != 64
            or any(character not in "0123456789abcdef" for character in report_hash)
        ):
            raise QuizPackError("report_ground_truth.report_sha256 must be a SHA-256 hex digest")
        if question_order == V2_QUESTION_ORDER:
            _require_string(report_truth.get("selected_field"), "report_ground_truth.selected_field")
            _require_string(report_truth.get("evidence_sentence"), "report_ground_truth.evidence_sentence")
        elif report_truth.get("selected_field") is not None or report_truth.get("evidence_sentence") is not None:
            raise QuizPackError("v2 packs without report_finding cannot retain selected report evidence")
    seen_choice_ids: set[tuple[str, str]] = set()
    for question in questions:
        _require_string(question.get("prompt"), f"question {question.get('id')} prompt")
        choices = question.get("choices")
        if not isinstance(choices, list) or len(choices) < 2:
            raise QuizPackError(f"question {question['id']} needs at least two choices")
        choice_ids: set[str] = set()
        for choice in choices:
            choice_id = _require_string(choice.get("id"), "choice id")
            _require_string(choice.get("label"), "choice label")
            if choice_id in choice_ids:
                raise QuizPackError(f"question {question['id']} has duplicate choice ids")
            choice_ids.add(choice_id)
            seen_choice_ids.add((question["id"], choice_id))
        if question.get("correct_choice_id") not in choice_ids:
            raise QuizPackError(f"question {question['id']} has an invalid correct answer")
        correct = next(choice for choice in choices if choice["id"] == question["correct_choice_id"])
        claims = correct.get("claims") or {}
        claimed_presence = claims.get("annotated_lesion_present", claims.get("lesion_present"))
        claimed_region = claims.get("annotated_pancreatic_region", claims.get("pancreatic_region"))
        if result.get("validator_version") in {
            "bodymaps-vqa-validator/1.1.0",
            "bodymaps-vqa-validator/2.0.0",
        }:
            if isinstance(claimed_presence, bool) and claimed_presence != truth["lesion_present"]:
                raise QuizPackError(f"question {question['id']} correct answer contradicts lesion truth")
            if claimed_region is not None and claimed_region != truth.get("pancreatic_region"):
                raise QuizPackError(f"question {question['id']} correct answer contradicts region truth")
        _require_string(question.get("explanation"), f"question {question['id']} explanation")
    if len(seen_choice_ids) != sum(len(item["choices"]) for item in questions):
        raise QuizPackError("Question choice ids are invalid")
    return result


class QuizPackRegistry:
    """Catalog held as canonical JSON strings so callers cannot mutate registry state."""

    def __init__(self, catalog: dict[str, Any], *, allow_unreviewed: bool = False) -> None:
        if not isinstance(catalog, dict) or catalog.get("catalog_version") != CATALOG_VERSION:
            raise QuizPackError(f"catalog_version must be {CATALOG_VERSION}")
        packs = catalog.get("packs")
        if not isinstance(packs, list):
            raise QuizPackError("Catalog packs must be a list")
        encoded: dict[str, str] = {}
        case_ids: set[str] = set()
        dataset_ids: set[str] = set()
        for raw in packs:
            pack = validate_pack(raw)
            pack_id = pack["pack_id"]
            if pack_id in encoded:
                raise QuizPackError(f"Duplicate quiz pack id: {pack_id}")
            case_id = pack["case_id"]
            dataset_id = _require_string(pack["provenance"].get("dataset_id"), "provenance.dataset_id")
            if case_id in case_ids:
                raise QuizPackError(f"Duplicate quiz case id: {case_id}")
            if dataset_id in dataset_ids:
                raise QuizPackError(f"Duplicate quiz dataset id: {dataset_id}")
            case_ids.add(case_id)
            dataset_ids.add(dataset_id)
            encoded[pack_id] = json.dumps(pack, sort_keys=True, separators=(",", ":"))
        self._packs = encoded
        self.catalog_id = _require_string(catalog.get("catalog_id"), "catalog_id")
        self.catalog_version = CATALOG_VERSION
        self.allow_unreviewed = bool(allow_unreviewed)
        self.available_statuses = (
            {"approved", "pending"} if self.allow_unreviewed else APPROVED_STATUSES
        )

    @classmethod
    def from_path(
        cls,
        path: str | Path = DEFAULT_CATALOG_PATH,
        *,
        allow_unreviewed: bool = False,
    ) -> "QuizPackRegistry":
        try:
            with Path(path).open("r", encoding="utf-8") as stream:
                catalog = json.load(stream)
        except (OSError, json.JSONDecodeError) as exc:
            raise QuizPackError(f"Quiz catalog could not be loaded: {path}") from exc
        return cls(catalog, allow_unreviewed=allow_unreviewed)

    def get(self, pack_id: str, *, require_approved: bool = True) -> dict[str, Any]:
        try:
            pack = json.loads(self._packs[pack_id])
        except KeyError as exc:
            raise QuizPackError("Quiz pack is unavailable") from exc
        if require_approved and pack["approval"]["status"] not in self.available_statuses:
            raise QuizPackError("Quiz pack is not approved")
        return pack

    def packs(self, *, approved_only: bool = True) -> list[dict[str, Any]]:
        values = [json.loads(value) for value in self._packs.values()]
        if approved_only:
            values = [item for item in values if item["approval"]["status"] in self.available_statuses]
        return sorted(values, key=lambda item: (int(item["case_id"]), item["pack_id"]))

    def pack_for_case(self, case_id: str) -> dict[str, Any] | None:
        """The served pack for one case, or None. A catalog holds at most one pack per case."""
        wanted = str(case_id).strip()
        if wanted.isdigit():
            wanted = str(int(wanted))
        return next((pack for pack in self.packs() if pack["case_id"] == wanted), None)

    def public_playlists(self) -> list[dict[str, Any]]:
        packs = self.packs()
        output: list[dict[str, Any]] = []
        for definition in PLAYLIST_DEFINITIONS:
            eligible = _playlist_candidates(definition, packs)
            output.append({
                "playlist_id": definition["playlist_id"],
                "version": definition["version"],
                "title": definition["title"],
                "description": definition["description"],
                "pack_count": len(eligible),
            })
        return output

    def select(
        self,
        playlist_id: str,
        *,
        seed: str,
        exclude_pack_ids: Iterable[str] = (),
    ) -> dict[str, Any]:
        definition = next(
            (item for item in PLAYLIST_DEFINITIONS if item["playlist_id"] == playlist_id), None
        )
        if definition is None:
            raise QuizPackError("Quiz playlist is unavailable")
        excluded = {str(value) for value in exclude_pack_ids}
        candidates = [
            pack for pack in _playlist_candidates(definition, self.packs())
            if pack["pack_id"] not in excluded
        ]
        if not candidates:
            raise QuizPackError("Quiz playlist has no non-repeating pack available")
        positives = [item for item in candidates if item["ground_truth"]["lesion_present"]]
        normals = [item for item in candidates if not item["ground_truth"]["lesion_present"]]
        positive_weight = int(definition["positive_weight"])
        normal_weight = int(definition["normal_weight"])
        cycle = max(1, positive_weight + normal_weight)
        # Exclusion history is selection position. This makes each complete
        # ten-pack Mixed/Foundations cycle exactly 7 positive and 3 normal.
        bucket = len(excluded) % cycle
        prefer_positive = bucket < positive_weight
        pool = positives if prefer_positive else normals
        if not pool:
            pool = normals if prefer_positive else positives
        if not pool:
            raise QuizPackError("Quiz playlist has no eligible pack")
        return min(
            pool,
            key=lambda pack: hashlib.sha256(
                f"{playlist_id}:{seed}:{pack['pack_id']}".encode("utf-8")
            ).digest(),
        )


def _target_mix(definition: dict[str, Any]) -> dict[str, int]:
    return {
        "positive_weight": int(definition["positive_weight"]),
        "normal_weight": int(definition["normal_weight"]),
    }


def _playlist_candidates(definition: dict[str, Any], packs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    eligible = [pack for pack in packs if pack["difficulty"] in definition["difficulty"]]
    if definition["playlist_id"] == "localization-measurement-v1":
        eligible = [pack for pack in eligible if pack["ground_truth"]["lesion_present"]]
    return eligible


_DEFAULT_REGISTRY: QuizPackRegistry | None = None


def get_registry() -> QuizPackRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        catalog_path = os.environ.get("BODYMAPS_QUIZ_CATALOG_PATH", str(DEFAULT_CATALOG_PATH))
        allow_unreviewed = os.environ.get("BODYMAPS_QUIZ_ALLOW_UNREVIEWED", "").strip().lower() in {
            "1", "true", "yes", "on"
        }
        _DEFAULT_REGISTRY = QuizPackRegistry.from_path(
            catalog_path,
            allow_unreviewed=allow_unreviewed,
        )
    return _DEFAULT_REGISTRY


def get_pack(pack_id: str) -> dict[str, Any]:
    return get_registry().get(pack_id)


def public_pack(pack: dict[str, Any], *, choice_seed: str = "preview") -> dict[str, Any]:
    return {
        "pack_id": pack["pack_id"],
        "version": pack["version"],
        "case_id": pack["case_id"],
        "title": pack["title"],
        "difficulty": pack["difficulty"],
        "provenance": _clone(pack["provenance"]),
        "generator_version": pack["generator_version"],
        "validator_version": pack["validator_version"],
        "questions": [
            public_question(pack, index, choice_seed=choice_seed)
            for index in range(len(pack["questions"]))
        ],
    }


def public_question(pack: dict[str, Any], index: int, *, choice_seed: str = "preview") -> dict[str, Any]:
    question = pack["questions"][index]
    cue = _clone(question.get("viewer_cue") or {})
    choices = sorted(
        question["choices"],
        key=lambda choice: hashlib.sha256(
            f"{choice_seed}:{pack['pack_id']}:{pack['version']}:{question['id']}:{choice['id']}".encode("utf-8")
        ).digest(),
    )
    return {
        "id": question["id"],
        "prompt": question["prompt"],
        "choices": [
            {"id": choice["id"], "label": choice["label"]}
            for choice in choices
        ],
        "viewer_cue": cue,
    }


def _question(pack: dict[str, Any], question_id: str) -> dict[str, Any]:
    try:
        return next(item for item in pack["questions"] if item["id"] == question_id)
    except StopIteration as exc:
        raise QuizPackError("Question is unavailable") from exc


def choice_ids(pack: dict[str, Any], question_id: str) -> set[str]:
    return {choice["id"] for choice in _question(pack, question_id)["choices"]}


def correct_choice(pack: dict[str, Any], question_id: str) -> str:
    return str(_question(pack, question_id)["correct_choice_id"])


def reveal_for(
    pack: dict[str, Any],
    question_id: str,
    submissions: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    question = _question(pack, question_id)
    counts = Counter(item["choice_id"] for item in submissions.values())
    reveal = {
        "question_id": question_id,
        "correct_choice_id": question["correct_choice_id"],
        "explanation": question["explanation"],
        "distribution": {
            choice["id"]: counts.get(choice["id"], 0) for choice in question["choices"]
        },
    }
    if question.get("source_label"):
        reveal["source_label"] = question["source_label"]
    if question.get("reveal_viewer_cue"):
        reveal["viewer_cue"] = _clone(question["reveal_viewer_cue"])
    return reveal


def _selected_claims(pack: dict[str, Any], question_id: str, choice_id: str) -> dict[str, Any]:
    question = _question(pack, question_id)
    choice = next((item for item in question["choices"] if item["id"] == choice_id), None)
    return _clone(choice.get("claims") or {}) if choice else {}


def consistency_for(answers: dict[str, str], pack: dict[str, Any] | None = None) -> dict[str, Any]:
    pack = pack or get_pack(QUIZ_PACK_ID)
    expected = {item["id"] for item in pack["questions"]}
    if set(answers) != expected:
        return {"status": "incomplete", "reasons": ["One or more questions were unanswered."]}
    presence_claims: set[bool] = set()
    location_claims: set[str] = set()
    for question_id, choice_id in answers.items():
        claims = _selected_claims(pack, question_id, choice_id)
        lesion_present = claims.get("annotated_lesion_present", claims.get("lesion_present"))
        region = claims.get("annotated_pancreatic_region", claims.get("pancreatic_region"))
        if isinstance(lesion_present, bool):
            presence_claims.add(lesion_present)
        if region in {"head", "body", "tail"}:
            location_claims.add(region)
    reasons: list[str] = []
    if len(presence_claims) > 1:
        reasons.append("The presence answers and conclusion contradict one another.")
    if len(location_claims) > 1:
        reasons.append("The selected pancreatic locations do not agree.")
    return {"status": "inconsistent" if reasons else "consistent", "reasons": reasons}
