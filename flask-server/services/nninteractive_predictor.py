"""
flask-server/services/nninteractive_predictor.py

Talks to the standalone `nninteractive-server` process on bdmap1
(127.0.0.1:1527, model + GPU loaded once at server startup) via
nnInteractiveRemoteInferenceSession.

CONFIRMED end-to-end on bdmap1 against PanTS_00000001 (2026-08-15):
  - add_point_interaction(coords, include_interaction=True)
      coords = [i, j, k]  -> works, produced 142284 voxels on a test seed.
  - add_bbox_interaction(bbox, include_interaction=True)
      bbox = [[x_lo, x_hi], [y_lo, y_hi], [z_lo, z_hi]]  (per-axis pairs,
      NOT two corner points). Exactly one axis must have size == 1 (a 2D
      box on a single slice) -- size == 0 raises ValueError, and all three
      axes > 1 raises "3D bounding box... not supported by the loaded
      model checkpoint" (this checkpoint is 2D-box-only). Produced 16227
      voxels on a 30x30 test box.

Every box prompt is flattened to zero thickness on whichever axis has the
smallest extent -- see _corners_to_axis_pairs(). This matches a box drawn
on one 2D viewport pane, but has NOT yet been verified against a real
frontend box-drag; verify this once wired up.

Since api_blueprint.py's `_ANALYSIS_SLOTS` semaphore already serializes all
calls into `interactive_segment()`, one shared session with no extra locking
here is safe. Gunicorn is `--workers 1 --threads 8` (single process), so this
module-level cache is correctly shared across every request thread.

Prompt sessions: while the client keeps sending the same `session_token`,
interactions ACCUMULATE on the model server (no reset between requests), so
each new click REFINES the same object — the model sees every prior prompt
as context, exactly how the official Slicer plugin drives it. A different
token (or none) resets. `_history` mirrors the accumulated interactions so
that when the model server reaps our idle session (SessionExpiredError, its
timeout counts only real actions), we can claim a fresh one and replay the
whole exchange with predictions deferred — the user never notices.

Apple Silicon note: launch the model server with PYTORCH_ENABLE_MPS_FALLBACK=1.
nnInteractive's autozoom path calls interpolate(mode="area") ->
aten::_adaptive_avg_pool3d, which MPS does not implement — without the
fallback, any prompt on a structure big enough to trigger zoom-out (liver,
lungs) 500s inside the model server while small-structure prompts work,
which looks maddeningly nondeterministic from out here:
  PYTORCH_ENABLE_MPS_FALLBACK=1 nninteractive-server --device mps --no-torch-compile
CUDA deployments (bdmap1) need neither flag.

The server's DEFAULT timeouts are correct for this integration — do not raise
them. The remote client auto-heartbeats (a daemon thread at half the liveness
timeout), so live Flask processes never get liveness-reaped, while a killed or
hot-restarted Flask stops heartbeating and the server reclaims its slot within
the 60s default — raising the timeouts is what turned dev-reloader restarts
into hours-long "server is at capacity" lockups. Idle expiry (600s default,
counts only real interactions) is recovered transparently by
_rebuild_and_replay below.

Configuration (env vars, both optional):
  NNINTERACTIVE_SERVER_URL  where nninteractive-server listens
                            (default http://127.0.0.1:1527 — a local server
                            or an SSH tunnel to bdmap1's).
  NNINTERACTIVE_API_KEY     bearer token, required only when the server was
                            started with --api-key. The client also honors
                            its own NN_INTERACTIVE_API_KEY; setting either
                            works, this one wins.
"""
from __future__ import annotations

import os

import numpy as np

SERVER_URL = os.environ.get("NNINTERACTIVE_SERVER_URL", "http://127.0.0.1:1527")
API_KEY = os.environ.get("NNINTERACTIVE_API_KEY") or None

_session = None
_cached_case_key: str | None = None
_cached_ct_shape: tuple | None = None
_target_buffer: np.ndarray | None = None

# One live prompt session at a time (single worker, one user working one
# case — same reasoning as the single-slot volume cache above).
_active_token: str | None = None
_history: list[dict] = []


def _release_on_exit() -> None:
    """Give the lease back when this process dies. The model server caps
    concurrent sessions (3 by default) and reaps idle ones only after
    --idle-timeout-seconds, so a process that exits without releasing —
    which the werkzeug dev reloader does on EVERY watched-file edit —
    strands a slot for hours. Three hot-restarts in a dev session were
    enough to hit 'server is at capacity' on every request after."""
    global _session
    if _session is not None:
        try:
            _session.close()
        except Exception:
            pass
        _session = None


import atexit

atexit.register(_release_on_exit)


def _get_session():
    global _session
    if _session is None:
        from nnInteractive.inference.remote.remote_session import nnInteractiveRemoteInferenceSession
        _session = nnInteractiveRemoteInferenceSession(server_url=SERVER_URL, api_key=API_KEY)
        if not _session.ping():
            raise RuntimeError(
                f"nninteractive-server not reachable at {SERVER_URL} — "
                "check it's running (scripts/demo_interactive.sh starts one "
                "locally; NNINTERACTIVE_SERVER_URL points elsewhere)."
            )
    return _session


def _ensure_volume_loaded(ct: np.ndarray, case_key: str) -> None:
    global _cached_case_key, _cached_ct_shape, _target_buffer
    session = _get_session()
    if _cached_case_key == case_key and _cached_ct_shape == ct.shape:
        return
    session.set_image(ct[None])
    _target_buffer = np.zeros(ct.shape, dtype=np.uint8)
    session.set_target_buffer(_target_buffer)
    _cached_case_key = case_key
    _cached_ct_shape = ct.shape


def _corners_to_axis_pairs(lo, hi) -> list[list[int]]:
    lo, hi = list(lo), list(hi)
    extents = [hi[d] - lo[d] for d in range(3)]
    flatten_axis = min(range(3), key=lambda d: extents[d])
    pairs = []
    for d in range(3):
        if d == flatten_axis:
            start = lo[d]
            pairs.append([start, start + 1])
        else:
            end = hi[d] if hi[d] > lo[d] else lo[d] + 1
            pairs.append([lo[d], end])
    return pairs


def _rasterize_stroke(points, shape: tuple, closed: bool) -> np.ndarray:
    """Full-volume uint8 mask of a stroke drawn on ONE viewport slice.

    `points` are [i, j, k] voxel coords that all lie (up to rounding) on a
    single plane — the pane the user drew on. The plane's axis is whichever
    coordinate varies least across the stroke, matching how the box prompt
    flattens (_corners_to_axis_pairs). Open strokes rasterize as a 3px-wide
    polyline (the scribble gesture); closed ones as a filled polygon (lasso).
    The model server wants these as full-volume binary masks — that's the
    wire format add_scribble_interaction/add_lasso_interaction take.
    """
    from PIL import Image, ImageDraw

    pts = np.asarray(points, dtype=float)
    spread = pts.max(axis=0) - pts.min(axis=0)
    axis = int(np.argmin(spread))
    slice_idx = int(round(pts[:, axis].mean()))
    slice_idx = max(0, min(shape[axis] - 1, slice_idx))
    other = [d for d in range(3) if d != axis]

    # PIL canvases are (width, height) with xy=(x, y); map width to the first
    # remaining volume axis so the later transpose lands as [other0, other1] —
    # exactly the shape vol[fixed-axis slice] indexes as. Out-of-bounds stroke
    # coords just clip at the canvas edge, which is the behavior we want.
    img = Image.new("L", (shape[other[0]], shape[other[1]]), 0)
    draw = ImageDraw.Draw(img)
    xy = [(float(p[other[0]]), float(p[other[1]])) for p in points]
    if closed:
        draw.polygon(xy, fill=1, outline=1)
    else:
        draw.line(xy, fill=1, width=3, joint="curve")
    plane = np.array(img, dtype=np.uint8).T

    vol = np.zeros(shape, dtype=np.uint8)
    index = [slice(None)] * 3
    index[axis] = slice_idx
    vol[tuple(index)] = plane
    return vol


def _normalize_token(session_token) -> str | None:
    if not session_token:
        return None
    return str(session_token)[:64]


def session_is_active(session_token) -> bool:
    """True when `session_token` names the live accumulated prompt session —
    i.e. the mask the caller just received is session-scoped (refines one
    object across requests), not a one-shot proposal. False after any
    failure that fell back to region_grow, since `_history` only records
    interactions the model actually accepted."""
    token = _normalize_token(session_token)
    return token is not None and token == _active_token and len(_history) > 0


def _add_interaction(session, entry: dict, run_prediction: bool = True) -> None:
    if entry["kind"] == "point":
        session.add_point_interaction(
            entry["coords"],
            include_interaction=entry["include"],
            run_prediction=run_prediction,
        )
    elif entry["kind"] == "initial_seg":
        # Always prediction-deferred: the seed is context for the prompt that
        # follows in the same request, never a prediction of its own. The
        # remote client also mirrors the seed into our _target_buffer
        # in-place (buffer[:] = seg), so the module-level ref stays valid.
        session.add_initial_seg_interaction(entry["seg"], run_prediction=False)
    elif entry["kind"] in ("scribble", "lasso"):
        # Rasterized from the stored points at send time (not stored as a
        # volume) so replay-after-expiry re-rasterizes instead of holding a
        # 30MB+ mask per stroke in _history.
        stroke = _rasterize_stroke(
            entry["points"], _cached_ct_shape, closed=(entry["kind"] == "lasso")
        )
        method = (
            session.add_lasso_interaction
            if entry["kind"] == "lasso"
            else session.add_scribble_interaction
        )
        method(
            stroke,
            include_interaction=entry["include"],
            run_prediction=run_prediction,
        )
    else:
        session.add_bbox_interaction(
            entry["axis_pairs"],
            include_interaction=entry["include"],
            run_prediction=run_prediction,
        )


def _rebuild_and_replay(ct: np.ndarray, case_key: str):
    """Claim a fresh model-server session after ours expired: re-upload the
    volume, replay the accumulated interaction history with predictions
    deferred (cheap — the model runs once, on the next real prompt), and
    hand back the new session. Replaying in one batch instead of
    click-by-click can differ marginally from the original interactive
    sequence (autozoom state evolves per prediction), which is acceptable
    for a recovery path.

    The history's initial_seg head is refreshed to (or, for sessions that
    started without a seed, created from) the pre-expiry target buffer.
    Replayed prompts don't run predictions, so without this the rebuilt
    buffer would hold only the seed as of session start — or nothing — while
    the client's retraction baseline is the LATEST response; the next apply
    would then "retract" every voxel the model grew since, visibly eating
    the object. Seeding with the last known buffer makes the rebuilt state
    exactly what the client believes it is."""
    global _session, _cached_case_key, _cached_ct_shape
    latest = None if _target_buffer is None else _target_buffer.copy()
    old = _session
    _session = None
    _cached_case_key = None
    _cached_ct_shape = None
    if old is not None:
        try:
            old.close()
        except Exception:
            pass
    if _history:
        if latest is not None and latest.shape == ct.shape and latest.any():
            head = {"kind": "initial_seg", "seg": latest}
            if _history[0]["kind"] == "initial_seg":
                _history[0] = head
            else:
                _history.insert(0, head)
        elif _history[0]["kind"] == "initial_seg":
            # The session's true latest state is empty (or unknown); a stale
            # seed would resurrect voxels the model already gave back.
            _history.pop(0)
    session = _get_session()
    _ensure_volume_loaded(ct, case_key)
    for past in _history:
        _add_interaction(session, past, run_prediction=False)
    return session


def predict(
    ct: np.ndarray,
    case_key: str,
    point_ijk=None,
    box_ijk=None,
    scribble_ijk=None,
    lasso_ijk=None,
    session_token=None,
    include: bool = True,
    initial_seg: np.ndarray | None = None,
) -> np.ndarray:
    """`initial_seg` (uint8, ct.shape) seeds a FRESH session with an existing
    mask before the first prompt — nnInteractive's "continue from existing
    segmentation" mode, which is how a shipped organ label becomes refinable
    instead of the first click starting an empty object. Ignored unless this
    request starts a fresh session (mid-session requests already carry their
    context in the accumulated interactions)."""
    global _active_token, _history
    from nnInteractive.inference.remote.remote_session import SessionExpiredError

    session = _get_session()
    volume_changed = not (_cached_case_key == case_key and _cached_ct_shape == ct.shape)
    if volume_changed:
        # New volume on the model server invalidates any accumulated
        # prompt context regardless of what token the client sends.
        _active_token = None
        _history = []
    try:
        _ensure_volume_loaded(ct, case_key)
    except SessionExpiredError:
        # Our lease died between requests and the very first server call of
        # this one (the volume upload) tripped over it. History was just
        # cleared, so this "replay" is simply a clean rebuild.
        session = _rebuild_and_replay(ct, case_key)

    if scribble_ijk is not None:
        entry = {
            "kind": "scribble",
            "points": [[int(v) for v in p] for p in scribble_ijk],
            "include": bool(include),
        }
    elif lasso_ijk is not None:
        entry = {
            "kind": "lasso",
            "points": [[int(v) for v in p] for p in lasso_ijk],
            "include": bool(include),
        }
    elif box_ijk is not None:
        lo, hi = box_ijk
        entry = {"kind": "bbox", "axis_pairs": _corners_to_axis_pairs(lo, hi), "include": bool(include)}
    elif point_ijk is not None:
        entry = {"kind": "point", "coords": [int(v) for v in point_ijk], "include": bool(include)}
    else:
        raise ValueError("predict() needs point_ijk, box_ijk, scribble_ijk, or lasso_ijk")

    token = _normalize_token(session_token)
    starting_fresh = token is None or token != _active_token
    if starting_fresh:
        _active_token = token
        _history = []

    new_entries = []
    if starting_fresh and initial_seg is not None:
        # np.frombuffer views are read-only and F-strided after the reshape
        # upstream; blosc2 packing wants a plain contiguous buffer.
        new_entries.append({"kind": "initial_seg", "seg": np.ascontiguousarray(initial_seg)})
    new_entries.append(entry)

    try:
        if starting_fresh:
            session.reset_interactions()
        for pending in new_entries:
            _add_interaction(session, pending)
    except SessionExpiredError:
        session = _rebuild_and_replay(ct, case_key)
        for pending in new_entries:
            _add_interaction(session, pending)

    if token is not None:
        _history.extend(new_entries)

    return _target_buffer.copy()