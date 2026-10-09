from pathlib import Path
import json
import re
import dotenv
import os
import shutil
import threading
import uuid

import nibabel as nib
import numpy as np
from skimage import measure
import trimesh

from constants import Constants
from services.atomic_write import atomic_destination
from services.label_scheme import PANTS_TO_VIEWER, SCHEME as LABEL_SCHEME, VIEWER_LABELS
from utils import *

dotenv.load_dotenv()

# The viewer's organ catalog. A dataset mask is converted to it before baking
# (services.label_scheme), so a mesh id is always the catalog id.
LABELS = VIEWER_LABELS

_mesh_generation_lock = threading.Lock()


def safe_filename(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\\-]+", "_", s).lower()


def organ_glb_filename(organ: dict) -> str:
    """The GLB an organ entry draws: its own "file" when relabelled, else <key>.glb."""
    return str(organ.get("file") or f"{safe_filename(str(organ.get('key', '')))}.glb")


def relabel_legacy_manifest(manifest: dict) -> dict:
    """Give a manifest baked from a raw PanTS mask the viewer's ids and names.

    Manifests written before the label conversion (no "labelScheme") were meshed
    straight from the dataset mask, so each entry's id is the raw mask value
    while its key and name came from the viewer catalog at that id: the spleen
    sits in "prostate.glb" as id 24 and the lesion in "veins.glb" as id 28. The
    geometry is right, only the labels are wrong, so this maps every id through
    the dataset-to-viewer table and keeps each entry pointing at the GLB that
    holds its geometry. Nothing is rebaked, so no mask is needed.
    """
    organs = []
    for organ in manifest.get("organs") or []:
        if not isinstance(organ, dict):
            continue
        try:
            raw_id = int(organ.get("id"))
        except (TypeError, ValueError):
            continue
        viewer_id = int(PANTS_TO_VIEWER[raw_id]) if 0 <= raw_id < len(PANTS_TO_VIEWER) else 0
        if viewer_id == 0:
            continue
        meta = VIEWER_LABELS[viewer_id]
        organs.append({
            **organ,
            "id": viewer_id,
            "key": meta["key"],
            "name": meta["name"],
            "file": organ_glb_filename(organ),
        })
    organs.sort(key=lambda organ: organ["id"])
    return {**manifest, "organs": organs, "labelScheme": LABEL_SCHEME}


def _manifest_is_complete(manifest_path: Path) -> bool:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        organs = manifest["organs"]
        bounds = manifest["bounds"]
        if not isinstance(organs, list) or not isinstance(bounds, dict):
            return False
        # A manifest without the marker carries raw dataset ids and is stale.
        if manifest.get("labelScheme") != LABEL_SCHEME:
            return False
        return all(
            isinstance(organ, dict)
            and (manifest_path.parent / organ_glb_filename(organ)).is_file()
            for organ in organs
        )
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def ensure_case_meshes(case_id: str, label_nifti_path: str, output_root: str) -> Path:
    """Create one complete, reusable mesh cache when precomputed assets are absent."""
    label_path = Path(label_nifti_path)
    if not label_path.is_file():
        raise FileNotFoundError(label_path)

    root = Path(output_root)
    case_dir = root / case_id
    manifest_path = case_dir / "manifest.json"
    if _manifest_is_complete(manifest_path):
        return manifest_path

    # React Strict Mode can request the manifest twice. One process-wide lock keeps
    # both requests from running marching cubes over the same case concurrently.
    with _mesh_generation_lock:
        if _manifest_is_complete(manifest_path):
            return manifest_path

        from services.preprocess_meshes import preprocess_case

        root.mkdir(parents=True, exist_ok=True)
        temporary_dir = root / f".{case_id}.{uuid.uuid4().hex}.tmp"
        try:
            preprocess_case(case_id, str(label_path), str(temporary_dir), verbose=False)
            case_dir.mkdir(parents=True, exist_ok=True)
            # Manifest is generated last, then moved last. Readers never observe a
            # manifest that points at only a partial set of GLB files.
            generated_manifest = temporary_dir / "manifest.json"
            for asset in temporary_dir.iterdir():
                if asset != generated_manifest:
                    os.replace(asset, case_dir / asset.name)
            os.replace(generated_manifest, manifest_path)
        finally:
            shutil.rmtree(temporary_dir, ignore_errors=True)

        if not _manifest_is_complete(manifest_path):
            raise RuntimeError("Mesh preprocessing produced an incomplete cache")
        return manifest_path


def nifti_world_to_three(world_xyz: np.ndarray) -> np.ndarray:
    x = world_xyz[:, 0]
    y = world_xyz[:, 2]
    z = -world_xyz[:, 1]
    return np.column_stack([x, y, z])


def compute_global_center(data: np.ndarray, affine: np.ndarray) -> np.ndarray:
    """Center of the nonzero-label bounding box, in Three.js coordinates.

    This MUST match the convention of the pre-bake scripts
    (services/preprocess_meshes.py, scripts/precompute_meshes_local.py):
    every generator centers on the same point so pre-baked and on-demand
    meshes for one case can mix in the same cache without misalignment.
    Falls back to the full-volume center when the labelmap is empty.
    """
    nz = np.where(data != 0)

    if len(nz[0]) == 0:
        nx, ny, nzdim = data.shape[:3]
        mins = np.zeros(3, dtype=float)
        maxs = np.array([nx - 1, ny - 1, nzdim - 1], dtype=float)
    else:
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


def compute_volume_bounds_three(shape, affine: np.ndarray) -> dict:
    """Full-volume extents in Three.js coordinates, centered on the volume.

    Ported verbatim from services/preprocess_meshes.py so on-demand manifests
    carry the same "bounds" field the pre-baked ones do (the 3D crosshair in
    the viewer only renders when bounds are present).
    """
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

    center = (three.min(axis=0) + three.max(axis=0)) / 2.0
    three_centered = three - center

    return {
        "min": three_centered.min(axis=0).tolist(),
        "max": three_centered.max(axis=0).tolist(),
    }

def load_clean_label_data(label_nifti_path: str):
    img = nib.load(str(label_nifti_path))
    raw = np.asanyarray(img.dataobj)

    if np.issubdtype(raw.dtype, np.integer):
        data = raw.astype(np.int32, copy=False)
        return img, data

    rounded = np.rint(raw)
    max_err = float(np.nanmax(np.abs(raw - rounded)))

    if max_err > 1e-3:
        raise ValueError(
            f"Labelmap has non-integer values. Max error from integer: {max_err}. "
    )

    data = rounded.astype(np.int32)
    return img, data


def mesh_to_glb_bytes(mesh: trimesh.Trimesh) -> bytes:
    exported = mesh.export(file_type="glb")

    if isinstance(exported, bytes):
        return exported

    if isinstance(exported, str):
        return exported.encode("utf-8")

    raise TypeError(f"Unexpected GLB export type: {type(exported)}")


def _build_organ_mesh(
    data: np.ndarray,
    affine: np.ndarray,
    label_id: int,
    global_center: np.ndarray,
) -> trimesh.Trimesh | None:
    """Marching-cubes one organ label into a cleaned, centered trimesh.

    Returns None when the label has no voxels in this case.
    """
    mask = data == label_id

    if not mask.any():
        return None

    # Padding prevents clipped surfaces when the mask touches the boundary.
    padded = np.pad(mask.astype(np.uint8), pad_width=1, mode="constant")

    verts_ijk, faces, normals, values = measure.marching_cubes(
        padded,
        level=0.5,
        step_size=1,
        allow_degenerate=False,
    )

    verts_ijk -= 1.0  # undo padding

    verts_world = nib.affines.apply_affine(affine, verts_ijk)
    verts_three = nifti_world_to_three(verts_world)
    verts_three -= global_center

    mesh = trimesh.Trimesh(
        vertices=verts_three,
        faces=faces,
        process=False,
    )

    # Trimesh cleanup, using the newer API.
    if hasattr(mesh, "unique_faces"):
        mesh.update_faces(mesh.unique_faces())

    if hasattr(mesh, "nondegenerate_faces"):
        mesh.update_faces(mesh.nondegenerate_faces())

    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()

    return mesh


def generate_organ_glb_bytes(
    organ_key: str,
    label_nifti_path: str,
) -> bytes:

    img, data = load_clean_label_data(label_nifti_path)

    label_id = None
    for key, meta in LABELS.items():
        if meta["key"] == organ_key:
            label_id = key
            break

    if label_id is None:
        raise ValueError(f"Unknown organ key: {organ_key}")

    global_center = compute_global_center(data, img.affine)

    mesh = _build_organ_mesh(data, img.affine, label_id, global_center)
    if mesh is None:
        raise ValueError(f"Organ {organ_key} with label {label_id} has no voxels.")

    return mesh_to_glb_bytes(mesh)


def _write_atomic(path: str, payload: bytes) -> None:
    """Write to a temp file then rename, so readers never see a partial file
    and a crash mid-write can't poison the cache."""
    with atomic_destination(path, suffix=".part") as tmp_path:
        with open(tmp_path, "wb") as handle:
            handle.write(payload)


def bake_case_meshes(
    display_id: str,
    label_nifti_path: str,
    out_dir: str,
    route_base: str = "cases",
) -> dict:
    """Generate EVERY organ GLB plus manifest.json for one case in a single
    pass over the labelmap, writing atomically into out_dir.

    This is the one-volume-load path used when a case has no pre-baked
    meshes: loading the labelmap once and meshing all organs costs a fraction
    of the memory of answering each organ's GLB request independently.
    Returns the manifest dict (same shape the pre-bake scripts produce,
    including "bounds", which the viewer's 3D crosshair requires).
    """
    img, data = load_clean_label_data(label_nifti_path)

    global_center = compute_global_center(data, img.affine)
    bounds = compute_volume_bounds_three(data.shape, img.affine)
    present_labels = set(np.unique(data).astype(int).tolist())

    os.makedirs(out_dir, exist_ok=True)

    manifest = {
        "caseId": display_id,
        "center": global_center.tolist(),
        "organs": [],
        "bounds": bounds,
        "affine": img.affine.tolist(),
        # The labelmap given here is in viewer ids (dataset masks are converted
        # first), so the ids below are catalog ids.
        "labelScheme": LABEL_SCHEME,
    }

    for label_id, meta in LABELS.items():
        if label_id not in present_labels:
            continue

        mesh = _build_organ_mesh(data, img.affine, label_id, global_center)
        if mesh is None:
            continue

        filename = f"{safe_filename(meta['key'])}.glb"
        _write_atomic(os.path.join(out_dir, filename), mesh_to_glb_bytes(mesh))

        manifest["organs"].append(
            {
                "id": label_id,
                "key": meta["key"],
                "name": meta["name"],
                # The browser resolves this against the public viewer origin.
                # Avoid embedding the backend's internal HTTP origin, which a
                # public HTTPS page correctly blocks as mixed content.
                "url": f"/api/{route_base}/{display_id}/render_only/{filename}",
                "vertices": int(len(mesh.vertices)),
                "faces": int(len(mesh.faces)),
            }
        )

    _write_atomic(
        os.path.join(out_dir, "manifest.json"),
        json.dumps(manifest, indent=2).encode("utf-8"),
    )

    return manifest


def generate_mesh_manifest(
    case_id: str,
    label_nifti_path: str,
    route_base: str = "cases",
) -> dict:
    # route_base selects which serving route the per-organ GLB URLs point at:
    # "cases" for pre-baked dataset meshes, "sessions" for on-demand meshes
    # generated from an uploaded scan's combined_labels.
    img, data = load_clean_label_data(label_nifti_path)

    present_labels = set(np.unique(data).astype(int).tolist())
    global_center = compute_global_center(data, img.affine)
    bounds = compute_volume_bounds_three(data.shape, img.affine)

    organs = []

    for key, meta in LABELS.items():
        label_id = key

        if label_id not in present_labels:
            continue

        filename = f"{safe_filename(meta['key'])}.glb"

        organs.append(
            {
                "id": key,
                "key": meta["key"],
                "name": meta["name"],
                "url": f"/api/{route_base}/{case_id}/render_only/{filename}",
            }
        )

    return {
        "caseId": case_id,
        "affine": img.affine.tolist(),
        "center": global_center.tolist(),
        "organs": organs,
        # The viewer's 3D crosshair only renders when bounds are present.
        "bounds": bounds,
    }

