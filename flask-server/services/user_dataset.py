"""User-data collection with an admission gatekeeper.

When a user runs inference we may keep their CT + our segmentation to grow an
in-house dataset — but ONLY if it passes an admission gate. This is deliberately
decoupled from the user's experience: it runs in a background thread AFTER the
result is already delivered, and any failure here is swallowed. A user who
uploads garbage still gets their result; the garbage just doesn't enter the
dataset.

The gate has four jobs (see `evaluate`):
  1. Is it a real CT?      -- valid 3D volume, plausible dims, CT-like HU range.
  2. Is it a duplicate?    -- exact + near-duplicate fingerprint vs the registry.
  3. Is it usable?         -- our own segmentation found plausible organs.
  4. Is it abuse?          -- per-user / per-IP rolling quotas + a size cap, so a
                              competitor dumping thousands of files can't flood us.

Accepted scans are promoted into a PanTS-mirroring layout under
``Constants.USER_DATASET_PATH`` (so it can sit beside PanTS/CancerVerse once a
writable location is granted):

    UserData/
      image_only/USER_00000001/ct.nii.gz
      mask_only/USER_00000001/combined_labels.nii.gz
      mask_only/USER_00000001/segmentations/<organ>.nii.gz
      mask_only/USER_00000001/metadata.json
      registry.json          # case-id counter, fingerprints, per-user counts
      rejections.jsonl        # audit trail of what was turned away and why

The whole feature is inert unless ``USER_DATASET_PATH`` is configured, so merging
this changes nothing until it is switched on in the environment.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Optional

from services.atomic_write import atomic_destination

# Heavy/optional imports (nibabel, numpy) are done lazily inside the worker so
# importing this module in the request path stays cheap and never fails a route.

# Viewer label id -> organ name, for splitting combined_labels into per-organ
# sublabels. Mirrors _VIEWER_LABELS in auto_segmentor.py / the frontend scheme.
_LABEL_NAMES = {
    1: "adrenal_gland_left", 2: "adrenal_gland_right", 3: "aorta", 4: "bladder",
    5: "celiac_artery", 6: "colon", 7: "common_bile_duct", 8: "duodenum",
    9: "femur_left", 10: "femur_right", 11: "gall_bladder", 12: "kidney_left",
    13: "kidney_right", 14: "liver", 15: "lung_left", 16: "lung_right",
    17: "pancreas", 18: "pancreas_body", 19: "pancreas_head", 20: "pancreas_tail",
    21: "pancreatic_duct", 22: "pancreatic_lesion", 23: "postcava", 24: "prostate",
    25: "spleen", 26: "stomach", 27: "superior_mesenteric_artery", 28: "veins",
    29: "intestine", 30: "renal_vein_left", 31: "renal_vein_right", 32: "cbd_stent",
    33: "liver_lesion", 34: "kidney_lesion", 35: "colon_lesion",
}

# --- tunables (all overridable via env) ---
# High-resolution clinical scans are exactly what we want to keep, so the defaults
# admit them (a 512x512x1394 scan is ~330 MB compressed / 365M voxels).
MAX_CT_BYTES = int(os.environ.get("USER_DATASET_MAX_CT_BYTES", str(2 * 1024 ** 3)))  # 2 GB
# The .nii.gz cap is on the COMPRESSED bytes; a header can still declare a volume
# that decodes to tens of GB (a near-constant "gzip bomb" fits well under 600 MB).
# Bound the DECODED voxel count too, before any np.asarray, so a crafted scan
# can't OOM-kill the worker. 1B voxels ~= 2 GB int16. Only one scan is decoded at a
# time (_HEAVY_WORK), so this bounds the web process's extra memory.
MAX_VOXELS = int(os.environ.get("USER_DATASET_MAX_VOXELS", str(1_000_000_000)))
DAILY_PER_USER = int(os.environ.get("USER_DATASET_DAILY_PER_USER", "50"))
DAILY_PER_IP = int(os.environ.get("USER_DATASET_DAILY_PER_IP", "50"))
DAILY_GLOBAL = int(os.environ.get("USER_DATASET_DAILY_GLOBAL", "2000"))
MIN_ORGAN_VOXELS = int(os.environ.get("USER_DATASET_MIN_ORGAN_VOXELS", "20000"))
MIN_DISTINCT_ORGANS = int(os.environ.get("USER_DATASET_MIN_DISTINCT_ORGANS", "3"))
# Resolution. Calibrated on 400 PanTS scans (the reference set): median 0.79 mm in-plane and
# 1.25 mm slices, worst in-plane 1.5 mm, worst slices 5 mm (one 7.5 mm outlier). A scan is
# REFUSED only if it is clearly worse than that; the rest get a quality tier so the best
# can be pulled out later ("high" = thin slices, fine in-plane, no organ cut off by the FOV).
MAX_SLICE_MM = float(os.environ.get("USER_DATASET_MAX_SLICE_MM", "5.0"))
MAX_INPLANE_MM = float(os.environ.get("USER_DATASET_MAX_INPLANE_MM", "1.5"))
HIGH_SLICE_MM = float(os.environ.get("USER_DATASET_HIGH_SLICE_MM", "2.5"))
HIGH_INPLANE_MM = float(os.environ.get("USER_DATASET_HIGH_INPLANE_MM", "1.0"))
# Collection pauses when the disk that also hosts the website and its job sessions would
# fall below this much free space (plus room for the scan being stored).
MIN_FREE_BYTES = int(float(os.environ.get("USER_DATASET_MIN_FREE_GB", "100")) * 2 ** 30)
# A lesion label counts as "flagged" only above this many voxels, so a speck of noise in the
# recall-oriented lesion output does not mark a scan as interesting.
MIN_LESION_VOXELS = int(os.environ.get("USER_DATASET_MIN_LESION_VOXELS", "50"))
_LESION_LABELS = (22, 33, 34, 35)     # pancreatic, liver, kidney, colon lesion (viewer ids)
NEAR_DUP_GRID = 24  # downsample edge for the perceptual (near-duplicate) fingerprint

_WINDOW_SECONDS = 24 * 3600
_registry_lock = threading.Lock()
# Decoding a large volume is the expensive part of collection and happens inside the
# web process. One at a time keeps parallel jobs from stacking multi-GB arrays.
_HEAVY_WORK = threading.Lock()
_last_disk_note = 0.0


@contextlib.contextmanager
def _locked(root: str):
    """Serialize the registry read-modify-write across BOTH threads (in-process)
    and processes. Prod is gunicorn --workers 1, where the threading lock alone
    suffices; the fcntl file lock makes it correct even if that ever changes.
    Falls back to threads-only where fcntl is unavailable (e.g. Windows/CI)."""
    with _registry_lock:
        lf = None
        try:
            import fcntl
            lf = open(os.path.join(root, ".registry.lock"), "w")
            fcntl.flock(lf, fcntl.LOCK_EX)
        except Exception:
            if lf is not None:
                try:
                    lf.close()
                except Exception:
                    pass
            lf = None
        try:
            yield
        finally:
            if lf is not None:
                try:
                    import fcntl
                    fcntl.flock(lf, fcntl.LOCK_UN)
                    lf.close()
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# Root / registry helpers
# ---------------------------------------------------------------------------
def _root() -> Optional[str]:
    """Configured dataset root, or None when the feature is switched off."""
    p = os.environ.get("USER_DATASET_PATH", "").strip()
    return p or None


def _registry_path(root: str) -> str:
    return os.path.join(root, "registry.json")


def _load_registry(root: str) -> dict:
    path = _registry_path(root)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                reg = json.load(f)
        except Exception:
            reg = {}
    else:
        reg = {}
    reg.setdefault("next_id", 1)
    reg.setdefault("sha256", {})        # exact-dup: fingerprint -> case_id
    reg.setdefault("phash", {})         # near-dup:  fingerprint -> case_id
    reg.setdefault("events", [])        # [{ts, user_id, ip}] for rolling quotas
    return reg


def _save_registry(root: str, reg: dict) -> None:
    path = _registry_path(root)
    with atomic_destination(path) as tmp:   # atomic publish, temp unique to this write
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(reg, f)


def _prune_events(reg: dict, now: float) -> None:
    cutoff = now - _WINDOW_SECONDS
    reg["events"] = [e for e in reg.get("events", []) if e.get("ts", 0) >= cutoff]


# ---------------------------------------------------------------------------
# Gatekeeper checks (pure-ish; unit-tested)
# ---------------------------------------------------------------------------
def validate_ct(ct_path: str):
    """(ok, reason). A real abdominal/body CT: valid 3D volume, plausible dims,
    CT-like HU range (air near -1000, tissue/bone above), not constant."""
    try:
        import numpy as np
        import nibabel as nib
    except Exception as e:  # pragma: no cover - deps present in prod env
        return False, f"deps_missing:{e}"
    if not os.path.exists(ct_path):
        return False, "missing_file"
    try:
        size = os.path.getsize(ct_path)
    except OSError:
        return False, "unstatable"
    if size > MAX_CT_BYTES:
        return False, "too_large"
    if size < 5 * 1024:
        return False, "too_small"
    try:
        img = nib.load(ct_path)
        shape = img.shape
    except Exception as e:
        return False, f"unreadable:{type(e).__name__}"
    dims = [d for d in shape if d > 1]
    if len(dims) != 3:
        return False, f"not_3d:{list(shape)}"
    if any(d < 16 or d > 2048 for d in dims):
        return False, f"implausible_dims:{dims}"
    # Reject on the DECODED size before materializing anything (anti-OOM, C1).
    voxels = 1
    for d in dims:
        voxels *= int(d)
    if voxels > MAX_VOXELS:
        return False, f"too_many_voxels:{voxels}"
    try:
        # Native dtype (usually int16) rather than forcing float32 -- half the
        # memory, and CT intensities are integral anyway.
        arr = np.asarray(img.dataobj)
    except Exception as e:
        return False, f"undecodable:{type(e).__name__}"
    # Require ALL values finite: nanmin/nanmax ignore NaN but not +/-inf, which
    # would otherwise sail through the range check and poison the fingerprint.
    if arr.dtype.kind == "f" and not np.isfinite(arr).all():
        return False, "non_finite_values"
    lo, hi = float(np.min(arr)), float(np.max(arr))
    if lo == hi:
        return False, "constant_volume"
    # CT signature: air present (well below 0) and tissue/bone present (above 0).
    if lo > -200 or hi < 100:
        return False, f"non_ct_intensity:[{lo:.0f},{hi:.0f}]"
    return True, "ok"


def fingerprints(ct_path: str):
    """(sha256, phash). sha256 = exact-duplicate key over the raw file; phash =
    a coarse content hash (downsampled + quantized) that catches re-uploads that
    differ only in compression/metadata."""
    import numpy as np
    import nibabel as nib
    sha = file_sha256(ct_path)
    try:
        img = nib.load(ct_path)
        vox = 1
        for d in img.shape:
            vox *= int(d)
        if vox > MAX_VOXELS:      # defensive: validate_ct already rejects these
            return sha, sha
        arr = np.squeeze(np.asarray(img.dataobj))   # native dtype
        g = NEAR_DUP_GRID
        # block-average to a fixed GxGxG grid, quantize, hash
        idx = [np.linspace(0, s, g + 1).astype(int) for s in arr.shape[:3]]
        small = np.zeros((g, g, g), dtype="float32")
        for i in range(g):
            for j in range(g):
                for k in range(g):
                    blk = arr[idx[0][i]:idx[0][i + 1], idx[1][j]:idx[1][j + 1], idx[2][k]:idx[2][k + 1]]
                    small[i, j, k] = float(blk.mean()) if blk.size else 0.0
        q = np.round(small / 50.0).astype("int16")  # 50 HU buckets
        ph = hashlib.sha256(q.tobytes()).hexdigest()
    except Exception:
        ph = sha  # fall back to exact key if the perceptual pass fails
    return sha, ph


def file_sha256(ct_path: str) -> str:
    """Streaming sha256 of the uploaded file -- about a second for a 300 MB scan,
    and no decoding, so a repeat upload can be recognised before any heavy work."""
    h = hashlib.sha256()
    with open(ct_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_geometry(ct_path: str) -> dict:
    """Shape and voxel spacing from the header only (no decoding), kept in the case
    metadata so quality (resolution, slice thickness) can be filtered later."""
    try:
        import nibabel as nib
        img = nib.load(ct_path)
        return {"shape": [int(d) for d in img.shape],
                "spacing_mm": [round(float(z), 4) for z in img.header.get_zooms()[:3]]}
    except Exception:
        return {}


def resolution_gate(geometry: dict):
    """(ok, reason). Header-only, so a poor scan is turned away before anything is
    decoded. Slice thickness is the coarsest axis and in-plane the next one, whatever
    order the file stores its axes in."""
    zooms = sorted(float(z) for z in geometry.get("spacing_mm", []) if z and z > 0)
    if len(zooms) != 3:
        return False, "no_voxel_spacing"
    if zooms[2] > MAX_SLICE_MM:
        return False, f"slices_too_thick:{zooms[2]:.2f}mm"
    if zooms[1] > MAX_INPLANE_MM:
        return False, f"in_plane_too_coarse:{zooms[1]:.2f}mm"
    return True, "ok"


def quality_tier(geometry: dict, stats: dict) -> str:
    """"high" or "standard" -- a label stored with each case, not a gate."""
    zooms = sorted(float(z) for z in geometry.get("spacing_mm", []) if z and z > 0)
    if len(zooms) == 3 and zooms[2] <= HIGH_SLICE_MM and zooms[1] <= HIGH_INPLANE_MM             and not (stats or {}).get("edge_clipped_organs"):
        return "high"
    return "standard"


def case_summary(geometry: dict, stats: dict) -> dict:
    """What is in the scan, for picking out the rare and informative cases later without
    re-reading every volume: organ volumes in mL and which lesion labels the model flagged.
    `lesion_flagged` means our model marked one, not that one exists -- the lesion output
    is tuned for recall, so it also marks some healthy tissue."""
    zooms = [float(z) for z in geometry.get("spacing_mm", []) if z and z > 0]
    voxel_ml = (zooms[0] * zooms[1] * zooms[2] / 1000.0) if len(zooms) == 3 else None
    counts = (stats or {}).get("label_voxels", {})
    out = {}
    if voxel_ml is not None:
        out["organ_volumes_ml"] = {_LABEL_NAMES.get(l, f"label_{l}"): round(c * voxel_ml, 2)
                                   for l, c in sorted(counts.items())}
    flagged = {_LABEL_NAMES.get(l, f"label_{l}"): c for l, c in counts.items()
               if l in _LESION_LABELS and c >= MIN_LESION_VOXELS}
    out["lesion_flagged"] = bool(flagged)
    out["lesions_flagged"] = flagged
    return out


def has_room_for(root: str, ct_path: str) -> bool:
    """False when storing this scan (plus its masks, counted as 2x the scan) would leave
    less than MIN_FREE_BYTES free. If the disk cannot be read, do not collect."""
    try:
        free = shutil.disk_usage(root).free
        return free - 3 * os.path.getsize(ct_path) >= MIN_FREE_BYTES
    except OSError:
        return False


def segmentation_quality_ok(combined_labels_path: str):
    """(ok, reason, stats). Our own mask is the judge: a real abdominal CT yields
    plausible organs. Reject empty/degenerate segmentations (garbage in -> nothing
    the model can find)."""
    try:
        import numpy as np
        import nibabel as nib
    except Exception as e:  # pragma: no cover
        return False, f"deps_missing:{e}", {}
    if not os.path.exists(combined_labels_path):
        return False, "no_mask", {}
    try:
        data = np.asarray(nib.load(combined_labels_path).dataobj)
    except Exception as e:
        return False, f"mask_unreadable:{type(e).__name__}", {}
    uniq, counts = np.unique(data, return_counts=True)
    label_voxels = {int(v): int(c) for v, c in zip(uniq, counts) if int(v) != 0}
    labels = list(label_voxels)
    organ_voxels = int((data != 0).sum())
    # Organs present in the first or last slice were cut off by the scan's field of view.
    # nibabel's last axis is the slice axis for the NIfTI files we receive.
    edge = set()
    vol = np.squeeze(data)
    if vol.ndim == 3:
        for sl in (vol[..., 0], vol[..., -1]):
            edge |= {int(v) for v in np.unique(sl) if int(v) != 0}
    stats = {"organ_voxels": organ_voxels, "distinct_organs": len(labels),
             "edge_clipped_organs": len(edge), "label_voxels": label_voxels}
    if organ_voxels < MIN_ORGAN_VOXELS:
        return False, f"too_few_organ_voxels:{organ_voxels}", stats
    if len(labels) < MIN_DISTINCT_ORGANS:
        return False, f"too_few_organs:{len(labels)}", stats
    return True, "ok", stats


def check_quota(reg: dict, user_id: Optional[str], ip: Optional[str], now: float):
    """(ok, reason). Rolling 24h caps: per-user, per-IP, and global. Anti-flood:
    a burst from one account/IP is bounded regardless of dedup."""
    events = reg.get("events", [])
    cutoff = now - _WINDOW_SECONDS
    recent = [e for e in events if e.get("ts", 0) >= cutoff]
    if len(recent) >= DAILY_GLOBAL:
        return False, "global_quota"
    if user_id and sum(1 for e in recent if e.get("user_id") == user_id) >= DAILY_PER_USER:
        return False, "user_quota"
    if ip and sum(1 for e in recent if e.get("ip") == ip) >= DAILY_PER_IP:
        return False, "ip_quota"
    return True, "ok"


# ---------------------------------------------------------------------------
# Promotion
# ---------------------------------------------------------------------------
def _write_sublabels(combined_labels_path: str, seg_dir: str, existing_seg_dir: Optional[str]) -> list:
    """Per-organ binary masks. Prefer masks a model already produced; otherwise
    split combined_labels by label id."""
    import numpy as np
    import nibabel as nib
    os.makedirs(seg_dir, exist_ok=True)
    written = []
    if existing_seg_dir and os.path.isdir(existing_seg_dir):
        for fn in sorted(os.listdir(existing_seg_dir)):
            if fn.endswith(".nii.gz"):
                shutil.copy2(os.path.join(existing_seg_dir, fn), os.path.join(seg_dir, fn))
                written.append(fn[:-len(".nii.gz")])
        if written:
            return written
    img = nib.load(combined_labels_path)
    data = np.asarray(img.dataobj)
    for lab in [int(v) for v in np.unique(data) if int(v) != 0]:
        name = _LABEL_NAMES.get(lab, f"label_{lab}")
        binary = (data == lab).astype("uint8")
        # Fresh header (affine only) with an explicit uint8 dtype, so the source
        # label map's datatype / scl_slope / scl_inter can't misencode the mask.
        out = nib.Nifti1Image(binary, img.affine)
        out.set_data_dtype(np.uint8)
        nib.save(out, os.path.join(seg_dir, f"{name}.nii.gz"))
        written.append(name)
    return written


def _store_nifti_gz(src: str, dst: str) -> None:
    """Store a NIfTI at dst as a genuinely gzip-compressed .nii.gz. If src is
    already gzip (the usual .nii.gz upload) its bytes are preserved exactly; a raw
    .nii is gzipped on the way in. Without this, copying an uncompressed upload to
    a .nii.gz name would waste space AND write a file nibabel can't load (it
    gunzips by extension)."""
    with open(src, "rb") as f:
        is_gzip = f.read(2) == b"\x1f\x8b"
    if is_gzip:
        shutil.copy2(src, dst)
    else:
        import gzip
        with open(src, "rb") as fin, gzip.open(dst, "wb") as fout:
            shutil.copyfileobj(fin, fout)


def _promote(root: str, case_id: str, ct_path: str, combined_labels_path: str,
             existing_seg_dir: Optional[str], metadata: dict) -> None:
    """Write all of a case's files into `.partial` staging dirs, then publish each
    with an atomic rename. A partial failure (disk full, bad NIfTI, killed thread)
    leaves only staging dirs behind -- never a half-written case that the next
    admission could merge into."""
    img_final = os.path.join(root, "image_only", case_id)
    mask_final = os.path.join(root, "mask_only", case_id)
    img_stage, mask_stage = img_final + ".partial", mask_final + ".partial"
    for d in (img_stage, mask_stage):
        shutil.rmtree(d, ignore_errors=True)   # clear leftovers from a prior crash
    try:
        os.makedirs(img_stage, exist_ok=True)
        os.makedirs(mask_stage, exist_ok=True)
        _store_nifti_gz(ct_path, os.path.join(img_stage, "ct.nii.gz"))
        _store_nifti_gz(combined_labels_path, os.path.join(mask_stage, "combined_labels.nii.gz"))
        organs = _write_sublabels(combined_labels_path, os.path.join(mask_stage, "segmentations"),
                                  existing_seg_dir)
        meta = {**metadata, "case_id": case_id, "organs": organs}
        with open(os.path.join(mask_stage, "metadata.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        os.replace(img_stage, img_final)      # atomic publish (final can't pre-exist:
        os.replace(mask_stage, mask_final)    # case_id is a freshly reserved counter)
    except Exception:
        shutil.rmtree(img_stage, ignore_errors=True)
        shutil.rmtree(mask_stage, ignore_errors=True)
        raise


def _record_rejection(root: str, reason: str, ctx: dict) -> None:
    try:
        with open(os.path.join(root, "rejections.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.time(), "reason": reason, **ctx}) + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def evaluate(ct_path: str, combined_labels_path: str, reg: dict,
             user_id: Optional[str], ip: Optional[str], now: float):
    """Run the four gates. Returns (accepted: bool, reason: str, extra: dict)."""
    ok, reason = check_quota(reg, user_id, ip, now)
    if not ok:
        return False, reason, {}
    ok, reason = validate_ct(ct_path)
    if not ok:
        return False, reason, {}
    ok, reason, stats = segmentation_quality_ok(combined_labels_path)
    if not ok:
        return False, reason, {"stats": stats}
    sha, ph = fingerprints(ct_path)
    if sha in reg["sha256"]:
        return False, "duplicate_exact", {"sha256": sha, "of": reg["sha256"][sha]}
    if ph in reg["phash"]:
        return False, "duplicate_near", {"phash": ph, "of": reg["phash"][ph]}
    return True, "ok", {"sha256": sha, "phash": ph, "stats": stats}


def _admit_and_store(ct_path: str, output_mask_dir: str, model: str,
                     user_id: Optional[str], ip: Optional[str], session_id: Optional[str]) -> None:
    root = _root()
    if not root:
        return  # feature off
    if not os.path.isfile(ct_path):
        return  # e.g. ShapeKit is handed a segmentation directory, not a CT file
    combined = os.path.join(output_mask_dir, "combined_labels.nii.gz")
    existing_seg = os.path.join(output_mask_dir, "segmentations")
    ctx = {"user_id": user_id, "ip": ip, "model": model, "session_id": session_id}
    try:
        os.makedirs(root, exist_ok=True)
        now = time.time()

        # 0) Disk floor, before anything else (and before the attempt is counted): the
        #    dataset must never fill the disk the website runs on.
        if not has_room_for(root, ct_path):
            global _last_disk_note
            if now - _last_disk_note > 3600:    # one line an hour, not one per upload
                _last_disk_note = now
                _record_rejection(root, "disk_floor", ctx)
                print("[user_dataset] paused: not enough free disk space", flush=True)
            return

        # 1) Quota + attempt accounting (cheap, under the lock). The attempt is
        #    recorded regardless of the outcome below, so a flood of REJECTS is
        #    rate-limited too -- not just accepted scans.
        with _locked(root):
            reg = _load_registry(root)
            _prune_events(reg, now)
            ok, qreason = check_quota(reg, user_id, ip, now)
            reg["events"].append({"ts": now, "user_id": user_id, "ip": ip})
            _save_registry(root, reg)
        if not ok:
            _record_rejection(root, qreason, ctx)
            return

        # 2a) Cheapest first: if this exact file is already in the dataset, say so now
        #     (a second of hashing) instead of decoding the whole volume to find out.
        #     The check is repeated under the lock below, which is the authority.
        sha = file_sha256(ct_path)
        with _locked(root):
            seen = _load_registry(root)["sha256"].get(sha)
        if seen:
            _record_rejection(root, "duplicate_exact", {**ctx, "of": seen})
            return

        # 2b) Resolution, from the header alone: turn a poor scan away before decoding it.
        geometry = scan_geometry(ct_path)
        ok, reason = resolution_gate(geometry)
        if not ok:
            _record_rejection(root, reason, {**ctx, **geometry})
            return

        # 2c) Expensive gates OUTSIDE the registry lock (they touch no registry state).
        #     One scan is decoded at a time (see _HEAVY_WORK).
        with _HEAVY_WORK:
            ok, reason = validate_ct(ct_path)
            if not ok:
                _record_rejection(root, reason, ctx)
                return
            ok, reason, stats = segmentation_quality_ok(combined)
            if not ok:
                _record_rejection(root, reason, {**ctx, "stats": stats})
                return
            sha, ph = fingerprints(ct_path)

        # 3) Dedup + reserve id + atomic promote + commit, under the lock (short).
        with _locked(root):
            reg = _load_registry(root)
            if sha in reg["sha256"]:
                _record_rejection(root, "duplicate_exact", {**ctx, "of": reg["sha256"][sha]})
                return
            if ph in reg["phash"]:
                _record_rejection(root, "duplicate_near", {**ctx, "of": reg["phash"][ph]})
                return
            case_id = "USER_%08d" % reg["next_id"]
            metadata = {
                # No IP here: it is kept only in the short-lived abuse accounting.
                "user_id": user_id, "model": model, "session_id": session_id,
                **geometry, "quality_tier": quality_tier(geometry, stats),
                **case_summary(geometry, stats),
                "collected_at": datetime.now(timezone.utc).isoformat(),
                "sha256": sha, "phash": ph, "segmentation_stats": stats,
            }
            _promote(root, case_id, ct_path, combined,
                     existing_seg if os.path.isdir(existing_seg) else None, metadata)
            # Commit only after the files are published (atomic renames done).
            reg["next_id"] += 1
            reg["sha256"][sha] = case_id
            reg["phash"][ph] = case_id
            _save_registry(root, reg)
            print(f"[user_dataset] admitted {case_id} (model={model}, user={user_id})", flush=True)
    except Exception:
        # Never let dataset collection affect the request or crash the worker.
        print(f"[user_dataset] collection error (non-fatal):\n{traceback.format_exc()}", flush=True)


def collect_user_scan_async(ct_path: str, output_mask_dir: str, model: str,
                            user_id: Optional[str] = None, ip: Optional[str] = None,
                            session_id: Optional[str] = None) -> None:
    """Fire-and-forget entry called after a result is delivered. Returns
    immediately; the gatekeeper + promotion run on a daemon thread. No-op unless
    USER_DATASET_PATH is set."""
    if not _root():
        return
    t = threading.Thread(
        target=_admit_and_store,
        args=(ct_path, output_mask_dir, model, user_id, ip, session_id),
        name=f"user-dataset-{session_id or 'x'}", daemon=True,
    )
    t.start()
