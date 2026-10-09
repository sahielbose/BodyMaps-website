"""Authoritative Case 35 constants and ground-truth calculations.

The solo education challenge and Live Quiz both import this module so the
verified lesion label, location, and axial reference measurement cannot drift.
"""

from __future__ import annotations

import gzip
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
from scipy.spatial import ConvexHull, distance

from services.label_scheme import PANTS_IDS, VIEWER_IDS


CASE_ID = "35"
DATASET_CASE_ID = "PanTS_00000035"
# Ground truth reads the raw dataset mask, where the lesion is 28.
LESION_LABEL = PANTS_IDS["pancreatic_lesion"]
REVEAL_LABEL = 1
# The mesh manifest is in the viewer's organ catalog, where the lesion is 22:
# the dataset mask is converted before baking, and a manifest baked before that
# is relabelled when it is read. This is intentionally distinct from the source
# segmentation label above.
LESION_MESH_ORGAN_ID = VIEWER_IDS["pancreatic_lesion"]
VERIFIED_LOCATION = "pancreatic tail"
VERIFIED_REFERENCE_DIAMETER_MM = 23.3


def mask_path(pants_path: str | Path) -> Path:
    path = Path(pants_path).resolve() / "mask_only" / DATASET_CASE_ID / "combined_labels.nii.gz"
    if not path.is_file():
        raise FileNotFoundError("Case 35 ground-truth segmentation is unavailable")
    return path


def maximum_axial_diameter(mask: np.ndarray, affine: np.ndarray) -> tuple[float, list[list[float]]]:
    lesion_voxels = np.argwhere(mask == LESION_LABEL)
    if lesion_voxels.size == 0:
        raise ValueError("Case 35 lesion ground truth is unavailable")
    best_distance = 0.0
    best_points: list[list[float]] = []
    for slice_index in np.unique(lesion_voxels[:, 2]):
        points_ijk = np.argwhere(mask[:, :, int(slice_index)] == LESION_LABEL)
        if len(points_ijk) < 2:
            continue
        points_ijk = np.column_stack([points_ijk, np.full(len(points_ijk), int(slice_index))])
        points_ras = nib.affines.apply_affine(affine, points_ijk)
        planar = points_ras[:, :2]
        try:
            hull_indices = ConvexHull(planar).vertices if len(planar) >= 3 else np.arange(len(planar))
        except Exception:
            hull_indices = np.arange(len(planar))
        hull = planar[hull_indices]
        if len(hull) < 2:
            continue
        condensed = distance.pdist(hull)
        pair_index = int(np.argmax(condensed))
        row, column = np.triu_indices(len(hull), 1)
        first = int(hull_indices[row[pair_index]])
        second = int(hull_indices[column[pair_index]])
        diameter = float(condensed[pair_index])
        if diameter <= best_distance:
            continue
        best_distance = diameter
        endpoints_ras = points_ras[[first, second]]
        best_points = [[-float(point[0]), -float(point[1]), float(point[2])] for point in endpoints_ras]
    if not best_points:
        raise ValueError("Case 35 reference measurement is unavailable")
    return best_distance, best_points


def anatomic_location(mask: np.ndarray, affine: np.ndarray) -> str:
    lesion = np.argwhere(mask == LESION_LABEL)
    if lesion.size == 0:
        raise ValueError("Case 35 lesion ground truth is unavailable")
    lesion_center = nib.affines.apply_affine(affine, lesion.mean(axis=0))
    # These are the verified Case 35 label positions used by the existing solo
    # challenge. The explicit fallback preserves the reviewed tail ground truth
    # if a derivative labelmap omits one of the regional pancreas masks.
    regions = {18: "pancreatic body", 19: "pancreatic head", 20: "pancreatic tail"}
    candidates: list[tuple[float, str]] = []
    for label, name in regions.items():
        points = np.argwhere(mask == label)
        if points.size:
            center = nib.affines.apply_affine(affine, points.mean(axis=0))
            candidates.append((float(np.linalg.norm(center - lesion_center)), name))
    return min(candidates)[1] if candidates else VERIFIED_LOCATION


def load_ground_truth(pants_path: str | Path) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    image = nib.load(str(mask_path(pants_path)))
    mask = np.asanyarray(image.dataobj)
    reference_mm, endpoints = maximum_axial_diameter(mask, image.affine)
    location = anatomic_location(mask, image.affine)
    center = [
        (endpoints[0][axis] + endpoints[1][axis]) / 2
        for axis in range(3)
    ]
    return mask, image.affine, {
        "correct_finding": "focal_pancreatic_lesion",
        "correct_finding_label": "Abnormal area in the pancreas",
        "lesion_label": LESION_LABEL,
        "segmentation_label": REVEAL_LABEL,
        "mesh_organ_id": LESION_MESH_ORGAN_ID,
        "location": location,
        "reference_diameter_mm": round(reference_mm, 1),
        "verified_reference_diameter_mm": VERIFIED_REFERENCE_DIAMETER_MM,
        "reference_measurement_lps": endpoints,
        "center_lps": center,
    }


def reveal_segmentation(pants_path: str | Path) -> bytes:
    image = nib.load(str(mask_path(pants_path)))
    source = np.asanyarray(image.dataobj)
    if not np.any(source == LESION_LABEL):
        raise ValueError("Case 35 lesion ground truth is unavailable")
    revealed = np.where(source == LESION_LABEL, REVEAL_LABEL, 0).astype(np.uint8)
    output = nib.Nifti1Image(revealed, image.affine, header=image.header.copy())
    output.set_data_dtype(np.uint8)
    return gzip.compress(output.to_bytes(), compresslevel=1)
