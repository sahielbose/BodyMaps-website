"""Scribble and lasso prompts go to the model server in nnInteractive v2's
compact form: the stroke's tight box on its slice (interaction_bbox) and the
mask of just that box, instead of a full-volume mask per stroke. Pasting the
crop back at its box must reproduce the full-volume stroke exactly, on every
slice orientation, and the prompt must reach the model with its box."""
import numpy as np
import pytest
from PIL import Image, ImageDraw

import nnInteractive.inference.remote.remote_session as remote_mod
import services.nninteractive_predictor as predictor

SHAPE = (40, 50, 30)


def full_volume_stroke(points, shape, closed, width=3):
    """The previous wire format, rebuilt independently as the reference."""
    pts = np.asarray(points, dtype=float)
    axis = int(np.argmin(pts.max(axis=0) - pts.min(axis=0)))
    idx = max(0, min(shape[axis] - 1, int(round(pts[:, axis].mean()))))
    other = [d for d in range(3) if d != axis]
    img = Image.new("L", (shape[other[0]], shape[other[1]]), 0)
    draw = ImageDraw.Draw(img)
    xy = [(float(p[other[0]]), float(p[other[1]])) for p in points]
    if closed:
        draw.polygon(xy, fill=1, outline=1)
    else:
        draw.line(xy, fill=1, width=width, joint="curve")
    vol = np.zeros(shape, dtype=np.uint8)
    sl = [slice(None)] * 3
    sl[axis] = idx
    vol[tuple(sl)] = np.array(img, dtype=np.uint8).T
    return vol


def paste(crop, bbox, shape):
    vol = np.zeros(shape, dtype=np.uint8)
    vol[tuple(slice(lo, hi) for lo, hi in bbox)] = crop
    return vol


STROKES = {
    # One stroke per slice orientation: k fixed (axial), j fixed, i fixed.
    "axial": [[5, 6, 12], [20, 30, 12], [33, 9, 12], [12, 40, 12]],
    "coronal": [[4, 25, 3], [30, 25, 20], [18, 25, 27], [6, 25, 18]],
    "sagittal": [[17, 3, 2], [17, 44, 11], [17, 22, 28], [17, 8, 25]],
}


@pytest.mark.parametrize("closed", [False, True], ids=["scribble", "lasso"])
@pytest.mark.parametrize("name", list(STROKES))
def test_the_crop_at_its_box_is_exactly_the_full_volume_stroke(name, closed):
    points = STROKES[name]
    crop, bbox = predictor._rasterize_stroke(points, SHAPE, closed=closed)

    assert crop.dtype == np.uint8
    assert list(crop.shape) == [hi - lo for lo, hi in bbox]
    assert sorted(hi - lo for lo, hi in bbox)[0] == 1  # one voxel thick
    assert crop.any(axis=tuple(d for d in range(3) if crop.shape[d] == 1)).any()
    np.testing.assert_array_equal(
        paste(crop, bbox, SHAPE), full_volume_stroke(points, SHAPE, closed)
    )
    # Tight: the box has no empty border rows or columns.
    for d in range(3):
        if crop.shape[d] > 1:
            other = tuple(x for x in range(3) if x != d)
            filled = crop.any(axis=other)
            assert filled[0] and filled[-1]


@pytest.mark.parametrize("name", list(STROKES))
def test_scribbles_are_drawn_at_the_checkpoints_preferred_thickness(name):
    # nnInteractive_v1.0 reports [2, 2, 2]: the width its training scribbles
    # were drawn at. The old fixed 3 px stays only for servers that don't say.
    points = STROKES[name]
    crop, bbox = predictor._rasterize_stroke(points, SHAPE, closed=False, thickness=[2, 2, 2])
    np.testing.assert_array_equal(
        paste(crop, bbox, SHAPE), full_volume_stroke(points, SHAPE, False, width=2)
    )


def test_the_width_comes_from_the_two_in_plane_axes():
    # An axial stroke (k fixed) lies in the i-j plane, so k's value is ignored.
    assert predictor._scribble_width([2, 2, 9], axis=2) == 2
    assert predictor._scribble_width([4, 2, 9], axis=2) == 4
    assert predictor._scribble_width([9, 2, 2], axis=0) == 2
    for unreadable in (None, [], "x", [0, 0, 0], [None, 2, 2]):
        assert predictor._scribble_width(unreadable, axis=2) == predictor.DEFAULT_SCRIBBLE_WIDTH


def test_a_stroke_entirely_off_the_image_is_refused():
    with pytest.raises(ValueError):
        predictor._rasterize_stroke([[-40, -40, 5], [-30, -45, 5]], SHAPE, closed=False)


class StrokeRemote:
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
        self.calls.append(("scribble", image.shape, interaction_bbox, include_interaction))
        self.scribble = paste(image, interaction_bbox, SHAPE)

    def add_lasso_interaction(self, image, include_interaction, run_prediction=True, interaction_bbox=None):
        self.calls.append(("lasso", image.shape, interaction_bbox, include_interaction))

    def close(self):
        pass


def test_strokes_reach_the_model_with_their_box(monkeypatch):
    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", StrokeRemote)
    predictor._states.clear()
    ct = np.zeros(SHAPE, dtype=np.float32)
    try:
        predictor.predict(ct, "1:full", scribble_ijk=STROKES["axial"], session_token="s")
        predictor.predict(ct, "1:full", lasso_ijk=STROKES["sagittal"], session_token="s", include=False)
        remote = predictor._states["s"].session
        (kind1, shape1, box1, inc1), (kind2, shape2, box2, inc2) = remote.calls
        assert (kind1, inc1) == ("scribble", True) and (kind2, inc2) == ("lasso", False)
        assert list(shape1) == [hi - lo for lo, hi in box1] and box1[2] == [12, 13]
        assert list(shape2) == [hi - lo for lo, hi in box2] and box2[0] == [17, 18]
        # The scribble reached the model at the session's preferred thickness.
        np.testing.assert_array_equal(
            remote.scribble, full_volume_stroke(STROKES["axial"], SHAPE, False, width=2)
        )
    finally:
        for state in list(predictor._states.values()):
            state.session = None
        predictor._states.clear()
