"""Deterministic lesion findings read straight from the segmentation labelmap.

Lesion questions ("where is the pancreatic lesion?", "does this case have a
tumor?") are the ones a language model must never answer from its own head, and
the ones it is most tempted to. Two failures were observed in testing:

  * with no grounding in the request, one model reported no lesion while another
    pointed at "the reddish-brown one" — a colour it had picked out of the mask
    legend, not a finding;
  * "where is the pancreatic lesion?" carries no phrase like "this case", so the
    whole case-grounding path was skipped and the answer was pure invention.

The labelmap already answers both questions exactly. `pancreatic_lesion` is
label 22, and the lesion classes below are either present with a measurable
volume or absent with zero voxels. This module turns that into sentences the
assistant is required to quote, INCLUDING the negative: an explicit "no lesion
is present" is what stops a model from inventing one.

Everything here is read-only and cached per case. Any failure degrades to
"unavailable", which the caller must report honestly rather than guessing.
"""

from __future__ import annotations

import os
import threading
from typing import Any

import numpy as np

try:  # nibabel and scipy are backend dependencies; never let an import kill chat
    import nibabel as nib
    from scipy import ndimage
    _DEPS_OK = True
except Exception:  # pragma: no cover - exercised only on a broken install
    _DEPS_OK = False


# Lesion classes in combined_labels.nii.gz, and the organ each belongs to.
LESION_LABELS: dict[int, dict[str, str]] = {
    22: {"key": "pancreatic_lesion", "display": "pancreatic lesion", "organ": "pancreas"},
    33: {"key": "liver_lesion", "display": "liver lesion", "organ": "liver"},
    34: {"key": "kidney_lesion", "display": "kidney lesion", "organ": "kidney"},
    35: {"key": "colon_lesion", "display": "colon lesion", "organ": "colon"},
}

# Pancreas is sub-segmented, so a pancreatic lesion can be placed in the head,
# body, or tail — the distinction that drives how these present clinically.
_PANCREAS_SUBREGIONS = {19: "head", 18: "body", 20: "tail"}

# Structures whose contact with a pancreatic lesion is worth stating. Vascular
# involvement is the question that decides resectability, and duct contact
# explains obstructive jaundice.
_CONTACT_LABELS = {
    21: "pancreatic duct",
    7: "common bile duct",
    8: "duodenum",
    27: "superior mesenteric artery",
    5: "celiac artery",
    28: "veins",
    3: "aorta",
}

# A handful of voxels is segmentation noise, not a finding. Below this the class
# is reported as absent rather than as a sub-millilitre "lesion".
_MIN_LESION_VOXELS = 20

_CACHE: dict[str, dict[str, Any]] = {}
_CACHE_LOCK = threading.Lock()


def _axial_axis(affine) -> int:
    """Index of the array axis that runs inferior→superior (the slice axis)."""
    try:
        codes = nib.aff2axcodes(affine)
        for index, code in enumerate(codes):
            if code in ("S", "I"):
                return index
    except Exception:
        pass
    return 2


def _describe_side(x_mm: float) -> str:
    """Rough laterality from a world X coordinate (RAS: +X is patient right)."""
    if x_mm > 15:
        return "toward the patient's right"
    if x_mm < -15:
        return "toward the patient's left"
    return "near the midline"


def _analyze(mask_path: str) -> dict[str, Any]:
    if not _DEPS_OK:
        return {"available": False, "reason": "imaging libraries unavailable"}

    try:
        image = nib.load(mask_path)
        data = np.rint(np.asanyarray(image.dataobj)).astype(np.int16)
    except Exception as error:
        return {"available": False, "reason": f"labelmap could not be read: {error}"}

    zooms = [abs(float(z)) for z in image.header.get_zooms()[:3]]
    voxel_mm3 = float(np.prod(zooms)) if all(zooms) else 0.0
    affine = image.affine
    axial = _axial_axis(affine)

    findings: list[dict[str, Any]] = []

    for label_id, meta in LESION_LABELS.items():
        mask = data == label_id
        voxels = int(np.count_nonzero(mask))

        if voxels < _MIN_LESION_VOXELS:
            findings.append({
                "key": meta["key"],
                "display": meta["display"],
                "organ": meta["organ"],
                "present": False,
            })
            continue

        entry: dict[str, Any] = {
            "key": meta["key"],
            "display": meta["display"],
            "organ": meta["organ"],
            "present": True,
            "volume_cm3": round(voxels * voxel_mm3 / 1000.0, 2),
        }

        try:
            components, count = ndimage.label(mask)
            entry["foci"] = int(count)
            if count > 1:
                sizes = ndimage.sum(mask, components, range(1, count + 1))
                largest = int(np.argmax(sizes)) + 1
                focus = components == largest
            else:
                focus = mask

            coords = np.array(np.nonzero(focus))
            mins = coords.min(axis=1)
            maxs = coords.max(axis=1)
            extent = [(int(maxs[a] - mins[a]) + 1) * zooms[a] for a in range(3)]
            entry["max_diameter_mm"] = round(float(max(extent)), 1)
            entry["slice_range"] = [int(mins[axial]), int(maxs[axial])]

            # A real lesion is a compact object. A "lesion" 25 cm across, or one
            # spanning most of the scan, is scattered false-positive voxels from
            # the segmentation model — reporting a centroid and a region for it
            # states a precise location for something that has none. Flag it so
            # the wording degrades to what can honestly be said.
            field = [data.shape[a] * zooms[a] for a in range(3)]
            fraction = max(
                (extent[a] / field[a]) if field[a] else 0.0 for a in range(3)
            )
            # Two shapes of implausibility: one enormous blob, or a spray of
            # tiny specks. The second is what a false-positive lesion class
            # actually looks like — hundreds of foci, none of them a lesion —
            # and measuring only the largest component would miss it entirely.
            speckled = bool(
                entry.get("foci", 1) > 20
                and int(np.count_nonzero(focus)) < 0.5 * voxels
            )
            entry["diffuse"] = bool(
                max(extent) > 150.0 or fraction > 0.6 or speckled
            )

            centroid = ndimage.center_of_mass(focus)
            entry["axial_slice"] = int(round(centroid[axial]))
            world = nib.affines.apply_affine(affine, np.array(centroid))
            entry["side"] = _describe_side(float(world[0]))

            # Which pancreas segment the lesion sits in, by nearest subregion
            # centroid. Reported only when the sub-segmentation actually exists.
            if meta["organ"] == "pancreas":
                best, best_distance = None, None
                for sub_id, sub_name in _PANCREAS_SUBREGIONS.items():
                    sub = data == sub_id
                    if not np.any(sub):
                        continue
                    sub_centroid = np.array(ndimage.center_of_mass(sub))
                    distance = float(np.linalg.norm(
                        (np.array(centroid) - sub_centroid) * np.array(zooms)
                    ))
                    if best_distance is None or distance < best_distance:
                        best, best_distance = sub_name, distance
                if best:
                    entry["region"] = best

            # Structures the lesion touches. Restricted to a padded bounding box
            # so this stays cheap on a full-resolution volume.
            pad = 2
            box = tuple(
                slice(max(0, int(mins[a]) - pad), min(data.shape[a], int(maxs[a]) + pad + 1))
                for a in range(3)
            )
            local = focus[box]
            grown = ndimage.binary_dilation(local, iterations=pad)
            shell = grown & ~local
            neighbours = data[box][shell]
            contacts = []
            for contact_id, contact_name in _CONTACT_LABELS.items():
                if int(np.count_nonzero(neighbours == contact_id)) >= 5:
                    contacts.append(contact_name)
            if contacts:
                entry["contacts"] = contacts
        except Exception as error:
            # Volume alone is still a real, useful finding.
            print("[lesion grounding] localization skipped:", type(error).__name__, error)

        findings.append(entry)

    return {"available": True, "lesions": findings}


def analyze_lesions(mask_path: str | None, cache_key: str | None = None) -> dict[str, Any]:
    """Cached lesion analysis for one case's labelmap."""
    if not mask_path or not os.path.exists(mask_path):
        return {"available": False, "reason": "no segmentation available"}

    # The key must follow the FILE, not just the case: an uploaded scan can be
    # re-segmented under the same session id, and serving the previous run's
    # lesion state would be worse than not caching at all.
    try:
        stamp = os.path.getmtime(mask_path)
    except OSError:
        stamp = 0.0
    key = f"{cache_key or ''}|{mask_path}|{stamp}"

    with _CACHE_LOCK:
        cached = _CACHE.get(key)
    if cached is not None:
        return cached

    result = _analyze(mask_path)

    with _CACHE_LOCK:
        _CACHE[key] = result
    return result


def lesion_facts(analysis: dict[str, Any], focus_organs: list[str] | None = None) -> list[str]:
    """Authoritative sentences about lesions, for the prompt's fact block.

    Absence is stated as plainly as presence — that negative sentence is the
    whole defence against a model inventing a finding.
    """
    if not analysis or not analysis.get("available"):
        return []

    wanted = {str(o).lower() for o in (focus_organs or [])}
    facts: list[str] = []

    for entry in analysis.get("lesions", []):
        if wanted and entry.get("organ") not in wanted:
            continue

        display = entry["display"]

        if not entry.get("present"):
            facts.append(
                f"SEGMENTATION FACT: no {display} is present in this case — the "
                f"{display} class contains no voxels."
            )
            continue

        if entry.get("diffuse"):
            facts.append(
                f"SEGMENTATION FACT: the {display} class in this case covers "
                f"**{entry['volume_cm3']:.2f} cm³** but is scattered across a "
                "large region of the scan rather than forming one discrete "
                "lesion, which is the signature of false-positive voxels from "
                "the segmentation model. There is no single lesion location to "
                "report for it."
            )
            continue

        parts = [f"SEGMENTATION FACT: a {display} IS present in this case"]

        if entry.get("region"):
            parts.append(f"in the pancreatic {entry['region']}")

        parts.append(f"measuring **{entry['volume_cm3']:.2f} cm³**")

        if entry.get("max_diameter_mm"):
            parts.append(f"with a largest dimension of about {entry['max_diameter_mm']:.0f} mm")

        sentence = ", ".join(parts) + "."

        extra: list[str] = []
        if entry.get("axial_slice") is not None:
            rng = entry.get("slice_range")
            span = f" (spanning axial slices {rng[0]}–{rng[1]})" if rng else ""
            extra.append(
                f"It is centred on axial slice {entry['axial_slice']}{span}, "
                f"{entry.get('side', 'near the midline')}"
            )
        if entry.get("foci", 1) > 1:
            extra.append(f"segmented as {entry['foci']} separate foci")
        if entry.get("contacts"):
            extra.append("abutting the " + ", ".join(entry["contacts"]))

        if extra:
            sentence += " " + "; ".join(extra) + "."

        facts.append(sentence)

    return facts


def has_lesion(analysis: dict[str, Any], organ: str) -> bool | None:
    """True/False for one organ, or None when the labelmap could not be read."""
    if not analysis or not analysis.get("available"):
        return None
    for entry in analysis.get("lesions", []):
        if entry.get("organ") == str(organ).lower():
            return bool(entry.get("present"))
    return None


def lesion_summary(analysis: dict[str, Any], focus_organs: list[str] | None = None) -> str:
    """Plain prose describing the measured lesion state, for direct display.

    `lesion_facts` is written for the prompt and carries a SEGMENTATION FACT
    prefix the user should never see. This is the same information as an answer,
    used when no model is available — a lesion question still gets a correct,
    grounded reply instead of an outage message.
    """
    if not analysis or not analysis.get("available"):
        return ""

    wanted = {str(o).lower() for o in (focus_organs or [])}
    present, absent = [], []

    for entry in analysis.get("lesions", []):
        if wanted and entry.get("organ") not in wanted:
            continue
        (present if entry.get("present") else absent).append(entry)

    if not present and not absent:
        return ""

    lines: list[str] = []

    for entry in present:
        if entry.get("diffuse"):
            lines.append(
                f"The **{entry['display']}** class covers "
                f"**{entry['volume_cm3']:.2f} cm³** in this case, but it is "
                "scattered across a large region rather than forming one "
                "discrete lesion. That pattern usually means false-positive "
                "voxels from the segmentation model, so I can't give you a "
                "single location for it."
            )
            continue

        bits = [f"This case contains a **{entry['display']}**"]
        if entry.get("region"):
            bits.append(f"in the pancreatic {entry['region']}")
        bits.append(f"measuring **{entry['volume_cm3']:.2f} cm³**")
        if entry.get("max_diameter_mm"):
            bits.append(f"about {entry['max_diameter_mm']:.0f} mm across")
        line = ", ".join(bits) + "."
        if entry.get("axial_slice") is not None:
            rng = entry.get("slice_range")
            span = f", spanning slices {rng[0]}–{rng[1]}" if rng else ""
            line += (
                f" It is centred on axial slice {entry['axial_slice']}{span}, "
                f"{entry.get('side', 'near the midline')}."
            )
        if entry.get("contacts"):
            line += " It abuts the " + ", ".join(entry["contacts"]) + "."
        lines.append(line)

    if absent:
        names = ", ".join(e["display"] for e in absent)
        if len(absent) == 1:
            lines.append(
                f"No {names} is present in this case: that class contains no "
                "voxels in the segmentation."
            )
        else:
            lines.append(
                f"None of the lesion classes ({names}) contain any voxels in "
                "the segmentation."
            )

    return " ".join(lines)


# ---------------------------------------------------------------------------
# Every segmented structure, not just lesions.
#
# Uploaded scans had no server-side metrics at all: calculate_session_metrics is
# a stub that always reports "unavailable", and the labelmap fallback refused any
# non-numeric id. So "what is the volume of the pancreas in this scan?" answered
# "not available" for an upload, while lesion grounding read the same file fine.
# One pass over the labelmap answers volume, structure count, and slice level.
# ---------------------------------------------------------------------------

_STRUCTURE_CACHE: dict[str, dict[str, Any]] = {}


def analyze_structures(mask_path: str | None, cache_key: str | None = None) -> dict[str, Any]:
    """Per-label volume and slice extent for every structure in a labelmap.

    Returns {"available": bool, "structures": {label_id: {...}}, "axial_axis": int}.
    Label ids are the viewer scheme (liver 14, pancreas 17, ...), so callers can
    map them with whatever name table they already use.
    """
    if not _DEPS_OK:
        return {"available": False, "reason": "imaging libraries unavailable"}
    if not mask_path or not os.path.exists(mask_path):
        return {"available": False, "reason": "no segmentation available"}

    try:
        stamp = os.path.getmtime(mask_path)
    except OSError:
        stamp = 0.0
    key = f"{cache_key or ''}|{mask_path}|{stamp}"

    with _CACHE_LOCK:
        cached = _STRUCTURE_CACHE.get(key)
    if cached is not None:
        return cached

    try:
        image = nib.load(mask_path)
        data = np.rint(np.asanyarray(image.dataobj)).astype(np.int16)
    except Exception as error:
        return {"available": False, "reason": f"labelmap could not be read: {error}"}

    zooms = [abs(float(z)) for z in image.header.get_zooms()[:3]]
    voxel_mm3 = float(np.prod(zooms)) if all(zooms) else 0.0
    axial = _axial_axis(image.affine)

    structures: dict[int, dict[str, Any]] = {}

    # One bincount beats one pass per label on a full-resolution volume.
    flat = data.reshape(-1)
    counts = np.bincount(flat[flat > 0])

    for label_id in np.nonzero(counts)[0]:
        label_id = int(label_id)
        voxels = int(counts[label_id])
        if voxels < 10:
            continue
        entry: dict[str, Any] = {
            "voxels": voxels,
            "volume_cm3": round(voxels * voxel_mm3 / 1000.0, 2),
        }
        try:
            positions = np.nonzero(np.any(data == label_id, axis=tuple(
                a for a in range(3) if a != axial
            )))[0]
            if positions.size:
                entry["slice_range"] = [int(positions.min()), int(positions.max())]
                entry["centre_slice"] = int(round(float(positions.mean())))
        except Exception:
            pass
        structures[label_id] = entry

    result = {"available": True, "structures": structures, "axial_axis": axial}

    with _CACHE_LOCK:
        _STRUCTURE_CACHE[key] = result
    return result
