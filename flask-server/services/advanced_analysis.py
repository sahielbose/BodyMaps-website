"""Advanced CT analysis used by the viewer's interactive tools.

Two capabilities, both pure NumPy/SciPy/scikit-image so they're unit-testable
on synthetic volumes without any real dataset present:

1. Interactive segmentation (`region_grow`) — a seed-driven 3D region grow that
   backs the viewer's click-to-segment tool. It is deliberately model-agnostic:
   `segment_from_prompt` is the single seam where a promptable model (MedSAM2 /
   nnInteractive) would replace the classical grower, returning the same mask
   contract, so the frontend never changes.

2. Vessel curved-planar analysis (`analyze_vessel`) — skeletonizes a vessel's
   existing segmentation into a centerline, builds a straightened (stretched)
   reformat of the CT along it, and — for pancreatic staging — measures tumour
   contact around the vessel (max circumferential angle + longitudinal length),
   the numbers that drive resectability calls.

Coordinate conventions: NIfTI affines from nibabel map voxel(i,j,k)->world in
RAS+. The viewer (Cornerstone) works in LPS, so `lps_to_ijk` negates x/y before
applying the inverse affine.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage


# --------------------------------------------------------------------------- #
# Coordinate helpers
# --------------------------------------------------------------------------- #

def lps_to_ijk(affine: np.ndarray, point_lps) -> tuple[int, int, int]:
    """Cornerstone world (LPS mm) -> nearest voxel index."""
    ras = np.array([-point_lps[0], -point_lps[1], point_lps[2], 1.0])
    ijk = np.linalg.inv(affine) @ ras
    return tuple(int(round(v)) for v in ijk[:3])


def _voxel_spacing(affine: np.ndarray) -> np.ndarray:
    return np.sqrt((affine[:3, :3] ** 2).sum(axis=0))


# --------------------------------------------------------------------------- #
# 1. Interactive segmentation
# --------------------------------------------------------------------------- #

def region_grow(
    ct: np.ndarray,
    seed_ijk: tuple[int, int, int],
    tolerance: float = 80.0,
    box_ijk: tuple[tuple[int, int, int], tuple[int, int, int]] | None = None,
    max_voxels: int = 4_000_000,
) -> np.ndarray:
    """Grow a connected region of similar HU from `seed_ijk`.

    Returns a uint8 mask the same shape as `ct`. A HU band around the seed's
    intensity is connected-component labelled; the component containing the
    seed is kept (optionally restricted to a bounding box, and capped so a
    click on a huge uniform region can't blow up memory).
    """
    ct = np.asarray(ct)
    i, j, k = seed_ijk
    if not (0 <= i < ct.shape[0] and 0 <= j < ct.shape[1] and 0 <= k < ct.shape[2]):
        raise ValueError("seed is outside the volume")

    seed_hu = float(ct[i, j, k])
    band = (ct >= seed_hu - tolerance) & (ct <= seed_hu + tolerance)

    if box_ijk is not None:
        (lo, hi) = box_ijk
        mask_box = np.zeros_like(band)
        lo = [max(0, v) for v in lo]
        hi = [min(ct.shape[d], hi[d]) for d in range(3)]
        mask_box[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]] = True
        band &= mask_box

    labeled, _ = ndimage.label(band)
    seed_label = labeled[i, j, k]
    if seed_label == 0:
        return np.zeros_like(ct, dtype=np.uint8)

    mask = labeled == seed_label
    if int(mask.sum()) > max_voxels:
        # Too permissive a grow — shrink the band and retry once.
        band = (ct >= seed_hu - tolerance / 2) & (ct <= seed_hu + tolerance / 2)
        if box_ijk is not None:
            band &= mask_box
        labeled, _ = ndimage.label(band)
        seed_label = labeled[i, j, k]
        mask = labeled == seed_label if seed_label else np.zeros_like(band)
        if int(mask.sum()) > max_voxels:
            # Still over the cap after tightening — refuse rather than return
            # (and hole-fill) an oversized mask.
            raise ValueError(
                "Selection too large — click a more specific region or restrict it with a box."
            )

    # Fill interior holes so the proposal is a solid object.
    mask = ndimage.binary_fill_holes(mask)
    return mask.astype(np.uint8)
USE_NNINTERACTIVE = True


def segment_from_prompt(
    ct: np.ndarray, affine: np.ndarray, prompt: dict, case_key: str | None = None
) -> tuple[np.ndarray, list | None]:
    """Model-agnostic entry point for the click-to-segment tool.

    Returns (mask, changed_bbox): changed_bbox is the [[i0,i1],[j0,j1],
    [k0,k1]] slab (upper-exclusive) the model's prediction actually wrote —
    everything outside it is unchanged from the session's previous response —
    or None when that isn't known (region_grow fallback, older model
    server), meaning the caller must treat the whole volume as changed.

    `case_key` (e.g. "17:full") lets the nnInteractive path cache the
    uploaded volume across requests for the same case+resolution.

    `prompt["session_token"]` (opaque client string) keeps the nnInteractive
    prompt session open across requests: consecutive prompts carrying the
    same token accumulate as context on the model server, so each new click
    REFINES the same object instead of starting over. Session responses are
    authoritative — once a token has accumulated context, failures raise
    instead of falling back to region_grow (bolting a threshold blob onto a
    model-refined mask would corrupt the object), and an empty mask is
    returned as-is rather than triggering the fallback.

    `prompt["include"]: false` marks a corrective prompt — carve the clicked
    region OUT of the session's object instead of adding to it. Only the
    interactive model understands that; there is no region-grow equivalent,
    so corrective prompts never fall back and are refused outright when the
    model path is unavailable.

    `prompt["initial_seg_gz_b64"]` (base64 of a gzipped uint8 labelmap in
    NIfTI file order, one byte per CT voxel, nonzero = in the object) seeds a
    fresh session from an existing mask — the model continues from a shipped
    organ label instead of starting an empty object. Seeded requests are
    model-only for the same reason corrective ones are: region_grow can't
    honor the seed, and silently answering with an unrelated threshold blob
    would read as the model mangling the user's existing label.

    `prompt["scribble_lps"]` ([[x,y,z], ...], 2+ points on one viewport
    slice) is a stroke prompt: the backend rasterizes it to a thin polyline
    mask on that slice and the model segments the structure under it. Takes
    precedence over point/box when present (point_lps still accompanies it,
    as the stroke's first vertex, for older-server compatibility). Model-only.

    `prompt["lasso_lps"]` (3+ points) is the closed sibling: a freehand
    contour rasterized as a FILLED polygon on its slice — "everything inside
    this outline is the object". Same precedence and model-only rules.
    """
    if "point_ijk" in prompt:
        seed = tuple(int(v) for v in prompt["point_ijk"])
    elif "point_lps" in prompt:
        seed = lps_to_ijk(affine, prompt["point_lps"])
    else:
        raise ValueError("prompt needs point_ijk or point_lps")

    box_ijk = None
    if prompt.get("box_lps"):
        c0 = lps_to_ijk(affine, prompt["box_lps"][0])
        c1 = lps_to_ijk(affine, prompt["box_lps"][1])
        box_ijk = (
            tuple(min(a, b) for a, b in zip(c0, c1)),
            tuple(max(a, b) + 1 for a, b in zip(c0, c1)),
        )

    scribble_ijk = None
    if prompt.get("scribble_lps"):
        scribble_ijk = [lps_to_ijk(affine, p) for p in prompt["scribble_lps"]]
        if len(scribble_ijk) < 2:
            raise ValueError("A scribble needs at least 2 points.")

    lasso_ijk = None
    if prompt.get("lasso_lps"):
        lasso_ijk = [lps_to_ijk(affine, p) for p in prompt["lasso_lps"]]
        if len(lasso_ijk) < 3:
            raise ValueError("A lasso needs at least 3 points.")

    session_token = prompt.get("session_token") or None
    include = prompt.get("include")
    include = True if include is None else bool(include)

    initial_seg = None
    seg_b64 = prompt.get("initial_seg_gz_b64")
    if seg_b64:
        import base64
        import gzip
        try:
            raw = gzip.decompress(base64.b64decode(seg_b64))
        except Exception:
            raise ValueError("initial_seg_gz_b64 is not valid base64 gzip data.")
        if len(raw) != ct.size:
            raise ValueError(
                f"initial_seg has {len(raw)} voxels but the CT has {ct.size} — "
                "resolution mismatch between the viewer and this request."
            )
        # The client ships the labelmap as raw linear bytes in NIfTI file
        # order (i fastest), so a Fortran reshape recovers [i, j, k] indexing.
        initial_seg = np.frombuffer(raw, dtype=np.uint8).reshape(ct.shape, order="F")

    # Prompts that only the interactive model can honor: corrective (no
    # region-grow equivalent), seeded (the fallback would ignore the seed and
    # mangle the existing label), and stroke-shaped (region_grow takes one
    # seed point — answering a drawn stroke with a blob grown from its first
    # vertex would silently ignore what the user drew).
    model_only = (
        (not include)
        or initial_seg is not None
        or scribble_ijk is not None
        or lasso_ijk is not None
    )

    if USE_NNINTERACTIVE:
        try:
            from services.nninteractive_predictor import predict
            mask, changed_bbox = predict(
                ct,
                case_key or "unkeyed",
                point_ijk=seed if (box_ijk is None and scribble_ijk is None and lasso_ijk is None) else None,
                box_ijk=box_ijk if (scribble_ijk is None and lasso_ijk is None) else None,
                scribble_ijk=scribble_ijk,
                lasso_ijk=lasso_ijk,
                session_token=session_token,
                include=include,
                initial_seg=initial_seg,
            )
            if session_token is not None or model_only or mask.sum() > 0:
                # In-session responses are authoritative even when empty (a
                # refinement can legitimately shrink the object) — see the
                # docstring. Only tokenless one-shot prompts keep the empty
                # -> region_grow fallback.
                return mask, changed_bbox
            print("[segment_from_prompt] nnInteractive returned empty mask, falling back to region_grow")
        except Exception as e:
            from services import nninteractive_predictor as _predictor
            if model_only or _predictor.session_is_active(session_token):
                # No fallback exists for model-only prompts, and a token that
                # already refined an object across earlier prompts must not
                # silently switch models mid-session. Fail loudly instead.
                raise
            print(f"[segment_from_prompt] nnInteractive failed ({type(e).__name__}: {e}), falling back to region_grow")

    if model_only:
        raise ValueError(
            "That prompt needs the interactive model server, which is not available right now."
        )
    tolerance = min(max(float(prompt.get("tolerance", 80.0)), 1.0), 1000.0)
    return region_grow(ct, seed, tolerance=tolerance, box_ijk=box_ijk), None

# --------------------------------------------------------------------------- #
# 2. Vessel curved-planar analysis
# --------------------------------------------------------------------------- #

def vessel_centerline(mask: np.ndarray, n_bins: int = 200) -> np.ndarray:
    """Ordered centerline (N,3 voxel coords) from a binary vessel mask.

    Robust principal-axis binning: take the mask's dominant direction (PCA of
    the voxel coordinates), project every voxel onto it, then take the centroid
    of the voxels in each bin along that axis. This always yields an ordered
    centerline for a tubular structure regardless of thickness (unlike medial-
    axis skeletonization, which can erode a clean thick tube to nothing). It
    trades some accuracy on sharply curved vessels — acceptable for a v1; a
    curvature-following refinement is the natural next step.
    """
    coords = np.argwhere(mask > 0).astype(float)
    if len(coords) < 2:
        return coords.astype(int)

    center = coords.mean(axis=0)
    centered = coords - center
    # Principal axis = eigenvector of the largest covariance eigenvalue.
    cov = np.cov(centered.T)
    eigvals, eigvecs = np.linalg.eigh(cov)
    axis = eigvecs[:, np.argmax(eigvals)]

    t = centered @ axis  # scalar position along the axis
    order = np.argsort(t)
    t_sorted = t[order]
    coords_sorted = coords[order]

    # Bin along the axis; each bin's centroid is a centerline point.
    edges = np.linspace(t_sorted[0], t_sorted[-1], n_bins + 1)
    bin_idx = np.clip(np.digitize(t_sorted, edges) - 1, 0, n_bins - 1)
    points = []
    for b in range(n_bins):
        sel = coords_sorted[bin_idx == b]
        if len(sel):
            points.append(sel.mean(axis=0))
    return np.array(points)


def _perp_frame(tangent: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Two unit vectors spanning the plane perpendicular to `tangent`."""
    t = tangent / (np.linalg.norm(tangent) + 1e-9)
    ref = np.array([0.0, 0.0, 1.0]) if abs(t[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(t, ref)
    u /= np.linalg.norm(u) + 1e-9
    v = np.cross(t, u)
    return u, v


def analyze_vessel(
    ct: np.ndarray,
    affine: np.ndarray,
    vessel_mask: np.ndarray,
    lesion_mask: np.ndarray | None = None,
    slab_radius_mm: float = 20.0,
    contact_radius_mm: float = 3.0,
    max_centerline_points: int = 256,
) -> dict:
    """Straightened reformat + tumour-contact metrics along a vessel.

    Returns a dict with:
      - `reformat`: 2D float array (rows = across the vessel, cols = along it) —
        a stretched CPR of the CT, ready to window and display.
      - `length_mm`: centerline length.
      - `max_contact_deg`: largest circumferential tumour-contact angle (0–360),
        the primary resectability signal; `contact_length_mm`: extent of contact
        along the vessel. Both 0 when no lesion mask is given.
      - `contact_profile`: per-point contact angle (for a plot).
    """
    # slab_radius_mm arrives straight from a public endpoint and n_across scales
    # linearly with it — clamp so a huge value can't allocate an enormous reformat.
    slab_radius_mm = min(max(float(slab_radius_mm), 1.0), 100.0)

    spacing = _voxel_spacing(affine)
    centerline = vessel_centerline(vessel_mask)
    if len(centerline) < 2:
        raise ValueError("vessel segmentation too small to form a centerline")

    # Subsample long centerlines for a manageable, evenly-spaced reformat.
    if len(centerline) > max_centerline_points:
        idx = np.linspace(0, len(centerline) - 1, max_centerline_points).astype(int)
        centerline = centerline[idx]

    pts = centerline.astype(float)
    tangents = np.gradient(pts, axis=0)
    mean_sp = float(spacing.mean())

    # --- Straightened reformat: CT sampled across the vessel at each point ---
    n_across = int(2 * slab_radius_mm / mean_sp) + 1
    s_mm = np.linspace(-slab_radius_mm, slab_radius_mm, n_across)
    columns = []
    for p, t in zip(pts, tangents):
        u, _ = _perp_frame(t)
        line = p[:, None] + (u[:, None] * (s_mm / spacing[:, None]))
        columns.append(ndimage.map_coordinates(ct, line, order=1, mode="constant", cval=-1000.0))
    reformat = np.array(columns).T  # rows = across, cols = along

    # Centerline length (mm) and mean step between points.
    seg = np.diff(pts, axis=0) * spacing
    length_mm = float(np.sqrt((seg ** 2).sum(axis=1)).sum())
    step_mm = length_mm / max(len(pts) - 1, 1)

    # --- Tumour contact (robust): dilate the vessel by the contact margin,
    # intersect with the lesion to get the abutment shell, assign each shell
    # voxel to its nearest centerline point, and measure the angular coverage
    # of tumour around the vessel at each cross-section. The worst cross-section
    # gives the circumferential contact angle used for staging. ---
    contact_profile = np.zeros(len(pts))
    if lesion_mask is not None and lesion_mask.sum() > 0:
        from scipy.spatial import cKDTree

        rad_vox = max(1, int(round(contact_radius_mm / mean_sp)))
        shell = ndimage.binary_dilation(vessel_mask > 0, iterations=rad_vox) & ~(vessel_mask > 0)
        contact_vox = np.argwhere(shell & (lesion_mask > 0)).astype(float)
        if len(contact_vox):
            nearest = cKDTree(pts).query(contact_vox)[1]
            n_ang_bins = 72  # 5° resolution
            for k in range(len(pts)):
                sel = contact_vox[nearest == k]
                if not len(sel):
                    continue
                u, v = _perp_frame(tangents[k])
                d = sel - pts[k]
                ang = np.arctan2(d @ v, d @ u)  # -π..π
                occupied = np.unique(((ang + np.pi) / (2 * np.pi) * n_ang_bins).astype(int))
                contact_profile[k] = len(occupied) / n_ang_bins * 360.0

    max_contact_deg = float(contact_profile.max()) if contact_profile.size else 0.0
    contact_length_mm = float((contact_profile > 1.0).sum() * step_mm)

    return {
        "reformat": reformat,
        "length_mm": length_mm,
        "max_contact_deg": max_contact_deg,
        "contact_length_mm": contact_length_mm,
        "contact_profile": contact_profile.tolist(),
        "num_points": int(len(pts)),
    }
