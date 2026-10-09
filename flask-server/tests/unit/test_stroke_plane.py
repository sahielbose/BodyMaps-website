"""A perfectly straight stroke on one voxel row or column ties its voxel
spread between two axes, so the slice axis cannot be read from the points.
The client sends the pane it drew on; the server maps it to a volume axis
through the CT affine, rasterizes on that axis, and keeps it in the history
entry so a replay after the session expired draws the same stroke."""
import numpy as np
import pytest

import nnInteractive.inference.remote.remote_session as remote_mod
import services.nninteractive_predictor as predictor
from services import advanced_analysis

SHAPE = (40, 50, 30)


def lps(ijk):
    # RAS = diag(-1, -1, 1) @ LPS, and the test affine is the identity, so
    # the LPS point of voxel (i, j, k) is (-i, -j, k).
    return [-ijk[0], -ijk[1], ijk[2]]


class Remote:
    def __init__(self, *args, **kwargs):
        self.calls = []
        self.supports_undo = True
        self.preferred_scribble_thickness = [2, 2, 2]
        self._last_paste_bbox = None

    def ping(self):
        return True

    def set_image(self, img):
        pass

    def set_target_buffer(self, buf):
        self.buffer = buf

    def reset_interactions(self):
        pass

    def add_scribble_interaction(self, image, include_interaction, run_prediction=True, interaction_bbox=None):
        self.calls.append(("scribble", interaction_bbox))

    def add_lasso_interaction(self, image, include_interaction, run_prediction=True, interaction_bbox=None):
        self.calls.append(("lasso", interaction_bbox))

    def close(self):
        pass


@pytest.fixture
def remote(monkeypatch):
    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", Remote)
    predictor._states.clear()
    yield
    predictor._states.clear()


# Strokes whose spread ties: horizontal and vertical swipes on one axial slice.
HORIZONTAL = [[5, 20, 12], [15, 20, 12], [30, 20, 12]]
VERTICAL = [[20, 5, 12], [20, 15, 12], [20, 40, 12]]


@pytest.mark.parametrize("points", [HORIZONTAL, VERTICAL], ids=["horizontal", "vertical"])
def test_a_straight_axial_stroke_is_drawn_on_its_own_slice_when_the_axis_is_given(points):
    crop, bbox = predictor._rasterize_stroke(points, SHAPE, closed=False, axis=2)
    assert bbox[2] == [12, 13]
    assert crop.shape[2] == 1


def test_without_an_axis_the_guess_from_the_stroke_is_kept():
    crop, bbox = predictor._rasterize_stroke(HORIZONTAL, SHAPE, closed=False)
    # The old tie-break: first minimum, which is the wrong plane for this stroke.
    assert bbox[1] == [20, 21]
    # A stroke with a clear plane still resolves without help.
    crop, bbox = predictor._rasterize_stroke([[3, 3, 7], [20, 30, 7], [11, 25, 7]], SHAPE, closed=False)
    assert bbox[2] == [7, 8]


def test_the_pane_maps_to_the_volume_axis_through_the_affine():
    ident = np.eye(4)
    assert advanced_analysis._plane_to_axis(ident, "sagittal") == 0
    assert advanced_analysis._plane_to_axis(ident, "coronal") == 1
    assert advanced_analysis._plane_to_axis(ident, "axial") == 2
    # A volume stored with k running left-right and i running bottom-top.
    permuted = np.array([[0, 0, 2, 0], [0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 0, 1.0]])
    assert advanced_analysis._plane_to_axis(permuted, "sagittal") == 2
    assert advanced_analysis._plane_to_axis(permuted, "axial") == 0
    assert advanced_analysis._plane_to_axis(ident, None) is None
    assert advanced_analysis._plane_to_axis(ident, "oblique") is None


@pytest.mark.parametrize("points", [HORIZONTAL, VERTICAL], ids=["horizontal", "vertical"])
def test_a_straight_axial_scribble_reaches_the_model_on_its_slice(remote, points):
    ct = np.zeros(SHAPE, dtype=np.float32)
    advanced_analysis.segment_from_prompt(
        ct, np.eye(4),
        {"point_lps": lps(points[0]), "scribble_lps": [lps(p) for p in points],
         "plane": "axial", "session_token": "s"},
        case_key="1:full",
    )
    (kind, bbox), = predictor._states["s"].session.calls
    assert kind == "scribble"
    assert bbox[2] == [12, 13]


def test_the_plane_is_kept_in_the_history_so_a_replay_draws_the_same_stroke(remote):
    ct = np.zeros(SHAPE, dtype=np.float32)
    advanced_analysis.segment_from_prompt(
        ct, np.eye(4),
        {"point_lps": lps(HORIZONTAL[0]), "lasso_lps": [lps(p) for p in HORIZONTAL],
         "plane": "axial", "session_token": "s"},
        case_key="1:full",
    )
    state = predictor._states["s"]
    assert state.history[-1]["axis"] == 2
    # The model server forgot the session: rebuild and replay from history.
    predictor._rebuild_and_replay(state, ct, "1:full")
    replayed = [c for c in state.session.calls if c[0] == "lasso"]
    assert replayed and replayed[-1][1][2] == [12, 13]
