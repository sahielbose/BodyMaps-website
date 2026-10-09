"""Refine: the class's current voxels go to the model with no prompt and the
model redraws them (nnInteractive's zero-shot label refinement). On PanTS
case 1 this lifted rough organ masks by 0.01 to 0.09 Dice. These tests pin
the contract: the seed is the whole request and it runs a prediction, an
empty class never claims a lease, a checkpoint without the capability is
refused, a replay never re-runs it, it never falls back to region-grow, and
an empty redraw is refused instead of erasing the class."""
import base64
import gzip

import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as api_routes
import nnInteractive.inference.remote.remote_session as remote_mod
import services.advanced_analysis as analysis
import services.nninteractive_predictor as predictor

CT = np.zeros((6, 6, 6), dtype=np.float32)


class RefineRemote:
    """nnInteractiveRemoteInferenceSession stand-in: a refine prediction
    grows the seed by one voxel along i, so the result is recognisable."""

    instances: list["RefineRemote"] = []
    zero_shot = True

    def __init__(self, *args, **kwargs):
        self.calls = []
        self.buffer = None
        self.supports_undo = True
        self.supports_zero_shot_label_refinement = RefineRemote.zero_shot
        self._last_paste_bbox = [[0, 6], [0, 6], [0, 6]]
        RefineRemote.instances.append(self)

    def ping(self):
        return True

    def set_image(self, img):
        self.calls.append(("set_image",))

    def set_target_buffer(self, buf):
        self.buffer = buf

    def reset_interactions(self):
        self.calls.append(("reset",))

    def add_initial_seg_interaction(self, seg, run_prediction=False):
        self.calls.append(("initial_seg", int(seg.sum()), run_prediction))
        self.buffer[:] = seg
        if run_prediction:
            self.buffer[1:] |= seg[:-1]

    def add_point_interaction(self, coords, include_interaction=True, run_prediction=True):
        self.calls.append(("point", tuple(coords), include_interaction, run_prediction))
        if run_prediction:
            self.buffer[tuple(coords)] = 1 if include_interaction else 0

    def close(self):
        pass


def seed_mask():
    seg = np.zeros(CT.shape, dtype=np.uint8)
    seg[2:4, 2:4, 2:4] = 1
    return seg


@pytest.fixture(autouse=True)
def registry(monkeypatch):
    RefineRemote.instances = []
    RefineRemote.zero_shot = True
    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", RefineRemote)
    for state in list(predictor._states.values()):
        state.session = None  # never close a real lease from a unit test
    predictor._states.clear()
    yield
    predictor._states.clear()


def test_the_seed_is_the_whole_request_and_it_runs_a_prediction():
    seed = seed_mask()
    mask, _ = predictor.predict(CT, "1:full", session_token="r", initial_seg=seed, refine=True)

    remote = RefineRemote.instances[0]
    assert [c for c in remote.calls if c[0] in ("initial_seg", "point")] == [
        ("initial_seg", int(seed.sum()), True)
    ]
    assert int(mask.sum()) == 12  # the 8-voxel seed plus the fake's one-voxel growth
    assert predictor.session_is_active("r")


def test_later_prompts_refine_the_refined_object():
    predictor.predict(CT, "1:full", session_token="r", initial_seg=seed_mask(), refine=True)
    mask, _ = predictor.predict(CT, "1:full", point_ijk=[4, 3, 3], session_token="r", include=False)

    remote = RefineRemote.instances[0]
    assert remote.calls.count(("reset",)) == 1  # the point accumulated, no restart
    assert mask[4, 3, 3] == 0 and mask[3, 3, 3] == 1


@pytest.mark.parametrize("seed", [None, np.zeros(CT.shape, dtype=np.uint8)], ids=["missing", "empty"])
def test_an_empty_class_is_refused_before_claiming_a_lease(seed):
    with pytest.raises(ValueError, match="no voxels to refine"):
        predictor.predict(CT, "1:full", session_token="r", initial_seg=seed, refine=True)
    assert RefineRemote.instances == []
    assert "r" not in predictor._states


def test_a_checkpoint_without_zero_shot_refinement_is_refused():
    RefineRemote.zero_shot = False
    with pytest.raises(ValueError, match="can't refine"):
        predictor.predict(CT, "1:full", session_token="r", initial_seg=seed_mask(), refine=True)
    assert not any(c[0] == "initial_seg" for c in RefineRemote.instances[0].calls)


def test_a_replay_after_expiry_restores_the_refined_object_without_rerunning_it():
    predictor.predict(CT, "1:full", session_token="r", initial_seg=seed_mask(), refine=True)
    state = predictor._states["r"]
    refined = state.target_buffer.copy()

    predictor._rebuild_and_replay(state, CT, "1:full")

    replayed = RefineRemote.instances[-1]
    seeds = [c for c in replayed.calls if c[0] == "initial_seg"]
    # The head is the pre-expiry buffer (the refined object), sent deferred.
    assert seeds == [("initial_seg", int(refined.sum()), False)]
    np.testing.assert_array_equal(state.target_buffer, refined)


def _b64(seg):
    return base64.b64encode(gzip.compress(np.asfortranarray(seg).tobytes(order="F"))).decode()


def test_segment_from_prompt_needs_no_point_to_refine():
    seed = seed_mask()
    mask, _ = analysis.segment_from_prompt(
        CT, np.eye(4), {"refine": True, "initial_seg_gz_b64": _b64(seed), "session_token": "r"},
        case_key="1:full")
    assert int(mask.sum()) == 12


def test_refine_without_the_class_voxels_is_a_clear_error():
    with pytest.raises(ValueError, match="current voxels"):
        analysis.segment_from_prompt(CT, np.eye(4), {"refine": True, "session_token": "r"}, case_key="1:full")


def test_a_failed_refine_never_falls_back_to_region_grow(monkeypatch):
    def down(*args, **kwargs):
        raise ConnectionError("model server down")

    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", down)
    monkeypatch.setattr(analysis, "region_grow", lambda *a, **k: pytest.fail("fell back to region_grow"))
    with pytest.raises(Exception):
        analysis.segment_from_prompt(
            CT, np.eye(4), {"refine": True, "initial_seg_gz_b64": _b64(seed_mask())}, case_key="1:full")


def test_a_model_outage_mid_refine_says_so_instead_of_a_bare_failure(monkeypatch):
    def down(*args, **kwargs):
        raise ConnectionError("model server down")

    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", down)
    monkeypatch.setattr(analysis, "region_grow", lambda *a, **k: pytest.fail("fell back to region_grow"))
    with pytest.raises(predictor.PromptModelUnavailableError, match="isn't answering right now") as caught:
        analysis.segment_from_prompt(
            CT, np.eye(4), {"refine": True, "initial_seg_gz_b64": _b64(seed_mask())}, case_key="1:full")
    assert isinstance(caught.value.__cause__, ConnectionError)


def test_the_endpoint_answers_a_model_outage_with_503_and_a_plain_message(monkeypatch, tmp_path):
    ct_path = tmp_path / "ct.nii.gz"
    import nibabel as nib
    nib.save(nib.Nifti1Image(CT.astype(np.int16), np.eye(4)), str(ct_path))
    monkeypatch.setattr(api_routes, "_case_ct_path", lambda case_id, low=False: str(ct_path))
    monkeypatch.setattr(api_routes, "_ct_cache_key", None)
    monkeypatch.setattr(api_routes, "_ct_cache_obj", None)
    monkeypatch.setattr(api_routes, "_ct_cache_array", None)

    def down(ct, affine, prompt, case_key=None):
        raise predictor.PromptModelUnavailableError(predictor.PromptModelUnavailableError.MESSAGE)

    monkeypatch.setattr(analysis, "segment_from_prompt", down)
    app = Flask(__name__)
    body = {"point_ijk": [1, 1, 1], "session_token": "r", "res": "full"}
    with app.test_request_context(json=body, method="POST"):
        resp = api_routes.interactive_segment("1")
    resp, status = resp if isinstance(resp, tuple) else (resp, resp.status_code)
    assert status == 503
    assert resp.get_json()["error"] == predictor.PromptModelUnavailableError.MESSAGE


def test_an_empty_redraw_is_refused_instead_of_erasing_the_class(monkeypatch, tmp_path):
    ct_path = tmp_path / "ct.nii.gz"
    import nibabel as nib
    nib.save(nib.Nifti1Image(CT.astype(np.int16), np.eye(4)), str(ct_path))
    monkeypatch.setattr(api_routes, "_case_ct_path", lambda case_id, low=False: str(ct_path))
    monkeypatch.setattr(api_routes, "_ct_cache_key", None)
    monkeypatch.setattr(api_routes, "_ct_cache_obj", None)
    monkeypatch.setattr(api_routes, "_ct_cache_array", None)
    monkeypatch.setattr(analysis, "segment_from_prompt",
                        lambda ct, affine, prompt, case_key=None: (np.zeros(ct.shape, dtype=np.uint8), None))
    monkeypatch.setattr(predictor, "session_is_active", lambda token: True)

    app = Flask(__name__)
    body = {"refine": True, "initial_seg_gz_b64": _b64(seed_mask()), "session_token": "r", "res": "full"}
    with app.test_request_context(json=body, method="POST"):
        resp = api_routes.interactive_segment("1")
    resp, status = resp if isinstance(resp, tuple) else (resp, resp.status_code)
    assert status == 422
    assert "left as it was" in resp.get_json()["error"]
