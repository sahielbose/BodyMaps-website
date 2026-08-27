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
which looks maddeningly nondeterministic from out here. Also raise
--liveness-timeout-seconds (this integration sends no heartbeats), e.g.:
  PYTORCH_ENABLE_MPS_FALLBACK=1 nninteractive-server --device mps \
    --no-torch-compile --idle-timeout-seconds 7200 --liveness-timeout-seconds 7200
CUDA deployments (bdmap1) need neither flag.
"""
from __future__ import annotations

import numpy as np

SERVER_URL = "http://127.0.0.1:1527"

_session = None
_cached_case_key: str | None = None
_cached_ct_shape: tuple | None = None
_target_buffer: np.ndarray | None = None

# One live prompt session at a time (single worker, one user working one
# case — same reasoning as the single-slot volume cache above).
_active_token: str | None = None
_history: list[dict] = []


def _get_session():
    global _session
    if _session is None:
        from nnInteractive.inference.remote.remote_session import nnInteractiveRemoteInferenceSession
        _session = nnInteractiveRemoteInferenceSession(server_url=SERVER_URL)
        if not _session.ping():
            raise RuntimeError(
                f"nninteractive-server not reachable at {SERVER_URL} — "
                "check it's running (tmux session 'nninteractive' on bdmap1)."
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
    for a recovery path."""
    global _session, _cached_case_key, _cached_ct_shape
    old = _session
    _session = None
    _cached_case_key = None
    _cached_ct_shape = None
    if old is not None:
        try:
            old.close()
        except Exception:
            pass
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
    session_token=None,
    include: bool = True,
) -> np.ndarray:
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

    if point_ijk is not None:
        entry = {"kind": "point", "coords": [int(v) for v in point_ijk], "include": bool(include)}
    elif box_ijk is not None:
        lo, hi = box_ijk
        entry = {"kind": "bbox", "axis_pairs": _corners_to_axis_pairs(lo, hi), "include": bool(include)}
    else:
        raise ValueError("predict() needs point_ijk or box_ijk")

    token = _normalize_token(session_token)
    starting_fresh = token is None or token != _active_token
    if starting_fresh:
        _active_token = token
        _history = []

    try:
        if starting_fresh:
            session.reset_interactions()
        _add_interaction(session, entry)
    except SessionExpiredError:
        session = _rebuild_and_replay(ct, case_key)
        _add_interaction(session, entry)

    if token is not None:
        _history.append(entry)

    return _target_buffer.copy()