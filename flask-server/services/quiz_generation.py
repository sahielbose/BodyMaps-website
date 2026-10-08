"""Offline deterministic VQA pack generation and release-gate validation."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import warnings
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import nibabel as nib
import numpy as np
import openpyxl
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import ConvexHull, cKDTree, distance

from services.live_quiz import CATALOG_VERSION, V2_QUESTION_ORDER, QuizPackError, validate_pack


GENERATOR_VERSION = "bodymaps-vqa-generator/2.0.0"
VALIDATOR_VERSION = "bodymaps-vqa-validator/2.0.0"
TEMPLATE_VERSION = "pancreas-imaging-chain/2.0.0"
REPORT_PARSER_VERSION = "radgpt-structured-report/1.0.0"
TARGETS = {50: (35, 15), 100: (70, 30), 500: (350, 150)}
DEFAULT_PROFILE_PATH = Path(__file__).with_name("quiz_label_profiles.v1.json")
DEFAULT_LEDGER_PATH = Path(__file__).with_name("quiz_approval_ledger.v1.json")


class QuizGenerationError(RuntimeError):
    """Candidate-specific deterministic generation failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Candidate:
    case_id: str
    dataset_id: str
    tumor_positive: bool
    spacing: tuple[float, float, float] | None
    metadata: dict[str, Any]


@dataclass
class GeneratedCandidate:
    pack: dict[str, Any]
    warnings: list[dict[str, str]]
    qa_image: str | None = None


@dataclass(frozen=True)
class ParsedStructuredReport:
    report_sha256: str
    normalized_text: str
    findings: str
    impression: str
    organ_sizes: dict[str, dict[str, str]]
    pancreatic_lesions: tuple[dict[str, Any], ...]
    pancreatic_mean_hu: float | None
    valid: bool
    validation_outcome: str


def normalize_structured_report(raw_report: str) -> str:
    """Canonicalize RadGPT workbook text without changing clinical meaning."""
    text = str(raw_report).replace("_x000D_", "\n").replace("\r\n", "\n").replace("\r", "\n")
    text = (
        text.replace("\u00a0", " ")
        .replace("\u00d7", "x")
        .replace("\u2212", "-")
        .replace("\u00b1", "+/-")
        .replace("cm\u00b3", "cm^3")
        .replace("mm\u00b3", "mm^3")
    )
    text = re.sub(r"\bcentimet(?:er|re)s?\b", "cm", text, flags=re.IGNORECASE)
    text = re.sub(r"\bmillimet(?:er|re)s?\b", "mm", text, flags=re.IGNORECASE)
    normalized_lines: list[str] = []
    for raw_line in text.split("\n"):
        line = re.sub(r"[ \t]+", " ", raw_line).strip()
        heading = re.match(r"^(FINDINGS?|IMPRESSION)\s*:?\s*(.*)$", line, flags=re.IGNORECASE)
        if heading:
            normalized_lines.append("FINDINGS:" if heading.group(1).lower().startswith("finding") else "IMPRESSION:")
            if heading.group(2):
                normalized_lines.append(heading.group(2).strip())
        elif line:
            normalized_lines.append(line)
        elif normalized_lines and normalized_lines[-1] != "":
            normalized_lines.append("")
    while normalized_lines and normalized_lines[-1] == "":
        normalized_lines.pop()
    return "\n".join(normalized_lines)


def _report_text_from_metadata(metadata: dict[str, Any]) -> str | None:
    preferred: list[tuple[int, str, Any]] = []
    for key, value in metadata.items():
        normalized = re.sub(r"[^a-z0-9]+", " ", str(key).lower()).strip()
        if "report" not in normalized.split():
            continue
        priority = (
            0 if normalized == "structured report"
            else 1 if "radgpt" in normalized.split() and "structured" in normalized.split()
            else 2 if "structured" in normalized.split()
            else 3 if normalized == "report"
            else 4
        )
        preferred.append((priority, str(key), value))
    for _, _, value in sorted(preferred, key=lambda item: (item[0], item[1].lower())):
        if value is not None and not (isinstance(value, float) and math.isnan(value)) and str(value).strip():
            return str(value)
    return None


def _organ_sections(findings: str) -> dict[str, str]:
    pattern = re.compile(r"(?im)^\s*(Spleen|Liver|Pancreas|Kidneys?)\s*:\s*$")
    matches = list(pattern.finditer(findings))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        name = match.group(1).lower()
        key = "kidneys" if name.startswith("kidney") else name
        end = matches[index + 1].start() if index + 1 < len(matches) else len(findings)
        sections[key] = findings[match.end():end].strip()
    return sections


def _explicit_size_state(section: str) -> tuple[str, str] | None:
    lowered = section.lower()
    states: set[str] = set()
    if "massively enlarged" in lowered:
        states.add("massively_enlarged")
    without_massive = lowered.replace("massively enlarged", "")
    if re.search(r"\benlarged\b", without_massive):
        states.add("enlarged")
    if re.search(r"\bnormal size\b|\bsize (?:is|are) normal\b", lowered):
        states.add("normal")
    if len(states) != 1:
        return None
    state = next(iter(states))
    evidence = next(
        (line for line in section.splitlines() if re.search(r"normal size|enlarged|size (?:is|are) normal", line, re.IGNORECASE)),
        section.splitlines()[0] if section.splitlines() else "",
    )
    return state, re.sub(r"\s+", " ", evidence).strip()


def _parse_dimensions_mm(block: str) -> tuple[float, ...]:
    match = re.search(
        r"\bSize\s*:\s*(?P<values>\d+(?:\.\d+)?(?:\s*(?:x|by)\s*\d+(?:\.\d+)?){0,2})\s*(?P<unit>mm|cm)\b",
        block,
        flags=re.IGNORECASE,
    )
    if not match:
        return ()
    values = tuple(float(value) for value in re.findall(r"\d+(?:\.\d+)?", match.group("values")))
    scale = 10.0 if match.group("unit").lower() == "cm" else 1.0
    return tuple(value * scale for value in values if math.isfinite(value) and value > 0)


def _evidence_sentence(*parts: str) -> str:
    cleaned = [re.sub(r"\s+", " ", part).strip(" .:") for part in parts if part and part.strip(" .:")]
    return ". ".join(cleaned) + "." if cleaned else ""


def _pancreatic_lesions(section: str) -> tuple[dict[str, Any], ...]:
    start_pattern = re.compile(
        r"(?im)^\s*Pancreas\s+(?:lesion|tumou?r|mass|cyst|PDAC|PNET)\s*\d*\b[^\n]*$"
    )
    starts = list(start_pattern.finditer(section))
    lesions: list[dict[str, Any]] = []
    for index, start in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(section)
        block = section[start.start():end].strip()
        location_line = re.search(r"(?im)^\s*Location\s*:\s*([^\n]+)", block)
        location_text = location_line.group(1).strip(" .") if location_line else ""
        regions = tuple(region for region in ("head", "body", "tail") if re.search(rf"\b{region}\b", location_text, re.IGNORECASE))
        dimensions_mm = _parse_dimensions_mm(block)
        attenuation_values = {
            value.lower()
            for value in re.findall(r"\b(hyperattenuating|isoattenuating|hypoattenuating)\b", block, re.IGNORECASE)
        }
        attenuation = next(iter(attenuation_values)) if len(attenuation_values) == 1 else None
        size_line = re.search(r"(?im)^\s*Size\s*:[^\n]+", block)
        attenuation_line = re.search(r"(?im)^\s*Enhancement relative to pancreas\s*:[^\n]+", block)
        lesions.append({
            "regions": regions,
            "dimensions_mm": dimensions_mm,
            "largest_dimension_mm": max(dimensions_mm) if dimensions_mm else None,
            "attenuation": attenuation,
            "conflicting_attenuation": len(attenuation_values) > 1,
            "evidence_sentence": _evidence_sentence(
                start.group(0),
                location_line.group(0) if location_line else "",
                size_line.group(0) if size_line else "",
                attenuation_line.group(0) if attenuation_line else "",
            ),
        })
    return tuple(lesions)


def parse_structured_report(raw_report: str) -> ParsedStructuredReport:
    report_sha256 = hashlib.sha256(str(raw_report).encode("utf-8")).hexdigest()
    normalized = normalize_structured_report(raw_report)
    findings_match = re.search(r"(?ms)^FINDINGS:\s*\n?(.*?)(?=^IMPRESSION:\s*$)", normalized)
    impression_match = re.search(r"(?ms)^IMPRESSION:\s*\n?(.*)$", normalized)
    if not findings_match or not impression_match or not findings_match.group(1).strip() or not impression_match.group(1).strip():
        return ParsedStructuredReport(
            report_sha256, normalized, "", "", {}, (), None, False, "missing_or_empty_section"
        )
    findings = findings_match.group(1).strip()
    impression = impression_match.group(1).strip()
    sections = _organ_sections(findings)
    if not sections:
        return ParsedStructuredReport(
            report_sha256, normalized, findings, impression, {}, (), None, False, "missing_organ_sections"
        )
    organ_sizes: dict[str, dict[str, str]] = {}
    for organ, section in sections.items():
        state = _explicit_size_state(section)
        if state:
            organ_sizes[organ] = {"state": state[0], "evidence_sentence": _evidence_sentence(f"{organ.title()}: {state[1]}")}
    pancreas_section = sections.get("pancreas", "")
    hu_values = [
        float(value)
        for value in re.findall(r"\bmean HU value\s*:\s*(-?\d+(?:\.\d+)?)", pancreas_section, re.IGNORECASE)
    ]
    pancreatic_mean_hu = hu_values[0] if len({round(value, 6) for value in hu_values}) == 1 else None
    return ParsedStructuredReport(
        report_sha256=report_sha256,
        normalized_text=normalized,
        findings=findings,
        impression=impression,
        organ_sizes=organ_sizes,
        pancreatic_lesions=_pancreatic_lesions(pancreas_section),
        pancreatic_mean_hu=pancreatic_mean_hu,
        valid=True,
        validation_outcome="parsed",
    )


def report_mask_diameter_matches(report_mm: float, mask_mm: float) -> bool:
    if not all(math.isfinite(float(value)) and float(value) > 0 for value in (report_mm, mask_mm)):
        return False
    return abs(float(report_mm) - float(mask_mm)) <= max(5.0, float(mask_mm) * 0.25) + 1e-9


def _warning(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _hu_range(value: float) -> tuple[str, str]:
    if value < 0:
        return "below_0", "<0 HU"
    if value < 40:
        return "0_39", "0–39 HU"
    if value < 80:
        return "40_79", "40–79 HU"
    return "80_plus", "≥80 HU"


def report_finding_for(
    raw_report: str | None,
    *,
    lesion_present: bool,
    region: str | None,
    diameter_mm: float | None,
    viewer_cue: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any], list[dict[str, str]]]:
    report_truth: dict[str, Any] = {
        "report_sha256": None,
        "selected_field": None,
        "evidence_sentence": None,
        "parser_version": REPORT_PARSER_VERSION,
        "validation_outcome": "report_missing",
    }
    if raw_report is None or not raw_report.strip():
        return None, report_truth, [_warning("report_missing", "Structured report is missing")]
    parsed = parse_structured_report(raw_report)
    report_truth["report_sha256"] = parsed.report_sha256
    if not parsed.valid:
        report_truth["validation_outcome"] = parsed.validation_outcome
        return None, report_truth, [_warning("report_ambiguous", "Structured report could not be parsed unambiguously")]

    warnings_out: list[dict[str, str]] = []
    if lesion_present and parsed.pancreatic_lesions:
        measured = [item for item in parsed.pancreatic_lesions if item["largest_dimension_mm"] is not None]
        if measured:
            largest_value = max(float(item["largest_dimension_mm"]) for item in measured)
            largest = [item for item in measured if abs(float(item["largest_dimension_mm"]) - largest_value) <= 1e-9]
            if len(largest) != 1:
                warnings_out.append(_warning("report_ambiguous", "Largest pancreatic report lesion is ambiguous"))
            else:
                lesion = largest[0]
                if lesion["conflicting_attenuation"]:
                    warnings_out.append(_warning("report_lesion_conflict", "Pancreatic lesion attenuation statements conflict"))
                elif region not in lesion["regions"] or diameter_mm is None or not report_mask_diameter_matches(largest_value, diameter_mm):
                    warnings_out.append(_warning("report_mask_mismatch", "Report lesion does not match mask region and diameter"))
                elif lesion["attenuation"]:
                    attenuation = str(lesion["attenuation"])
                    question = {
                        "id": "report_finding",
                        "prompt": f"How does the report describe the pancreatic-{region} lesion relative to the pancreas?",
                        "choices": [
                            {"id": "hyperattenuating", "label": "Hyperattenuating", "claims": {}},
                            {"id": "isoattenuating", "label": "Isoattenuating", "claims": {}},
                            {"id": "hypoattenuating", "label": "Hypoattenuating", "claims": {}},
                            {"id": "not_described", "label": "Not described", "claims": {}},
                        ],
                        "correct_choice_id": attenuation,
                        "explanation": f"The structured report describes the pancreatic-{region} lesion as {attenuation} relative to the pancreas.",
                        "source_label": "Structured report finding",
                        "viewer_cue": viewer_cue,
                    }
                    report_truth.update({
                        "selected_field": "lesion_attenuation",
                        "evidence_sentence": lesion["evidence_sentence"],
                        "validation_outcome": "matched_report_lesion_to_mask",
                    })
                    return question, report_truth, warnings_out

    for organ in ("pancreas", "spleen", "kidneys", "liver"):
        size = parsed.organ_sizes.get(organ)
        if not size:
            continue
        labels = {"pancreas": "pancreas", "spleen": "spleen", "kidneys": "kidneys", "liver": "liver"}
        state = size["state"]
        question = {
            "id": "report_finding",
            "prompt": f"How is {labels[organ]} described in structured report?",
            "choices": [
                {"id": "normal", "label": "Normal size", "claims": {}},
                {"id": "enlarged", "label": "Enlarged", "claims": {}},
                {"id": "massively_enlarged", "label": "Massively enlarged", "claims": {}},
                {"id": "not_described", "label": "Not described", "claims": {}},
            ],
            "correct_choice_id": state,
            "explanation": f"Structured report describes {labels[organ]} as {state.replace('_', ' ')}.",
            "source_label": "Structured report finding",
            "viewer_cue": viewer_cue,
        }
        report_truth.update({
            "selected_field": f"organ_size.{organ}",
            "evidence_sentence": size["evidence_sentence"],
            "validation_outcome": "selected_organ_size_fallback" if warnings_out else "selected_organ_size",
        })
        return question, report_truth, warnings_out

    if parsed.pancreatic_mean_hu is not None and math.isfinite(parsed.pancreatic_mean_hu):
        choice_id, choice_label = _hu_range(parsed.pancreatic_mean_hu)
        question = {
            "id": "report_finding",
            "prompt": "Which range contains pancreatic mean attenuation in structured report?",
            "choices": [
                {"id": "below_0", "label": "<0 HU", "claims": {}},
                {"id": "0_39", "label": "0–39 HU", "claims": {}},
                {"id": "40_79", "label": "40–79 HU", "claims": {}},
                {"id": "80_plus", "label": "≥80 HU", "claims": {}},
            ],
            "correct_choice_id": choice_id,
            "explanation": f"Structured report gives pancreatic mean attenuation as {parsed.pancreatic_mean_hu:g} HU, within {choice_label}.",
            "source_label": "Structured report finding",
            "viewer_cue": viewer_cue,
        }
        pancreas_lines = _organ_sections(parsed.findings).get("pancreas", "").splitlines()
        evidence = next((line for line in pancreas_lines if re.search(r"mean HU value", line, re.IGNORECASE)), "")
        report_truth.update({
            "selected_field": "pancreatic_mean_hu",
            "evidence_sentence": _evidence_sentence(f"Pancreas: {evidence}"),
            "validation_outcome": "selected_pancreatic_mean_hu_fallback",
        })
        warnings_out.append(_warning("report_hu_fallback", "Pancreatic mean HU range used as report fallback"))
        return question, report_truth, warnings_out

    report_truth["validation_outcome"] = "no_supported_report_question"
    if not any(item["code"] == "report_ambiguous" for item in warnings_out):
        warnings_out.append(_warning("report_ambiguous", "Structured report has no unambiguous supported finding"))
    return None, report_truth, warnings_out


def _json(path: str | Path) -> dict[str, Any]:
    try:
        with Path(path).open("r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, json.JSONDecodeError) as exc:
        raise QuizGenerationError("invalid_configuration", f"Could not load {path}") from exc
    if not isinstance(value, dict):
        raise QuizGenerationError("invalid_configuration", f"{path} must contain an object")
    return value


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


def _parse_tuple(value: Any) -> tuple[float, float, float] | None:
    if not isinstance(value, str):
        return None
    try:
        numbers = tuple(float(item.strip()) for item in value.strip("()[] ").split(","))
    except ValueError:
        return None
    return numbers if len(numbers) == 3 else None


def load_candidates(metadata_path: str | Path) -> list[Candidate]:
    workbook = openpyxl.load_workbook(metadata_path, read_only=True, data_only=True)
    worksheet = workbook.active
    rows = worksheet.iter_rows(values_only=True)
    try:
        headers = [str(value).strip() if value is not None else "" for value in next(rows)]
    except StopIteration as exc:
        raise QuizGenerationError("invalid_metadata", "Metadata workbook is empty") from exc
    index = {name: offset for offset, name in enumerate(headers)}
    required = {"PanTS ID", "tumor?"}
    if not required <= set(index):
        raise QuizGenerationError("invalid_metadata", "Metadata needs PanTS ID and tumor? columns")
    candidates: list[Candidate] = []
    for values in rows:
        dataset_id = str(values[index["PanTS ID"]] or "").strip()
        if not dataset_id.startswith("PanTS_"):
            continue
        suffix = dataset_id.removeprefix("PanTS_")
        if not suffix.isdigit():
            continue
        tumor = values[index["tumor?"]]
        if tumor not in {0, 1, False, True}:
            continue
        metadata = {
            name: values[offset] if offset < len(values) else None
            for name, offset in index.items()
        }
        candidates.append(Candidate(
            case_id=str(int(suffix)),
            dataset_id=dataset_id,
            tumor_positive=bool(tumor),
            spacing=_parse_tuple(metadata.get("spacing")),
            metadata=metadata,
        ))
    if not candidates:
        raise QuizGenerationError("invalid_metadata", "Metadata contains no valid candidates")
    return candidates


def discover_candidates(
    dataset_root: str | Path,
    profile_registry: "LabelProfileRegistry",
) -> list[Candidate]:
    """Build quiz candidates from locally staged CT and combined-label files.

    Public PanTS mirrors do not ship ``metadata.xlsx``.  Do not guess normal vs
    tumor from an id: inspect each validated lesion label in the combined mask.
    This path deliberately excludes partial cases so release generation cannot
    turn inventory rows into quiz packs without both viewer artifacts.
    """
    root = Path(dataset_root).resolve()
    mask_root = root / "mask_only"
    image_root = root / "image_only"
    if not mask_root.is_dir() or not image_root.is_dir():
        raise QuizGenerationError("missing_dataset_root", "Dataset needs image_only and mask_only directories")
    candidates: list[Candidate] = []
    for mask_path in sorted(mask_root.glob("PanTS_*/combined_labels.nii.gz")):
        dataset_id = mask_path.parent.name
        suffix = dataset_id.removeprefix("PanTS_")
        if not suffix.isdigit() or not (image_root / dataset_id / "ct.nii.gz").is_file():
            continue
        case_id = str(int(suffix))
        profile = profile_registry.resolve(case_id)
        try:
            image = nib.load(str(mask_path))
            labels = np.asanyarray(image.dataobj)
        except Exception as exc:
            raise QuizGenerationError("unreadable_artifact", f"Could not read {dataset_id}") from exc
        lesion_present = bool(np.any(_mask_for_labels(labels, profile["labels"]["lesion"])))
        spacing = tuple(float(value) for value in image.header.get_zooms()[:3])
        candidates.append(Candidate(
            case_id=case_id,
            dataset_id=dataset_id,
            tumor_positive=lesion_present,
            spacing=spacing,
            metadata={"candidate_source": "combined_labels"},
        ))
    if not candidates:
        raise QuizGenerationError("no_ready_candidates", "No CT/mask pairs matched a validated label profile")
    return candidates


class LabelProfileRegistry:
    def __init__(self, config: dict[str, Any]) -> None:
        if config.get("profile_version") != 1 or not isinstance(config.get("profiles"), list):
            raise QuizGenerationError("invalid_label_profiles", "Label profiles need profile_version 1")
        self.profiles = config["profiles"]
        ids = [item.get("profile_id") for item in self.profiles]
        if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
            raise QuizGenerationError("invalid_label_profiles", "Label profile ids must be unique strings")

    @classmethod
    def from_path(cls, path: str | Path = DEFAULT_PROFILE_PATH) -> "LabelProfileRegistry":
        return cls(_json(path))

    def resolve(self, case_id: str) -> dict[str, Any]:
        numeric = int(case_id)
        matches: list[dict[str, Any]] = []
        for profile in self.profiles:
            matcher = profile.get("match") or {}
            explicit = {str(int(value)) for value in matcher.get("case_ids") or []}
            ranges = matcher.get("case_ranges") or []
            if case_id in explicit or any(
                isinstance(item, list) and len(item) == 2 and int(item[0]) <= numeric <= int(item[1])
                for item in ranges
            ):
                matches.append(profile)
        if len(matches) != 1:
            reason = "unknown" if not matches else "ambiguous"
            raise QuizGenerationError("unknown_label_profile", f"Case {case_id} has {reason} label profile")
        labels = matches[0].get("labels") or {}
        if not isinstance(labels.get("pancreas"), list) or not labels["pancreas"]:
            raise QuizGenerationError("unknown_label_profile", "Label profile lacks pancreas labels")
        if not isinstance(labels.get("lesion"), list):
            raise QuizGenerationError("unknown_label_profile", "Label profile lacks lesion labels")
        return matches[0]


def _case_paths(dataset_root: Path, candidate: Candidate) -> tuple[Path, Path]:
    return (
        dataset_root / "image_only" / candidate.dataset_id / "ct.nii.gz",
        dataset_root / "mask_only" / candidate.dataset_id / "combined_labels.nii.gz",
    )


def _load_images(dataset_root: Path, candidate: Candidate) -> tuple[nib.spatialimages.SpatialImage, nib.spatialimages.SpatialImage]:
    ct_path, mask_path = _case_paths(dataset_root, candidate)
    if not ct_path.is_file():
        raise QuizGenerationError("missing_ct", f"Missing CT for {candidate.dataset_id}")
    if not mask_path.is_file():
        raise QuizGenerationError("missing_mask", f"Missing segmentation for {candidate.dataset_id}")
    try:
        ct = nib.load(str(ct_path))
        mask = nib.load(str(mask_path))
    except Exception as exc:
        raise QuizGenerationError("unreadable_artifact", f"Could not read {candidate.dataset_id}") from exc
    ct_affine = np.asarray(ct.affine, dtype=float)
    mask_affine = np.asarray(mask.affine, dtype=float)
    if (
        tuple(ct.shape[:3]) != tuple(mask.shape[:3])
        or not np.all(np.isfinite(ct_affine))
        or not np.all(np.isfinite(mask_affine))
        or abs(float(np.linalg.det(ct_affine[:3, :3]))) < 1e-8
        or abs(float(np.linalg.det(mask_affine[:3, :3]))) < 1e-8
        or not np.allclose(ct_affine, mask_affine, atol=1e-4)
    ):
        raise QuizGenerationError("mismatched_geometry", f"CT and mask geometry differ for {candidate.dataset_id}")
    return ct, mask


def _mask_for_labels(data: np.ndarray, labels: Iterable[int]) -> np.ndarray:
    values = [int(value) for value in labels]
    return np.isin(data, values) if values else np.zeros(data.shape, dtype=bool)


def _to_lps(points_ras: np.ndarray) -> np.ndarray:
    points = np.asarray(points_ras, dtype=float).copy()
    points[..., 0:2] *= -1
    return points


def _canonical_array(data: np.ndarray, affine: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    orientation = nib.orientations.io_orientation(affine)
    target = nib.orientations.axcodes2ornt(("R", "A", "S"))
    transform = nib.orientations.ornt_transform(orientation, target)
    canonical = nib.orientations.apply_orientation(data, transform)
    canonical_affine = affine @ nib.orientations.inv_ornt_aff(transform, data.shape)
    return canonical, canonical_affine


def _primary_component(binary: np.ndarray) -> tuple[np.ndarray, int]:
    if not np.any(binary):
        return np.zeros(binary.shape, dtype=bool), 0
    labeled, count = ndimage.label(binary, structure=np.ones((3, 3, 3), dtype=np.uint8))
    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0
    primary_label = int(np.argmax(sizes))
    return labeled == primary_label, int(count)


def maximum_axial_diameter(binary: np.ndarray, affine: np.ndarray) -> tuple[float, list[list[float]], int]:
    binary, affine = _canonical_array(np.asarray(binary, dtype=bool), np.asarray(affine, dtype=float))
    voxels = np.argwhere(binary)
    if voxels.size == 0:
        raise QuizGenerationError("empty_lesion", "Required lesion mask is empty")
    best_distance = 0.0
    best_points: np.ndarray | None = None
    best_slice = int(voxels[0, 2])
    for slice_index in np.unique(voxels[:, 2]):
        planar_ijk = np.argwhere(binary[:, :, int(slice_index)])
        if len(planar_ijk) < 2:
            continue
        points_ijk = np.column_stack((planar_ijk, np.full(len(planar_ijk), int(slice_index))))
        points_ras = nib.affines.apply_affine(affine, points_ijk)
        planar = points_ras[:, :2]
        try:
            hull_indices = ConvexHull(planar).vertices if len(planar) >= 3 else np.arange(len(planar))
        except Exception:
            hull_indices = np.arange(len(planar))
        hull = planar[hull_indices]
        if len(hull) < 2:
            continue
        distances = distance.pdist(hull)
        pair = int(np.argmax(distances))
        rows, columns = np.triu_indices(len(hull), 1)
        measured = float(distances[pair])
        if measured > best_distance:
            best_distance = measured
            best_points = points_ras[[int(hull_indices[rows[pair]]), int(hull_indices[columns[pair]])]]
            best_slice = int(slice_index)
    if best_points is None:
        raise QuizGenerationError("empty_lesion", "Lesion has no measurable axial diameter")
    return best_distance, _to_lps(best_points).tolist(), best_slice


def _centroid_lps(binary: np.ndarray, affine: np.ndarray) -> list[float]:
    voxels = np.argwhere(binary)
    if voxels.size == 0:
        raise QuizGenerationError("empty_structure", "Required structure is empty")
    return _to_lps(nib.affines.apply_affine(affine, voxels.mean(axis=0))).tolist()


def _foreground_voxel_lps(
    binary: np.ndarray,
    affine: np.ndarray,
    *,
    slice_index: int | None = None,
) -> list[float]:
    voxels = np.argwhere(binary)
    if slice_index is not None:
        on_slice = voxels[voxels[:, 2] == int(slice_index)]
        if len(on_slice):
            voxels = on_slice
    if not len(voxels):
        raise QuizGenerationError("empty_structure", "Required structure is empty")
    all_voxels = np.argwhere(binary)
    centroid_world = nib.affines.apply_affine(affine, all_voxels.mean(axis=0))
    world = nib.affines.apply_affine(affine, voxels)
    selected = voxels[int(np.argmin(np.sum((world - centroid_world) ** 2, axis=1)))]
    return _to_lps(nib.affines.apply_affine(affine, selected)).tolist()


def _pancreatic_region(
    data: np.ndarray,
    lesion: np.ndarray,
    profile: dict[str, Any],
    affine: np.ndarray,
) -> tuple[str, float]:
    lesion_voxels = np.argwhere(lesion)
    if not len(lesion_voxels):
        raise QuizGenerationError("empty_lesion", "Required lesion mask is empty")
    lesion_center = nib.affines.apply_affine(affine, lesion_voxels.mean(axis=0))
    labels = profile["labels"]
    candidates: list[tuple[float, str]] = []
    for name in ("head", "body", "tail"):
        region = _mask_for_labels(data, labels.get(name) or [])
        points = np.argwhere(region)
        if points.size:
            region_world = nib.affines.apply_affine(affine, points)
            measured, _ = cKDTree(region_world).query(lesion_center, k=1)
            candidates.append((float(measured), name))
    if not candidates:
        raise QuizGenerationError("empty_pancreas_regions", "Pancreatic subregion masks are unavailable")
    measured, region = min(candidates)
    return region, measured


def _round_size(value: float) -> int:
    canonical = Decimal(str(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return max(1, int(canonical.quantize(Decimal("1"), rounding=ROUND_HALF_UP)))


def _round_tenth(value: float) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def _questions(
    *,
    lesion_present: bool,
    region: str | None,
    diameter_mm: float | None,
    crosshair_lps: list[float],
    measurement_lps: list[list[float]] | None,
    output_label: int,
    mesh_organ_id: int | None,
    report_question: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    cue = {"clear_overlays": True, "crosshair_lps": crosshair_lps}
    location_choices = [
        {"id": "head", "label": "Pancreatic head", "claims": {"lesion_present": True, "pancreatic_region": "head"}},
        {"id": "body", "label": "Pancreatic body", "claims": {"lesion_present": True, "pancreatic_region": "body"}},
        {"id": "tail", "label": "Pancreatic tail", "claims": {"lesion_present": True, "pancreatic_region": "tail"}},
        {"id": "not_applicable", "label": "No annotated focal lesion to localize", "claims": {"lesion_present": False}},
    ]
    if lesion_present:
        assert region is not None and diameter_mm is not None and measurement_lps is not None
        size = _round_size(diameter_mm)
        other_regions = [value for value in ("head", "body", "tail") if value != region]
        conclusion_id = f"focal_{region}_{size}mm"
        conclusions = [
            {
                "id": conclusion_id,
                "label": f"Largest annotated pancreatic-{region} lesion, approximately {size} mm at its widest axial extent",
                "claims": {"lesion_present": True, "pancreatic_region": region},
            },
            {
                "id": f"focal_{other_regions[0]}_{size}mm",
                "label": f"Largest annotated pancreatic-{other_regions[0]} lesion, approximately {size} mm at its widest axial extent",
                "claims": {"lesion_present": True, "pancreatic_region": other_regions[0]},
            },
            {"id": "diffuse_change", "label": "Diffuse pancreatic abnormality without a focal lesion", "claims": {"lesion_present": False}},
            {"id": "no_abnormality", "label": "No focal pancreatic abnormality", "claims": {"lesion_present": False}},
        ]
        conclusion_explanation = (
            f"The largest annotated pancreatic-{region} lesion measures about {size} mm axially."
        )
        reveal_cue: dict[str, Any] = {
            "show_lesion_overlay": True,
            "crosshair_lps": crosshair_lps,
            "reference_measurement_lps": measurement_lps,
            "reference_diameter_mm": _round_tenth(float(diameter_mm)),
            "lesion_label": output_label,
        }
        if mesh_organ_id is not None:
            reveal_cue["mesh_organ_id"] = mesh_organ_id
    else:
        conclusion_id = "no_abnormality"
        conclusions = [
            {"id": "no_abnormality", "label": "No focal pancreatic lesion is annotated", "claims": {"lesion_present": False}},
            {"id": "diffuse_change", "label": "The annotation shows diffuse pancreatic change only", "claims": {"lesion_present": False, "diffuse_change_present": True}},
            {"id": "focal_head_unmeasured", "label": "Focal pancreatic-head abnormality", "claims": {"lesion_present": True, "pancreatic_region": "head"}},
            {"id": "focal_tail_unmeasured", "label": "Focal pancreatic-tail abnormality", "claims": {"lesion_present": True, "pancreatic_region": "tail"}},
        ]
        conclusion_explanation = "No focal pancreatic lesion is annotated in the validated segmentation."
        reveal_cue = {"show_lesion_overlay": False, "crosshair_lps": crosshair_lps}
    questions = [
        {
            "id": "organ",
            "prompt": "Which organ is under the synchronized crosshair?",
            "choices": [
                {"id": "pancreas", "label": "Pancreas", "claims": {}},
                {"id": "liver", "label": "Liver", "claims": {}},
                {"id": "spleen", "label": "Spleen", "claims": {}},
                {"id": "stomach", "label": "Stomach", "claims": {}},
            ],
            "correct_choice_id": "pancreas",
            "explanation": "The crosshair is positioned on the pancreas or its annotated lesion.",
            "viewer_cue": cue,
        },
        {
            "id": "presence",
            "prompt": "Is a focal pancreatic lesion annotated?",
            "choices": [
                {"id": "yes", "label": "Yes, a focal lesion is annotated", "claims": {"lesion_present": True}},
                {"id": "no", "label": "No focal lesion is annotated", "claims": {"lesion_present": False}},
                {"id": "diffuse", "label": "The annotation represents only diffuse change", "claims": {"lesion_present": False, "diffuse_change_present": True}},
                {"id": "outside", "label": "The annotation is centered outside the pancreas", "claims": {"lesion_present": True, "finding_outside_pancreas": True}},
            ],
            "correct_choice_id": "yes" if lesion_present else "no",
            "explanation": (
                "A discrete focal pancreatic lesion is present in the validated annotation."
                if lesion_present else "No focal pancreatic lesion is present in the validated annotation."
            ),
            "viewer_cue": cue,
        },
        {
            "id": "location",
            "prompt": "Where is the largest annotated focal lesion located within the pancreas?",
            "choices": location_choices,
            "correct_choice_id": region if lesion_present else "not_applicable",
            "explanation": (
                f"The largest annotated focal lesion is centered in the pancreatic {region}."
                if lesion_present else "Location is not applicable because no focal lesion is annotated."
            ),
            "viewer_cue": cue,
        },
    ]
    if report_question is not None:
        questions.append(report_question)
    questions.append(
        {
            "id": "conclusion",
            "prompt": "Which conclusion best summarizes the case?",
            "choices": conclusions,
            "correct_choice_id": conclusion_id,
            "explanation": conclusion_explanation,
            "viewer_cue": cue,
            "reveal_viewer_cue": reveal_cue,
        }
    )
    expected_order = V2_QUESTION_ORDER if report_question is not None else ("organ", "presence", "location", "conclusion")
    assert tuple(item["id"] for item in questions) == expected_order
    return questions


def _pack_id(candidate: Candidate) -> str:
    return "radworld-case-35-v2" if candidate.case_id == "35" else f"pants-case-{int(candidate.case_id):08d}-v2"


def _approval_for(pack_id: str, ledger: dict[str, Any], cohort: str) -> dict[str, Any]:
    approvals = ledger.get("approvals") or {}
    approval = approvals.get(pack_id) or {"status": "pending"}
    if cohort not in set(ledger.get("reviewed_cohorts") or []):
        approval = {"status": "pending", "supersedes_approval": approval.get("ledger_id")}
    quarantined = set(ledger.get("quarantined_cohorts") or [])
    if cohort in quarantined:
        approval = {**approval, "status": "quarantined", "cohort": cohort}
    return dict(approval)


def _make_qa_image(
    path: Path,
    ct: np.ndarray,
    structure: np.ndarray,
    lesion: np.ndarray,
    candidate: Candidate,
    region: str | None,
    diameter_mm: float | None,
    measurement_lps: list[list[float]] | None,
    affine: np.ndarray,
    crosshair_lps: list[float],
) -> None:
    canonical_affine = np.asarray(affine, dtype=float)
    crosshair_ras = np.asarray(crosshair_lps, dtype=float).copy()
    crosshair_ras[:2] *= -1
    crosshair_ijk = nib.affines.apply_affine(np.linalg.inv(canonical_affine), crosshair_ras)
    slice_index = int(np.clip(round(float(crosshair_ijk[2])), 0, ct.shape[2] - 1))
    ct_plane = ct[:, :, slice_index]
    plane = np.asarray(ct_plane, dtype=np.float32)
    finite = np.isfinite(plane)
    if not np.any(finite):
        plane = np.zeros_like(plane)
    else:
        plane = np.nan_to_num(plane, nan=-150.0, posinf=250.0, neginf=-150.0)
    normalized = np.clip((plane + 150.0) / 400.0, 0.0, 1.0)
    pixels = (normalized * 255).astype(np.uint8).T
    base = Image.fromarray(pixels, mode="L").convert("RGB").resize((768, 768))
    draw = ImageDraw.Draw(base)
    overlay = lesion[:, :, slice_index] if np.any(lesion) else structure[:, :, slice_index]
    outline = overlay & ~ndimage.binary_erosion(overlay)
    coordinates = np.argwhere(outline)
    scale_x = 768 / max(1, overlay.shape[0])
    scale_y = 768 / max(1, overlay.shape[1])
    color = (255, 75, 75) if np.any(lesion) else (50, 220, 200)
    for x, y in coordinates[::max(1, len(coordinates) // 5000)]:
        left, top = int(x * scale_x), int(y * scale_y)
        draw.rectangle((left, top, left + 2, top + 2), fill=color)
    cx = int(np.clip(crosshair_ijk[0] * scale_x, 0, 767))
    cy = int(np.clip(crosshair_ijk[1] * scale_y, 0, 767))
    draw.line((cx - 20, cy, cx + 20, cy), fill=(255, 220, 40), width=2)
    draw.line((cx, cy - 20, cx, cy + 20), fill=(255, 220, 40), width=2)
    for x, y in coordinates[::max(1, len(coordinates) // 5000)]:
        left, top = int(x * scale_x), int(y * scale_y)
        draw.rectangle((left, top, left + 2, top + 2), fill=color)
    if measurement_lps:
        endpoints_ras = np.asarray(measurement_lps, dtype=float).copy()
        endpoints_ras[:, :2] *= -1
        endpoints_ijk = nib.affines.apply_affine(np.linalg.inv(canonical_affine), endpoints_ras)
        if np.all(np.abs(endpoints_ijk[:, 2] - slice_index) <= 0.51):
            first = (int(endpoints_ijk[0, 0] * scale_x), int(endpoints_ijk[0, 1] * scale_y))
            second = (int(endpoints_ijk[1, 0] * scale_x), int(endpoints_ijk[1, 1] * scale_y))
            draw.line((*first, *second), fill=(80, 180, 255), width=4)
            for x, y in (first, second):
                draw.ellipse((x - 5, y - 5, x + 5, y + 5), outline=(80, 180, 255), width=3)
    panel = Image.new("RGB", (768, 120), (18, 22, 27))
    panel_draw = ImageDraw.Draw(panel)
    status = "lesion label present" if candidate.tumor_positive else "lesion label absent"
    panel_draw.text((18, 16), f"{candidate.dataset_id}  |  {status}  |  axial slice {slice_index}", fill="white")
    panel_draw.text((18, 48), f"location: {region or 'not applicable'}", fill=(210, 220, 230))
    panel_draw.text((18, 78), f"maximum axial diameter: {diameter_mm:.1f} mm" if diameter_mm else "maximum axial diameter: not applicable", fill=(210, 220, 230))
    output = Image.new("RGB", (768, 888), (18, 22, 27))
    output.paste(base, (0, 0))
    output.paste(panel, (0, 768))
    path.parent.mkdir(parents=True, exist_ok=True)
    output.save(path, format="PNG", optimize=True)


def generate_candidate(
    dataset_root: str | Path,
    candidate: Candidate,
    profile_registry: LabelProfileRegistry,
    ledger: dict[str, Any],
    *,
    qa_dir: str | Path | None = None,
) -> GeneratedCandidate:
    root = Path(dataset_root).resolve()
    ct_image, mask_image = _load_images(root, candidate)
    profile = profile_registry.resolve(candidate.case_id)
    mask, geometry_affine = _canonical_array(np.asanyarray(mask_image.dataobj), mask_image.affine)
    labels = profile["labels"]
    pancreas = _mask_for_labels(mask, labels["pancreas"])
    if not np.any(pancreas):
        raise QuizGenerationError("empty_pancreas", f"Pancreas mask is empty for {candidate.dataset_id}")
    lesion = _mask_for_labels(mask, labels["lesion"])
    if candidate.tumor_positive and not np.any(lesion):
        raise QuizGenerationError("empty_lesion", f"Tumor-positive case {candidate.dataset_id} has no lesion mask")
    if not candidate.tumor_positive and np.any(lesion):
        raise QuizGenerationError("unexpected_lesion", f"Normal case {candidate.dataset_id} contains lesion labels")
    warning_list: list[dict[str, str]] = []
    primary_lesion, component_count = _primary_component(lesion)
    if component_count > 1:
        warning_list.append({"code": "multiple_lesions", "message": f"{component_count} lesion components detected"})
    axial_spacing = float(np.linalg.norm(geometry_affine[:3, 2]))
    if axial_spacing >= 5:
        warning_list.append({"code": "thick_slices", "message": f"Axial spacing is {axial_spacing:.2f} mm"})
    region: str | None = None
    diameter: float | None = None
    measurement: list[list[float]] | None = None
    location_distance: float | None = None
    try:
        with warnings.catch_warnings(), np.errstate(all="ignore"):
            # NumPy/OpenBLAS can emit spurious floating-point warnings for
            # otherwise finite affine matmul. Validate computed outputs below.
            warnings.simplefilter("ignore", RuntimeWarning)
            if candidate.tumor_positive:
                diameter, measurement, slice_index = maximum_axial_diameter(primary_lesion, geometry_affine)
                region, location_distance = _pancreatic_region(mask, primary_lesion, profile, geometry_affine)
                lesion_centroid = _centroid_lps(primary_lesion, geometry_affine)
                crosshair = _foreground_voxel_lps(primary_lesion, geometry_affine, slice_index=slice_index)
            else:
                lesion_centroid = None
                crosshair = _foreground_voxel_lps(pancreas, geometry_affine)
    except (FloatingPointError, RuntimeWarning, np.linalg.LinAlgError, ValueError) as exc:
        raise QuizGenerationError("invalid_geometry", f"World-coordinate geometry is invalid for {candidate.dataset_id}") from exc
    computed_geometry = [*crosshair]
    if diameter is not None:
        computed_geometry.append(diameter)
    if location_distance is not None:
        computed_geometry.append(location_distance)
    if measurement is not None:
        computed_geometry.extend(value for point in measurement for value in point)
    if not all(math.isfinite(float(value)) for value in computed_geometry):
        raise QuizGenerationError("invalid_geometry", f"World-coordinate geometry is invalid for {candidate.dataset_id}")
    output_label = int(profile.get("reveal_output_label", 1))
    report_question, report_truth, report_warnings = report_finding_for(
        _report_text_from_metadata(candidate.metadata),
        lesion_present=candidate.tumor_positive,
        region=region,
        diameter_mm=diameter,
        viewer_cue={"clear_overlays": True, "crosshair_lps": crosshair},
    )
    warning_list.extend(report_warnings)
    pack_id = _pack_id(candidate)
    cohort = f"{TEMPLATE_VERSION}:{profile['profile_id']}"
    approval = _approval_for(pack_id, ledger, cohort)
    pack = {
        "pack_id": pack_id,
        "version": 2,
        "case_id": candidate.case_id,
        "title": f"Case {candidate.case_id} · Pancreas imaging quiz",
        "difficulty": "medium",
        "tags": [
            "pancreas",
            "lesion-label-present" if candidate.tumor_positive else "lesion-label-absent",
            "localization",
            "measurement",
        ],
        "provenance": {
            "dataset_id": candidate.dataset_id,
            "source": "PanTS combined CT and segmentation inventory",
            "template_version": TEMPLATE_VERSION,
            "label_profile_id": profile["profile_id"],
            "spacing_z_mm": _round_tenth(axial_spacing),
        },
        "generator_version": GENERATOR_VERSION,
        "validator_version": VALIDATOR_VERSION,
        "approval": approval,
        "report_ground_truth": report_truth,
        "ground_truth": {
            "label_profile_id": profile["profile_id"],
            "label_mapping": {
                key: [int(value) for value in values]
                for key, values in labels.items()
            },
            "lesion_present": candidate.tumor_positive,
            "lesion_labels": [int(value) for value in labels["lesion"]],
            "lesion_centroid_lps": lesion_centroid,
            "crosshair_lps": crosshair,
            "pancreatic_region": region,
            "location_distance_mm": _round_tenth(location_distance) if location_distance is not None else None,
            "max_axial_diameter_mm": _round_tenth(diameter) if diameter is not None else None,
            "reference_measurement_lps": measurement,
            "measured_component": "largest_26_connected" if candidate.tumor_positive else None,
            "reveal_mask": {
                "kind": "labels",
                "source_labels": [int(value) for value in labels["lesion"]] if candidate.tumor_positive else [],
                "output_label": output_label,
            },
        },
        "questions": _questions(
            lesion_present=candidate.tumor_positive,
            region=region,
            diameter_mm=diameter,
            crosshair_lps=crosshair,
            measurement_lps=measurement,
            output_label=output_label,
            mesh_organ_id=(int(profile["mesh_organ_id"]) if profile.get("mesh_organ_id") is not None else None),
            report_question=report_question,
        ),
    }
    qa_image: str | None = None
    if qa_dir is not None:
        qa_path = Path(qa_dir).resolve() / f"{pack_id}.png"
        ct, ct_affine = _canonical_array(np.asanyarray(ct_image.dataobj), ct_image.affine)
        if ct.shape != mask.shape or not np.allclose(ct_affine, geometry_affine, atol=1e-4):
            raise QuizGenerationError("mismatched_geometry", f"Canonical CT and mask geometry differ for {candidate.dataset_id}")
        _make_qa_image(
            qa_path,
            ct,
            pancreas,
            primary_lesion,
            candidate,
            region,
            diameter,
            measurement,
            geometry_affine,
            crosshair,
        )
        qa_image = str(qa_path)
    return GeneratedCandidate(validate_pack(pack), warning_list, qa_image)


def _difficulty(generated: list[GeneratedCandidate], ledger: dict[str, Any]) -> None:
    sizes = sorted(
        float(item.pack["ground_truth"]["max_axial_diameter_mm"])
        for item in generated if item.pack["ground_truth"]["lesion_present"]
    )
    overrides = ledger.get("difficulty_overrides") or {}
    for item in generated:
        pack = item.pack
        override = overrides.get(pack["pack_id"])
        if override in {"easy", "medium", "hard"}:
            pack["difficulty"] = override
            pack["approval"]["difficulty_override"] = override
            continue
        spacing = pack["provenance"].get("spacing_z_mm")
        if not pack["ground_truth"]["lesion_present"]:
            pack["difficulty"] = "easy" if not spacing or spacing <= 2.5 else "medium"
            continue
        size = float(pack["ground_truth"]["max_axial_diameter_mm"])
        rank = (sum(value < size for value in sizes) + 0.5 * sum(value == size for value in sizes)) / max(1, len(sizes))
        if spacing and spacing >= 5:
            rank = max(0.0, rank - 0.2)
        pack["difficulty"] = "hard" if rank <= 0.33 else "medium" if rank <= 0.67 else "easy"
        validate_pack(pack)


def _mark_outliers(generated: list[GeneratedCandidate]) -> None:
    fields = (
        ("max_axial_diameter_mm", "size_outlier", "Axial diameter"),
        ("location_distance_mm", "location_outlier", "Lesion-to-region distance"),
    )
    for field, code, label in fields:
        values = np.array([
            item.pack["ground_truth"].get(field)
            for item in generated if item.pack["ground_truth"].get(field) is not None
        ], dtype=float)
        if len(values) < 4:
            continue
        first, third = np.percentile(values, [25, 75])
        spread = third - first
        lower, upper = first - 1.5 * spread, third + 1.5 * spread
        for item in generated:
            value = item.pack["ground_truth"].get(field)
            if value is not None and not lower <= float(value) <= upper:
                item.warnings.append({"code": code, "message": f"{label} {value} mm is outside [{lower:.1f}, {upper:.1f}]"})


def _unacknowledged_warning_codes(item: GeneratedCandidate) -> list[str]:
    acknowledged = set(item.pack.get("approval", {}).get("acknowledged_warnings") or [])
    return sorted({warning["code"] for warning in item.warnings if warning["code"] not in acknowledged})


def _review_sample(
    generated: list[GeneratedCandidate],
    target: int,
    seed: str,
    ledger: dict[str, Any],
) -> list[str]:
    if target == 50:
        return [item.pack["pack_id"] for item in generated]
    sample_size = math.ceil(target * 0.2)
    required: dict[tuple[Any, ...], GeneratedCandidate] = {}
    for item in generated:
        pack = item.pack
        keys = [
            ("status", pack["ground_truth"]["lesion_present"]),
            ("difficulty", pack["difficulty"]),
            ("profile", pack["provenance"]["label_profile_id"]),
            ("template", pack["provenance"]["template_version"]),
        ]
        for key in keys:
            current = required.get(key)
            if current is None or hashlib.sha256(f"{seed}:{pack['pack_id']}:{key}".encode()).digest() < hashlib.sha256(f"{seed}:{current.pack['pack_id']}:{key}".encode()).digest():
                required[key] = item
    reviewed_templates = set(ledger.get("reviewed_template_versions") or [])
    reviewed_profiles = set(ledger.get("reviewed_label_profiles") or [])
    selected = {item.pack["pack_id"] for item in required.values()}
    selected.update(item.pack["pack_id"] for item in generated if item.warnings)
    selected.update(
        item.pack["pack_id"]
        for item in generated
        if item.pack["provenance"]["template_version"] not in reviewed_templates
        or item.pack["provenance"]["label_profile_id"] not in reviewed_profiles
    )
    ordered = sorted(
        generated,
        key=lambda item: hashlib.sha256(f"{seed}:sample:{item.pack['pack_id']}".encode()).digest(),
    )
    for item in ordered:
        if len(selected) >= sample_size:
            break
        selected.add(item.pack["pack_id"])
    return sorted(selected)


def _candidate_order(candidates: list[Candidate], seed: str, positive: bool) -> list[Candidate]:
    filtered = [item for item in candidates if item.tumor_positive is positive]
    return sorted(
        filtered,
        key=lambda item: (
            item.case_id != "35",
            hashlib.sha256(f"{seed}:{'positive' if positive else 'normal'}:{item.dataset_id}".encode()).digest(),
        ),
    )


def generate_release(
    *,
    dataset_root: str | Path,
    metadata_path: str | Path | None,
    target: int,
    output_catalog: str | Path,
    report_path: str | Path,
    qa_dir: str | Path | None,
    draft_catalog_path: str | Path | None = None,
    profile_path: str | Path = DEFAULT_PROFILE_PATH,
    ledger_path: str | Path = DEFAULT_LEDGER_PATH,
    seed: str = "bodymaps-vqa-v2",
    allow_unreviewed: bool = False,
    local_artifacts_only: bool = False,
) -> dict[str, Any]:
    if target not in TARGETS:
        raise QuizGenerationError("invalid_target", "Target must be 50, 100, or 500")
    target_positive, target_normal = TARGETS[target]
    profiles = LabelProfileRegistry.from_path(profile_path)
    candidates = load_candidates(metadata_path) if metadata_path is not None else discover_candidates(dataset_root, profiles)
    if local_artifacts_only:
        root = Path(dataset_root).resolve()
        candidates = [
            candidate for candidate in candidates
            if all(path.is_file() for path in _case_paths(root, candidate))
        ]
        if not candidates:
            raise QuizGenerationError("no_ready_candidates", "No metadata candidates have local CT/mask pairs")
    ledger = _json(ledger_path)
    generated: list[GeneratedCandidate] = []
    failures: list[dict[str, str]] = []
    attempted: set[str] = set()
    for positive, quota in ((True, target_positive), (False, target_normal)):
        accepted = 0
        for candidate in _candidate_order(candidates, seed, positive):
            if accepted >= quota:
                break
            attempted.add(candidate.dataset_id)
            try:
                item = generate_candidate(dataset_root, candidate, profiles, ledger, qa_dir=qa_dir)
            except QuizGenerationError as exc:
                failures.append({"dataset_id": candidate.dataset_id, "case_id": candidate.case_id, "code": exc.code, "message": str(exc)})
                continue
            generated.append(item)
            accepted += 1
    if allow_unreviewed:
        for item in generated:
            item.pack["approval"] = {"status": "pending"}
    _difficulty(generated, ledger)
    _mark_outliers(generated)
    status_approved = [
        item for item in generated if item.pack["approval"]["status"] == "approved"
    ]
    publishable = [item for item in status_approved if not _unacknowledged_warning_codes(item)]
    approved = [item.pack for item in publishable]
    published = [item.pack for item in generated] if allow_unreviewed else approved
    composition = {
        "positive": sum(bool(item.pack["ground_truth"]["lesion_present"]) for item in generated),
        "normal": sum(not item.pack["ground_truth"]["lesion_present"] for item in generated),
    }
    approved_composition = {
        "positive": sum(bool(item["ground_truth"]["lesion_present"]) for item in approved),
        "normal": sum(not item["ground_truth"]["lesion_present"] for item in approved),
    }
    published_composition = {
        "positive": sum(bool(item["ground_truth"]["lesion_present"]) for item in published),
        "normal": sum(not item["ground_truth"]["lesion_present"] for item in published),
    }
    exact_generated = composition == {"positive": target_positive, "normal": target_normal}
    exact_approved = approved_composition == {"positive": target_positive, "normal": target_normal}
    exact_published = published_composition == {"positive": target_positive, "normal": target_normal}
    question_family_counts = Counter(
        question["id"] for item in generated for question in item.pack["questions"]
    )
    selected_report_families: Counter[str] = Counter()
    for item in generated:
        selected = item.pack["report_ground_truth"].get("selected_field")
        family = "organ_size" if isinstance(selected, str) and selected.startswith("organ_size.") else selected or "none"
        selected_report_families[family] += 1
    warning_counts = Counter(
        warning["code"] for item in generated for warning in item.warnings
    )
    report = {
        "run": {
            "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "generator_version": GENERATOR_VERSION,
            "validator_version": VALIDATOR_VERSION,
            "target": target,
            "seed": seed,
            "dataset_root": str(Path(dataset_root).resolve()),
            "metadata_path": str(Path(metadata_path).resolve()) if metadata_path is not None else None,
            "candidate_source": (
                "local_metadata_artifacts"
                if metadata_path is not None and local_artifacts_only
                else "metadata" if metadata_path is not None
                else "combined_labels"
            ),
            "attempted_candidates": len(attempted),
            "release_mode": "development" if allow_unreviewed else "approved",
        },
        "acceptance": {
            "passed": exact_generated and (exact_published if allow_unreviewed else exact_approved),
            "generated_pack_count": len(generated),
            "published_pack_count": len(published),
            "approved_pack_count": len(approved),
            "status_approved_pack_count": len(status_approved),
            "review_required_pack_count": len(generated) - len(publishable),
            "composition": composition,
            "approved_composition": approved_composition,
            "published_composition": published_composition,
            "required_composition": {"positive": target_positive, "normal": target_normal},
            "structurally_valid": len(generated),
            "report_question_count": question_family_counts["report_finding"],
            "missing_report_pack_count": warning_counts["report_missing"],
        },
        "report_enrichment": {
            "question_family_counts": dict(sorted(question_family_counts.items())),
            "report_question_selection_counts": dict(sorted(selected_report_families.items())),
            "contradiction_counts": {
                "report_lesion_conflict": warning_counts["report_lesion_conflict"],
            },
            "fallback_counts": {
                "organ_size": selected_report_families["organ_size"],
                "pancreatic_mean_hu": selected_report_families["pancreatic_mean_hu"],
                "report_hu_fallback": warning_counts["report_hu_fallback"],
                "report_mask_mismatch": warning_counts["report_mask_mismatch"],
                "report_ambiguous": warning_counts["report_ambiguous"],
            },
        },
        "warnings": [
            {"pack_id": item.pack["pack_id"], **warning}
            for item in generated for warning in item.warnings
        ],
        "failures": failures,
        "review_sample_pack_ids": _review_sample(generated, target, seed, ledger),
        "packs": [
            {
                "pack_id": item.pack["pack_id"],
                "case_id": item.pack["case_id"],
                "approval_status": item.pack["approval"]["status"],
                "unacknowledged_warning_codes": _unacknowledged_warning_codes(item),
                "difficulty": item.pack["difficulty"],
                "qa_image": item.qa_image,
                "warnings": item.warnings,
            }
            for item in generated
        ],
    }
    catalog = {
        "catalog_id": f"bodymaps-vqa-{target}-v2",
        "catalog_version": CATALOG_VERSION,
        "generator_version": GENERATOR_VERSION,
        "validator_version": VALIDATOR_VERSION,
        "release_stage": "development" if allow_unreviewed else "approved",
        "review_only": bool(allow_unreviewed),
        "packs": published,
    }
    report["acceptance"]["catalog_content_sha256"] = hashlib.sha256(
        json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if draft_catalog_path is not None:
        draft_catalog = {
            "catalog_id": f"bodymaps-vqa-{target}-v2-draft",
            "catalog_version": CATALOG_VERSION,
            "generator_version": GENERATOR_VERSION,
            "validator_version": VALIDATOR_VERSION,
            "review_only": True,
            "packs": [item.pack for item in generated],
        }
        _atomic_json(Path(draft_catalog_path).resolve(), draft_catalog)
    _atomic_json(Path(report_path).resolve(), report)
    if report["acceptance"]["passed"]:
        _atomic_json(Path(output_catalog).resolve(), catalog)
    return report
