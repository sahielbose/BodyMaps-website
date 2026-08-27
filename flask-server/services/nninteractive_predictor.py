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
calls into `interactive_segment()`, no extra locking is needed here.
Gunicorn is `--workers 1 --threads 8` (single process), so this module-level
state is correctly shared across every request thread.

Prompt sessions are KEYED BY TOKEN: each `session_token` owns its own model
server lease (volume, accumulated interactions, target buffer), so two
people prompting at once refine their own objects instead of resetting each
other's context. While a client keeps sending the same token, interactions
ACCUMULATE on its session (no reset between requests) and each new click
REFINES the same object — the model sees every prior prompt as context,
exactly how the official Slicer plugin drives it. Tokenless requests share
one anonymous slot that resets per request. Each state's `history` mirrors
its accumulated interactions so that when the model server reaps an idle
session (SessionExpiredError, its timeout counts only real actions), we can
claim a fresh lease and replay the whole exchange with predictions deferred
— the user never notices.

Capacity: the model server caps concurrent sessions (3 by default), so this
module holds at most NNINTERACTIVE_MAX_SESSIONS states (default 2, leaving
one lease for other processes) and reaps states idle beyond
NNINTERACTIVE_SESSION_IDLE_S (default 600 s, mirroring the server's own
policy). A new token arriving with every slot busy raises
PromptCapacityError rather than silently destroying someone's live session
— the third user waits a moment instead of the first two losing context.

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
import time

import numpy as np

SERVER_URL = os.environ.get("NNINTERACTIVE_SERVER_URL", "http://127.0.0.1:1527")
API_KEY = os.environ.get("NNINTERACTIVE_API_KEY") or None
# Ceiling on concurrent prompt sessions THIS process holds. The model server
# itself caps leases (3 by default); staying below that leaves room for a
# second worker or a dev process against the same server.
MAX_SESSIONS = max(1, int(os.environ.get("NNINTERACTIVE_MAX_SESSIONS", "2")))
# Local idle reap, mirroring the model server's own --idle-timeout-seconds
# default: a state nobody has prompted for this long gives its lease back so
# a new user is never refused because of an abandoned tab.
SESSION_IDLE_S = float(os.environ.get("NNINTERACTIVE_SESSION_IDLE_S", "600"))


class PromptCapacityError(RuntimeError):
    """Every prompt-session slot is occupied by a live session. Raised for a
    NEW token rather than evicting someone's accumulated context — the
    caller should tell the new user to retry shortly, not destroy an
    existing user's session."""


class _PromptState:
    """Everything one prompt session owns: its model-server lease, the volume
    it uploaded, the buffer predictions land in, and the interaction history
    used to replay after a server-side expiry."""

    __slots__ = ("token", "session", "case_key", "ct_shape", "target_buffer",
                 "history", "last_used")

    def __init__(self, token: str | None):
        self.token = token
        self.session = None
        self.case_key: str | None = None
        self.ct_shape: tuple | None = None
        self.target_buffer: np.ndarray | None = None
        self.history: list[dict] = []
        self.last_used = time.monotonic()


# token -> state; the anonymous (tokenless, one-shot) slot lives under None.
_states: dict[str | None, _PromptState] = {}


def _close_state(state: _PromptState) -> None:
    if state.session is not None:
        try:
            state.session.close()
        except Exception:
            pass
        state.session = None


def _release_on_exit() -> None:
    """Give every lease back when this process dies. The model server caps
    concurrent sessions (3 by default) and reaps idle ones only after
    --idle-timeout-seconds, so a process that exits without releasing —
    which the werkzeug dev reloader does on EVERY watched-file edit —
    strands slots for hours. Three hot-restarts in a dev session were
    enough to hit 'server is at capacity' on every request after."""
    for state in list(_states.values()):
        _close_state(state)
    _states.clear()


import atexit

atexit.register(_release_on_exit)


# /capabilities cache: the payload is static for the lifetime of a model
# server process (it describes the loaded checkpoint), so an hourly refresh
# is plenty and keeps the viewer's attribution fetch off the model server.
_caps_cache: dict | None = None
_caps_fetched_at = 0.0
CAPS_TTL_S = 3600.0


def get_capabilities() -> dict | None:
    """The model server's /capabilities payload — licence string, supported
    interactions, checkpoint version — cached for an hour. Returns the last
    good payload when the server is unreachable, or None if it never
    answered; callers fall back to their built-in text."""
    global _caps_cache, _caps_fetched_at
    now = time.monotonic()
    if _caps_cache is not None and now - _caps_fetched_at < CAPS_TTL_S:
        return _caps_cache
    try:
        import requests
        headers = {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}
        resp = requests.get(f"{SERVER_URL.rstrip('/')}/capabilities",
                            headers=headers, timeout=3)
        resp.raise_for_status()
        payload = resp.json()
        if isinstance(payload, dict):
            _caps_cache = payload
            _caps_fetched_at = now
    except Exception:
        pass
    return _caps_cache


def _new_remote_session():
    from nnInteractive.inference.remote.remote_session import nnInteractiveRemoteInferenceSession
    session = nnInteractiveRemoteInferenceSession(server_url=SERVER_URL, api_key=API_KEY)
    if not session.ping():
        raise RuntimeError(
            f"nninteractive-server not reachable at {SERVER_URL} — "
            "check it's running (scripts/demo_interactive.sh starts one "
            "locally; NNINTERACTIVE_SERVER_URL points elsewhere)."
        )
    return session


def _reap_idle(now: float) -> None:
    for key, state in list(_states.items()):
        if now - state.last_used > SESSION_IDLE_S:
            _close_state(state)
            _states.pop(key, None)


def _acquire_state(token: str | None) -> _PromptState:
    """The state for `token`, creating one if a slot is free. Never evicts a
    live session for a new token — see PromptCapacityError."""
    now = time.monotonic()
    _reap_idle(now)
    state = _states.get(token)
    if state is None:
        if len(_states) >= MAX_SESSIONS:
            raise PromptCapacityError(
                f"All {MAX_SESSIONS} interactive annotation slots are in use "
                "right now. Try again in a moment.")
        state = _PromptState(token)
        _states[token] = state
    state.last_used = now
    return state


def _ensure_volume_loaded(state: _PromptState, ct: np.ndarray, case_key: str) -> None:
    if state.session is None:
        state.session = _new_remote_session()
    if state.case_key == case_key and state.ct_shape == ct.shape:
        return
    state.session.set_image(ct[None])
    state.target_buffer = np.zeros(ct.shape, dtype=np.uint8)
    state.session.set_target_buffer(state.target_buffer)
    state.case_key = case_key
    state.ct_shape = ct.shape


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
    """True when `session_token` names a live accumulated prompt session —
    i.e. the mask the caller just received is session-scoped (refines one
    object across requests), not a one-shot proposal. False after any
    failure that fell back to region_grow, since a state's `history` only
    records interactions the model actually accepted."""
    token = _normalize_token(session_token)
    if token is None:
        return False
    state = _states.get(token)
    return state is not None and len(state.history) > 0


def _add_interaction(session, entry: dict, ct_shape: tuple, run_prediction: bool = True) -> None:
    if entry["kind"] == "point":
        session.add_point_interaction(
            entry["coords"],
            include_interaction=entry["include"],
            run_prediction=run_prediction,
        )
    elif entry["kind"] == "initial_seg":
        # Always prediction-deferred: the seed is context for the prompt that
        # follows in the same request, never a prediction of its own. The
        # remote client also mirrors the seed into the state's target_buffer
        # in-place (buffer[:] = seg), so the module-level ref stays valid.
        session.add_initial_seg_interaction(entry["seg"], run_prediction=False)
    elif entry["kind"] in ("scribble", "lasso"):
        # Rasterized from the stored points at send time (not stored as a
        # volume) so replay-after-expiry re-rasterizes instead of holding a
        # 30MB+ mask per stroke in the history.
        stroke = _rasterize_stroke(
            entry["points"], ct_shape, closed=(entry["kind"] == "lasso")
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


def _rebuild_and_replay(state: _PromptState, ct: np.ndarray, case_key: str):
    """Claim a fresh model-server lease after this state's expired: re-upload
    the volume, replay the state's interaction history with predictions
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
    latest = None if state.target_buffer is None else state.target_buffer.copy()
    _close_state(state)
    state.case_key = None
    state.ct_shape = None
    if state.history:
        if latest is not None and latest.shape == ct.shape and latest.any():
            head = {"kind": "initial_seg", "seg": latest}
            if state.history[0]["kind"] == "initial_seg":
                state.history[0] = head
            else:
                state.history.insert(0, head)
        elif state.history[0]["kind"] == "initial_seg":
            # The session's true latest state is empty (or unknown); a stale
            # seed would resurrect voxels the model already gave back.
            state.history.pop(0)
    _ensure_volume_loaded(state, ct, case_key)
    for past in state.history:
        _add_interaction(state.session, past, state.ct_shape, run_prediction=False)
    return state.session


def undo_last(session_token) -> int:
    """Rewind the live prompt session by ONE interaction, on the model server
    and in the state's history, so a client-side ctrl+z keeps the model's context in
    lockstep with the labelmap voxels it just restored. Returns how many
    prompts the session still holds.

    The model server keeps a single undo snapshot per session (its --help
    documents undo as single-level), so only the newest interaction can be
    rewound; a second consecutive undo raises. Callers treat any raise as
    "end the session client-side" — the next prompt then re-seeds from the
    restored labelmap, which is this integration's normal recovery path, so
    deeper undos degrade gracefully instead of desyncing."""
    from nnInteractive.inference.remote.remote_session import SessionExpiredError

    token = _normalize_token(session_token)
    state = _states.get(token) if token is not None else None
    if state is None or state.session is None:
        raise ValueError("That prompt session is no longer active.")
    state.last_used = time.monotonic()
    if not any(e["kind"] != "initial_seg" for e in state.history):
        raise ValueError("Nothing to undo in this prompt session.")
    if not getattr(state.session, "supports_undo", False):
        raise ValueError("The model server was started without undo support.")
    try:
        undone = state.session.undo()
    except SessionExpiredError:
        # The lease died under us; there is no server state left to rewind.
        # Drop the state so a stray reuse of this token can't replay a
        # history the client no longer believes in.
        _close_state(state)
        _states.pop(token, None)
        raise ValueError("The prompt session expired on the model server.")
    if not undone:
        # Single-level undo exhausted. The history is untouched — the server
        # didn't pop anything.
        raise ValueError("The model server can only undo the newest prompt.")
    # Interactions append [seed?, p1, ..., pN]; with any prompt present the
    # newest entry is always a prompt, never the seed.
    state.history.pop()
    return sum(1 for e in state.history if e["kind"] != "initial_seg")


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
) -> tuple[np.ndarray, list | None]:
    """Returns (mask, changed_bbox). changed_bbox is the [[i0,i1],[j0,j1],
    [k0,k1]] region (upper-exclusive, clipped) the prediction actually wrote,
    mirrored from the model server, or None when unknown — callers can diff
    just that slab against the previous response instead of the whole volume.

    `initial_seg` (uint8, ct.shape) seeds a FRESH session with an existing
    mask before the first prompt — nnInteractive's "continue from existing
    segmentation" mode, which is how a shipped organ label becomes refinable
    instead of the first click starting an empty object. Its presence also
    MARKS the request as a fresh start: the client only ever sends a seed on
    a session's first prompt, so an existing state for the same token resets
    rather than accumulating onto the old object.

    Raises PromptCapacityError when a NEW token arrives while every slot
    holds someone's live session — deliberately, instead of evicting an
    active user's context."""
    from nnInteractive.inference.remote.remote_session import SessionExpiredError

    token = _normalize_token(session_token)
    state = _acquire_state(token)
    volume_changed = not (state.case_key == case_key and state.ct_shape == ct.shape)
    if volume_changed:
        # A different volume on this state's session invalidates whatever
        # prompt context it had accumulated.
        state.history = []
    try:
        _ensure_volume_loaded(state, ct, case_key)
    except SessionExpiredError:
        # The lease died between requests and the very first server call of
        # this one (the volume upload) tripped over it. History was just
        # cleared, so this "replay" is simply a clean rebuild.
        _rebuild_and_replay(state, ct, case_key)
    session = state.session

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

    # Fresh = this request does not continue an accumulated exchange: the
    # anonymous slot always is, a seed marks a client-side restart, and an
    # empty history has nothing to continue.
    starting_fresh = token is None or initial_seg is not None or not state.history
    if starting_fresh:
        state.history = []

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
            _add_interaction(session, pending, state.ct_shape)
    except SessionExpiredError:
        session = _rebuild_and_replay(state, ct, case_key)
        for pending in new_entries:
            _add_interaction(session, pending, state.ct_shape)

    if token is not None:
        state.history.extend(new_entries)

    bbox = getattr(session, "_last_paste_bbox", None)
    if bbox is not None:
        bbox = [[int(lo), int(hi)] for lo, hi in bbox]
    return state.target_buffer.copy(), bbox