"""The one organ numbering the app uses, and the conversion of PanTS masks into it.

Two numberings exist side by side:

  * the viewer catalog (PanTS-Demo/src/helpers/constants.ts segmentation_categories,
    1-based): pancreatic_lesion is 22 and postcava..veins are 23-28. Meshes, organ
    metrics, lesion grounding, the report and every AI model's remapped output use it;
  * the PanTS dataset masks (PANTS_PATH/mask_only, the low-res copies under
    PANTS_LOWRES_PATH and the HuggingFace mirror): 1-21 match the catalog, then
    22 postcava, 23 prostate, 24 spleen, 25 stomach, 26 superior_mesenteric_artery,
    27 veins and 28 pancreatic_lesion.

Read raw, a dataset mask shows the spleen as "Prostate", the IVC as a pancreatic
lesion and the real lesion as "Veins". So the backend converts every dataset mask
to viewer ids exactly once, where it reads it, and nothing else ever converts.
Session, AI-model, uploaded and quiz-reveal masks are never converted: the first
three are already in viewer ids and the quiz reads the raw lesion label on purpose.
Converting a mask twice would rotate 22-28 again, so the decision is made by where
a mask comes from, never by its content.
"""

from __future__ import annotations

import os
import re
import tempfile
import threading

import nibabel as nib
import numpy as np

from services.atomic_write import atomic_destination

# Marks data written in the viewer numbering: mesh manifests carry it as
# "labelScheme", GLB and mask URLs carry it as a cache-busting query value.
SCHEME = "viewer-v1"

VIEWER_LABELS = {
    1: {"key": "adrenal_gland_left", "name": "Left Adrenal Gland"},
    2: {"key": "adrenal_gland_right", "name": "Right Adrenal Gland"},
    3: {"key": "aorta", "name": "Aorta"},
    4: {"key": "bladder", "name": "Bladder"},
    5: {"key": "celiac_artery", "name": "Celiac Artery"},
    6: {"key": "colon", "name": "Colon"},
    7: {"key": "common_bile_duct", "name": "Common Bile Duct"},
    8: {"key": "duodenum", "name": "Duodenum"},
    9: {"key": "femur_left", "name": "Left Femur"},
    10: {"key": "femur_right", "name": "Right Femur"},
    11: {"key": "gall_bladder", "name": "Gall Bladder"},
    12: {"key": "kidney_left", "name": "Left Kidney"},
    13: {"key": "kidney_right", "name": "Right Kidney"},
    14: {"key": "liver", "name": "Liver"},
    15: {"key": "lung_left", "name": "Left Lung"},
    16: {"key": "lung_right", "name": "Right Lung"},
    17: {"key": "pancreas", "name": "Pancreas"},
    18: {"key": "pancreas_body", "name": "Pancreas Body"},
    19: {"key": "pancreas_head", "name": "Pancreas Head"},
    20: {"key": "pancreas_tail", "name": "Pancreas Tail"},
    21: {"key": "pancreatic_duct", "name": "Pancreatic Duct"},
    22: {"key": "pancreatic_lesion", "name": "Pancreatic Lesion"},
    23: {"key": "postcava", "name": "Postcava"},
    24: {"key": "prostate", "name": "Prostate"},
    25: {"key": "spleen", "name": "Spleen"},
    26: {"key": "stomach", "name": "Stomach"},
    27: {"key": "superior_mesenteric_artery", "name": "Superior Mesenteric Artery"},
    28: {"key": "veins", "name": "Veins"},
    29: {"key": "intestine", "name": "Intestine"},
    30: {"key": "renal_vein_left", "name": "Left Renal Vein"},
    31: {"key": "renal_vein_right", "name": "Right Renal Vein"},
    32: {"key": "cbd_stent", "name": "Common Bile Duct Stent"},
    33: {"key": "liver_lesion", "name": "Liver Lesion"},
    34: {"key": "kidney_lesion", "name": "Kidney Lesion"},
    35: {"key": "colon_lesion", "name": "Colon Lesion"},
}
VIEWER_IDS = {meta["key"]: label_id for label_id, meta in VIEWER_LABELS.items()}

# Values in a PanTS dataset mask. Measured on the local cases: 24 matches the
# RadGPT spleen volume in every case, 22 is a right-paraspinal tube beside the
# aorta in every case, and 28 appears only in the tumour case, in the pancreas head.
PANTS_LABELS = {
    **{label_id: VIEWER_LABELS[label_id]["key"] for label_id in range(1, 22)},
    22: "postcava",
    23: "prostate",
    24: "spleen",
    25: "stomach",
    26: "superior_mesenteric_artery",
    27: "veins",
    28: "pancreatic_lesion",
}
PANTS_IDS = {key: label_id for label_id, key in PANTS_LABELS.items()}

# Dataset value -> viewer id. Values PanTS never uses (29 and up) become
# background rather than passing through as an unrelated viewer class.
PANTS_TO_VIEWER = np.zeros(256, dtype=np.uint8)
for _value, _key in PANTS_LABELS.items():
    PANTS_TO_VIEWER[_value] = VIEWER_IDS[_key]
del _value, _key


def to_viewer(raw) -> np.ndarray:
    """Convert a PanTS dataset label array to viewer ids, as uint8."""
    data = np.asanyarray(raw)
    if not np.issubdtype(data.dtype, np.integer):
        data = np.nan_to_num(np.rint(data), nan=0.0)
    return PANTS_TO_VIEWER[np.clip(data, 0, 255).astype(np.uint8)]


def _cache_dir() -> str:
    """A writable directory for converted copies.

    PANTS_LABELMAP_CACHE when set; else beside the low-res copies, where nginx
    can still serve the file directly; else the system temp directory. Never the
    dataset mount, which is read-only and ground truth.
    """
    candidates = []
    configured = os.environ.get("PANTS_LABELMAP_CACHE", "").strip()
    if configured:
        candidates.append(configured)
    lowres_root = os.environ.get("PANTS_LOWRES_PATH", "/home/visitor/pants_lowres")
    if os.path.isdir(lowres_root):
        candidates.append(os.path.join(lowres_root, f"labels-{SCHEME}"))
    candidates.append(os.path.join(tempfile.gettempdir(), f"bodymaps-labels-{SCHEME}"))
    for directory in candidates:
        try:
            os.makedirs(directory, exist_ok=True)
        except OSError:
            continue
        if os.access(directory, os.W_OK):
            return directory
    raise OSError("No writable directory for converted label maps")


_CONVERT_LOCKS: dict[str, threading.Lock] = {}
_CONVERT_LOCKS_GUARD = threading.Lock()


def _convert_lock(path: str) -> threading.Lock:
    with _CONVERT_LOCKS_GUARD:
        return _CONVERT_LOCKS.setdefault(path, threading.Lock())


def viewer_labelmap_path(raw_path) -> str:
    """Path of a uint8 copy of a PanTS dataset mask in viewer ids, written once.

    Only for masks read from the dataset (local, low-res or the mirror's cache).
    The copy's name carries the source's mtime and size, so a replaced source is
    converted again rather than served stale. Raises FileNotFoundError when the
    source is missing.
    """
    raw_path = os.fspath(raw_path)
    stat = os.stat(raw_path)
    case = re.sub(r"[^A-Za-z0-9_]+", "_", os.path.basename(os.path.dirname(os.path.abspath(raw_path)))) or "case"
    base = os.path.basename(raw_path)
    stem = re.sub(r"[^A-Za-z0-9_]+", "_", base[:-7] if base.endswith(".nii.gz") else os.path.splitext(base)[0])
    prefix = f"{case}_{stem}_"
    directory = _cache_dir()
    path = os.path.join(directory, f"{prefix}{stat.st_mtime_ns}_{stat.st_size}.nii.gz")
    if os.path.exists(path):
        return path

    with _convert_lock(path):
        if os.path.exists(path):
            return path
        image = nib.load(raw_path)
        data = to_viewer(np.asanyarray(image.dataobj))
        header = image.header.copy()
        header.set_data_dtype(np.uint8)
        converted = nib.Nifti1Image(data, image.affine, header=header)
        converted.set_data_dtype(np.uint8)
        # Values are label ids: never inherit a float scaling from the source header.
        converted.header.set_slope_inter(1, 0)
        with atomic_destination(path, suffix=".tmp.nii.gz") as temporary:
            nib.save(converted, temporary)

    # Earlier copies of the same source are stale now; removing them is best effort.
    # The exact pattern keeps PanTS_x_combined_labels_ from matching the low-res copy.
    stale = re.compile(re.escape(prefix) + r"\d+_\d+\.nii\.gz")
    try:
        for entry in os.scandir(directory):
            if stale.fullmatch(entry.name) and entry.path != path:
                try:
                    os.unlink(entry.path)
                except OSError:
                    pass
    except OSError:
        pass
    return path
