from pathlib import Path
import json
import re
import dotenv
import os

import nibabel as nib
import numpy as np
from skimage import measure
import trimesh
import argparse

from constants import Constants
from services.label_scheme import SCHEME as LABEL_SCHEME, VIEWER_LABELS, viewer_labelmap_path
from utils import *

dotenv.load_dotenv()

# The viewer's organ catalog. preprocess_case_by_index converts the dataset mask
# to it first, so mesh ids are catalog ids.
LABELS = VIEWER_LABELS


def safe_filename(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\\-]+", "_", s).lower()


def nifti_world_to_three(world_xyz: np.ndarray) -> np.ndarray:
    """
    NIfTI world coordinates are usually RAS-ish:
      x = right-left
      y = anterior-posterior
      z = superior-inferior

    Three.js is usually:
      x = horizontal
      y = up
      z = depth

    This maps NIfTI z-up into Three y-up.
    If your model appears mirrored, this is the first function to adjust.
    """
    x = world_xyz[:, 0]
    y = world_xyz[:, 2]
    z = -world_xyz[:, 1]
    return np.column_stack([x, y, z])


def compute_global_center(data: np.ndarray, affine: np.ndarray) -> np.ndarray:
    nz = np.where(data != 0)

    mins = np.array([axis.min() for axis in nz], dtype=float)
    maxs = np.array([axis.max() for axis in nz], dtype=float)

    corners = np.array(
        [
            [mins[0], mins[1], mins[2]],
            [mins[0], mins[1], maxs[2]],
            [mins[0], maxs[1], mins[2]],
            [mins[0], maxs[1], maxs[2]],
            [maxs[0], mins[1], mins[2]],
            [maxs[0], mins[1], maxs[2]],
            [maxs[0], maxs[1], mins[2]],
            [maxs[0], maxs[1], maxs[2]],
        ],
        dtype=float,
    )

    world = nib.affines.apply_affine(affine, corners)
    three = nifti_world_to_three(world)

    return (three.min(axis=0) + three.max(axis=0)) / 2.0
def compute_volume_bounds_three(shape, affine: np.ndarray, center: np.ndarray):
    nx, ny, nz = shape[:3]

    corners_ijk = np.array(
        [
            [0, 0, 0],
            [0, 0, nz - 1],
            [0, ny - 1, 0],
            [0, ny - 1, nz - 1],
            [nx - 1, 0, 0],
            [nx - 1, 0, nz - 1],
            [nx - 1, ny - 1, 0],
            [nx - 1, ny - 1, nz - 1],
        ],
        dtype=float,
    )

    world = nib.affines.apply_affine(affine, corners_ijk)
    three = nifti_world_to_three(world)

    three_centered = three - center

    return {
        "min": three_centered.min(axis=0).tolist(),
        "max": three_centered.max(axis=0).tolist(),
    }

def export_organ_mesh(
    data: np.ndarray,
    affine: np.ndarray,
    label_id: int,
    out_path: Path,
    global_center: np.ndarray,
):
    mask = data == label_id

    if not mask.any():
        return None

    # Padding prevents clipped surfaces when the mask touches the volume boundary.
    padded = np.pad(mask.astype(np.uint8), pad_width=1, mode="constant")

    verts_ijk, faces, normals, values = measure.marching_cubes(
        padded,
        level=0.5,
        step_size=1,
        allow_degenerate=False,
    )

    # Undo padding.
    verts_ijk -= 1.0

    # Convert voxel coordinates -> NIfTI world coordinates.
    verts_world = nib.affines.apply_affine(affine, verts_ijk)

    # Convert NIfTI world coordinates -> Three.js-friendly coordinates.
    verts_three = nifti_world_to_three(verts_world)

    # Center entire case together, not each organ separately.
    verts_three -= global_center

    mesh = trimesh.Trimesh(
        vertices=verts_three,
        faces=faces,
        process=False,
    )

    mesh.update_faces(mesh.unique_faces())
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(out_path)

    return {
        "vertices": int(len(mesh.vertices)),
        "faces": int(len(mesh.faces)),
    }

def get_panTS_id(index: int):
    cur_case_id = str(index)
    iter = max(0, 8 - len(str(index)))
    for _ in range(iter):
        cur_case_id = "0" + cur_case_id
    cur_case_id = "PanTS_" + cur_case_id
    return cur_case_id

def get_cancerverse_id(index):
    """CV_%08d parallel to get_panTS_id (CancerVerse is CT-only — no masks yet)."""
    digits = str(index).upper().replace("CV_", "").replace("CV", "")
    return "CV_" + digits.zfill(8)

def get_folder_id(index):
    """Dataset-aware id: CV ids -> get_cancerverse_id, else get_panTS_id."""
    return get_cancerverse_id(index) if str(index).strip().upper().startswith("CV") else get_panTS_id(index)

# display_id: PanTS_00000900
def preprocess_case(display_id: str, label_nifti_path: str, output_root: str, *, verbose: bool = True):
    label_nifti_path = Path(label_nifti_path)
    output_root = Path(output_root)

    case_dir = output_root
    case_dir.mkdir(parents=True, exist_ok=True)

    img = nib.load(str(label_nifti_path))
    raw = np.asanyarray(img.dataobj)

    rounded = np.rint(raw)
    data = rounded.astype(np.int32)


    # Make sure labels are integers.
    data = data.astype(np.int32)

    global_center = compute_global_center(data, img.affine)
    bounds = compute_volume_bounds_three(data.shape, img.affine, global_center)

    manifest = {
        "caseId": display_id,
        "center": global_center.tolist(),
        "organs": [],
        "bounds": bounds,
        "affine": img.affine.tolist(),
        "labelScheme": LABEL_SCHEME,
    }

    for label_id, meta in LABELS.items():
        key = safe_filename(meta["key"])
        out_name = f"{key}.glb"
        out_path = case_dir / out_name

        stats = export_organ_mesh(
            data=data,
            affine=img.affine,
            label_id=label_id,
            out_path=out_path,
            global_center=global_center,
        )

        if stats is None:
            continue

        manifest["organs"].append(
            {
                "id": label_id,
                "key": meta["key"],
                "name": meta["name"],
                "url": f"{os.getenv('API_ORIGIN', 'http://localhost:5001')}/api/cases/{display_id}/render_only/{out_name}",
                "vertices": stats["vertices"],
                "faces": stats["faces"],
            }
        )

        if verbose:
            print(f"Exported {meta['name']} -> {out_path}")

    manifest_path = case_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))

    if verbose:
        print(f"Wrote manifest -> {manifest_path}")

def preprocess_case_by_index(index: int, skip_existing: bool = False):
    pants_case = get_panTS_id(index)

    nifti_path = (
        f"{Constants.PANTS_PATH}/mask_only/"
        f"{pants_case}/{Constants.COMBINED_LABELS_NIFTI_FILENAME}"
    )

    output_path = os.path.join(Constants.MESH_PATH, pants_case)
    manifest_path = Path(output_path) / "manifest.json"

    if skip_existing and manifest_path.exists():
        print(f"[SKIP] {pants_case} already has manifest.json")
        return

    if not Path(nifti_path).exists():
        print(f"[MISSING] {pants_case}: {nifti_path}")
        return

    print(f"[START] {pants_case}")
    print(f"  input:  {nifti_path}")
    print(f"  output: {output_path}")

    preprocess_case(
        display_id=pants_case,
        # The dataset mask numbers organs differently from the viewer.
        label_nifti_path=viewer_labelmap_path(nifti_path),
        output_root=output_path,
    )

    print(f"[DONE] {pants_case}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Preprocess PanTS label NIfTI into GLB organ meshes.")

    parser.add_argument(
        "--case",
        type=int,
        help="Single PanTS case index, e.g. 900 for PanTS_00000900",
    )

    parser.add_argument(
        "--start",
        type=int,
        help="Start case index for batch preprocessing, inclusive.",
    )

    parser.add_argument(
        "--end",
        type=int,
        help="End case index for batch preprocessing, inclusive.",
    )

    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate even if manifest.json already exists.",
    )

    args = parser.parse_args()

    skip_existing = not args.force

    if args.case is not None:
        preprocess_case_by_index(args.case, skip_existing=skip_existing)

    elif args.start is not None and args.end is not None:
        for index in range(args.start, args.end + 1):
            try:
                preprocess_case_by_index(index, skip_existing=skip_existing)
            except Exception as e:
                print(f"[ERROR] PanTS_{index:08d}: {e}")

    else:
        raise SystemExit("Use either --case 900 or --start 1 --end 9901")
