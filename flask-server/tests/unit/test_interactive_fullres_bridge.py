"""res="low" prompts must run inference at full resolution when possible.

Prompting the half-size volume costs a measured 0.05-0.09 Dice against the
same click at full resolution, and the loss is pure scale: nothing about the
viewer's grid forces the MODEL to see the low-res CT. The endpoint therefore
bridges: inference on the full-res volume, and only the returned mask (plus
the changed-bbox and any incoming seed/voxel coordinates) is translated
between the two grids. The response stays on the viewer's grid, so the
client needs no changes. These tests pin every side of that translation.
"""
import gzip
import base64

import numpy as np
import nibabel as nib
from flask import Flask
from scipy.ndimage import zoom

import api.api_blueprint as api_routes
from constants import Constants
from services import advanced_analysis
from services import nninteractive_predictor


CASE_NUM = "35"
CASE_DIR = "PanTS_00000035"

FULL_SHAPE = (8, 8, 8)
LOW_SHAPE = (4, 4, 4)


def _write_grids(tmp_path, monkeypatch, with_lowres=True):
    """A tiny but real dataset: full-res CT under PANTS_PATH and, unless told
    otherwise, the low-res copy built exactly the way make_lowres.py builds it
    (ndimage.zoom + affine scaled by the factor)."""
    pants = tmp_path / "pants"
    lowres = tmp_path / "pants_lowres"

    full_aff = np.diag([1.0, 1.0, 1.0, 1.0])
    ct = np.arange(np.prod(FULL_SHAPE), dtype=np.int16).reshape(FULL_SHAPE)
    full_ct = pants / "image_only" / CASE_DIR / Constants.MAIN_NIFTI_FILENAME
    full_ct.parent.mkdir(parents=True)
    nib.save(nib.Nifti1Image(ct, full_aff), str(full_ct))

    if with_lowres:
        low = zoom(ct, 0.5, order=1).astype(np.int16)
        assert low.shape == LOW_SHAPE
        low_aff = full_aff.copy()
        low_aff[:3, :3] *= 2
        low_ct = lowres / "image_only" / CASE_DIR / "ct_lowres.nii.gz"
        low_ct.parent.mkdir(parents=True)
        nib.save(nib.Nifti1Image(low, low_aff), str(low_ct))

    monkeypatch.setattr(Constants, "PANTS_PATH", str(pants))
    monkeypatch.setattr(api_routes, "LOWRES_ROOT", str(lowres))
    # The single-slot CT cache must not leak a grid across tests.
    monkeypatch.setattr(api_routes, "_ct_cache_key", None)
    monkeypatch.setattr(api_routes, "_ct_cache_obj", None)
    monkeypatch.setattr(api_routes, "_ct_cache_array", None)
    monkeypatch.setattr(nninteractive_predictor, "session_is_active", lambda t: False)


def _stub_model(monkeypatch, mask, bbox=None):
    """Replace segment_from_prompt, recording exactly what inference saw."""
    seen = {}

    def fake(ct, affine, prompt, case_key=None):
        seen["shape"] = tuple(ct.shape)
        seen["affine"] = affine.copy()
        seen["prompt"] = dict(prompt)
        seen["case_key"] = case_key
        return mask, bbox

    monkeypatch.setattr(advanced_analysis, "segment_from_prompt", fake)
    return seen


def _post(body):
    app = Flask(__name__)
    with app.test_request_context(json=body, method="POST"):
        return api_routes.interactive_segment(CASE_NUM)


def _decode_mask(resp):
    img = nib.Nifti1Image.from_bytes(gzip.decompress(resp.data))
    return np.asanyarray(img.dataobj), img.affine


def test_low_res_request_infers_full_and_answers_on_the_viewer_grid(tmp_path, monkeypatch):
    _write_grids(tmp_path, monkeypatch)
    # An axis-aligned octant downsamples predictably: 4^3 full voxels -> 2^3 low.
    full_mask = np.zeros(FULL_SHAPE, np.uint8)
    full_mask[0:4, 0:4, 0:4] = 1
    seen = _stub_model(monkeypatch, full_mask, bbox=((0, 4), (0, 4), (0, 4)))

    resp = _post({"point_lps": [0.0, 0.0, 0.0], "res": "low"})

    assert seen["shape"] == FULL_SHAPE
    assert np.allclose(seen["affine"][:3, :3], np.eye(3))
    assert seen["case_key"] == f"{CASE_NUM}:full"
    mask, affine = _decode_mask(resp)
    assert mask.shape == LOW_SHAPE
    assert np.allclose(affine[:3, :3], np.eye(3) * 2)
    assert int(mask.sum()) == 8 and mask[0:2, 0:2, 0:2].all()
    assert resp.headers["X-Mask-Voxels"] == "8"
    assert resp.headers["X-Changed-Bbox"] == "0,2,0,2,0,2"


def test_seed_labelmap_is_upsampled_to_the_inference_grid(tmp_path, monkeypatch):
    _write_grids(tmp_path, monkeypatch)
    seen = _stub_model(monkeypatch, np.ones(FULL_SHAPE, np.uint8))

    seed_low = np.zeros(LOW_SHAPE, np.uint8)
    seed_low[1, 2, 3] = 7
    seed_b64 = base64.b64encode(gzip.compress(seed_low.tobytes(order="F"))).decode()
    _post({"point_lps": [0.0, 0.0, 0.0], "res": "low",
           "initial_seg_gz_b64": seed_b64})

    raw = gzip.decompress(base64.b64decode(seen["prompt"]["initial_seg_gz_b64"]))
    assert len(raw) == int(np.prod(FULL_SHAPE))
    up = np.frombuffer(raw, np.uint8).reshape(FULL_SHAPE, order="F")
    # One low voxel becomes its 2x2x2 full-res block, value preserved.
    assert (up[2:4, 4:6, 6:8] == 7).all()
    assert int(np.count_nonzero(up)) == 8


def test_raw_voxel_coordinates_are_scaled_up(tmp_path, monkeypatch):
    _write_grids(tmp_path, monkeypatch)
    seen = _stub_model(monkeypatch, np.ones(FULL_SHAPE, np.uint8))

    _post({"point_ijk": [1, 2, 3], "res": "low"})

    assert seen["prompt"]["point_ijk"] == [2, 4, 6]


def test_without_lowres_files_the_old_behavior_survives(tmp_path, monkeypatch):
    """Low-res is additive: when the batch never ran, the viewer fell back to
    the full volume too, so the response must stay on the full grid."""
    _write_grids(tmp_path, monkeypatch, with_lowres=False)
    full_mask = np.zeros(FULL_SHAPE, np.uint8)
    full_mask[0, 0, 0] = 1
    seen = _stub_model(monkeypatch, full_mask)

    resp = _post({"point_lps": [0.0, 0.0, 0.0], "res": "low"})

    assert seen["shape"] == FULL_SHAPE
    mask, affine = _decode_mask(resp)
    assert mask.shape == FULL_SHAPE
    assert np.allclose(affine[:3, :3], np.eye(3))


def test_full_res_request_is_untouched(tmp_path, monkeypatch):
    _write_grids(tmp_path, monkeypatch)
    full_mask = np.zeros(FULL_SHAPE, np.uint8)
    full_mask[3, 3, 3] = 1
    seen = _stub_model(monkeypatch, full_mask)

    resp = _post({"point_lps": [0.0, 0.0, 0.0], "res": "full"})

    assert seen["shape"] == FULL_SHAPE
    mask, _ = _decode_mask(resp)
    assert mask.shape == FULL_SHAPE


def test_empty_after_downsample_is_still_a_422(tmp_path, monkeypatch):
    """The 'nothing found' check must judge the mask the user will actually
    see, which is the downsampled one."""
    _write_grids(tmp_path, monkeypatch)
    _stub_model(monkeypatch, np.zeros(FULL_SHAPE, np.uint8))

    resp = _post({"point_lps": [0.0, 0.0, 0.0], "res": "low"})

    body, code = resp
    assert code == 422
    assert "box or lasso" in body.get_json()["error"]
