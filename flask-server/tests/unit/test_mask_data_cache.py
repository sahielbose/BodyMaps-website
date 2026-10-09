"""/mask-data measures a dataset case once per set of files, not on every open.

The viewer, the compare page and the assistant all ask for a case's organ
metrics, and measuring a large CT takes a second or more. The answer is cached
per case id, stamped with the raw mask and CT on disk and the label scheme, so a
replaced file is measured again. Errors, empty answers and session ids are never
cached.
"""

import json
import os

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

from api import api_blueprint as bp
from constants import Constants

LIVER = {"organ_metrics": [{"organ_name": "liver", "volume_cm3": 1200}]}


@pytest.fixture(autouse=True)
def _empty_cache():
    bp._MASK_DATA_CACHE.clear()
    yield
    bp._MASK_DATA_CACHE.clear()


def _post(session_key):
    app = Flask(__name__)
    app.add_url_rule("/api/mask-data", view_func=bp.get_mask_data, methods=["POST"])
    return app.test_client().post("/api/mask-data", data={"sessionKey": session_key})


def _counting(monkeypatch, answer=LIVER):
    calls = []

    def compute(case_id):
        calls.append(case_id)
        return json.loads(json.dumps(answer))

    monkeypatch.setattr(bp, "get_mask_data_internal", compute)
    return calls


def test_repeat_mask_data_for_a_case_is_computed_once(monkeypatch):
    calls = _counting(monkeypatch)
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: ("scheme", "mask", "ct"))

    first = _post("23")
    second = _post("23")

    assert calls == ["23"]
    assert first.status_code == second.status_code == 200
    assert first.get_json() == second.get_json() == LIVER


def test_a_reader_cannot_change_the_cached_answer(monkeypatch):
    _counting(monkeypatch)
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: ("scheme", "mask", "ct"))

    bp._mask_data_for_case("23")["organ_metrics"][0]["volume_cm3"] = 1
    bp._mask_data_for_case("23")["organ_metrics"].clear()

    assert bp._mask_data_for_case("23") == LIVER


def test_a_changed_mask_or_ct_is_recomputed(monkeypatch):
    calls = _counting(monkeypatch)
    stamp = {"value": ("scheme", "mask-1", "ct-1")}
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: stamp["value"])

    _post("23")
    _post("23")
    stamp["value"] = ("scheme", "mask-1", "ct-2")
    _post("23")
    _post("23")

    assert calls == ["23", "23"]


def test_errors_and_empty_metrics_are_not_cached(monkeypatch):
    calls = _counting(monkeypatch, {"error": "x"})
    monkeypatch.setattr(bp, "_ai_compute_organ_metrics_from_labels", lambda _case: None)
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: ("scheme", "mask", "ct"))

    _post("23")
    _post("23")
    assert calls == ["23", "23"]

    empty = _counting(monkeypatch, {"organ_metrics": []})
    _post("23")
    _post("23")
    assert empty == ["23", "23"]
    assert len(bp._MASK_DATA_CACHE) == 0


def test_no_local_files_means_no_cache(monkeypatch):
    calls = _counting(monkeypatch)
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: None)

    _post("23")
    _post("23")

    assert calls == ["23", "23"]
    assert len(bp._MASK_DATA_CACHE) == 0


def test_files_that_change_during_the_measurement_are_not_cached(monkeypatch):
    # The first call fetches the CT, so the files it started from are gone.
    calls = _counting(monkeypatch)
    stamps = iter([("scheme", "mask", None), ("scheme", "mask", "ct")])
    current = {"value": None}

    def stamp(_case):
        current["value"] = next(stamps, current["value"])
        return current["value"]

    monkeypatch.setattr(bp, "_mask_data_stamp", stamp)

    _post("23")
    assert len(bp._MASK_DATA_CACHE) == 0
    _post("23")
    _post("23")
    assert calls == ["23", "23"]


def test_session_ids_are_never_cached(monkeypatch):
    session = "11111111-2222-3333-4444-555555555555"
    calls = []
    monkeypatch.setattr(bp, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(bp.role_store, "has_role", lambda *_args: False)
    monkeypatch.setattr(bp, "_get_inference_job", lambda sid: {"user_id": "owner", "status": "completed"})
    monkeypatch.setattr(
        bp, "get_session_mask_data", lambda sid, job: calls.append(sid) or json.loads(json.dumps(LIVER))
    )
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: ("scheme", "mask", "ct"))

    assert _post(session).get_json() == LIVER
    assert _post(session).get_json() == LIVER

    assert calls == [session, session]
    assert len(bp._MASK_DATA_CACHE) == 0


def test_cache_is_bounded(monkeypatch):
    _counting(monkeypatch)
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: ("scheme", "mask", "ct"))

    for number in range(1, bp._MASK_DATA_CACHE_MAX + 11):
        _post(str(number))

    assert len(bp._MASK_DATA_CACHE) == bp._MASK_DATA_CACHE_MAX
    assert "1" not in bp._MASK_DATA_CACHE
    assert str(bp._MASK_DATA_CACHE_MAX + 10) in bp._MASK_DATA_CACHE


def test_the_assistant_reads_the_same_cache(monkeypatch):
    calls = _counting(monkeypatch)
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: ("scheme", "mask", "ct"))
    bp._AI_METRICS_CACHE.pop("23", None)

    _post("23")
    try:
        metrics, source = bp._ai_load_metrics("23", None)
    finally:
        bp._AI_METRICS_CACHE.pop("23", None)

    assert calls == ["23"]
    assert source == "server_mask_data"
    assert metrics[0]["organ_name"] == "liver"


# ---- the stamp itself, on real files ----


@pytest.fixture
def roots(tmp_path, monkeypatch):
    pants = tmp_path / "pants"
    monkeypatch.setattr(Constants, "PANTS_PATH", str(pants))
    monkeypatch.setattr(bp, "LOWRES_ROOT", str(tmp_path / "lowres"))
    monkeypatch.setattr(bp, "_AI_HF_CACHE_ROOT", str(tmp_path / "hf"))
    return tmp_path


def _touch(path, content=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return str(path)


def test_stamp_follows_the_resolution_order_and_never_downloads(roots, monkeypatch):
    def no_download(*_args, **_kwargs):
        raise AssertionError("the stamp must never download")

    monkeypatch.setattr(bp, "_ai_download_case_file", no_download)
    case = "PanTS_00000023"

    assert bp._mask_data_stamp("23") is None
    assert bp._mask_data_stamp("../23") is None

    # Only the HuggingFace cache holds the case.
    hf_mask = _touch(roots / "hf" / case / "combined_labels.nii.gz")
    hf_ct = _touch(roots / "hf" / case / "ct.nii.gz")
    stamp = bp._mask_data_stamp("23")
    assert stamp[0] == bp.LABEL_SCHEME
    assert stamp[1][0] == hf_mask and stamp[2][0] == hf_ct

    # The low-res mask comes before the HuggingFace one.
    lowres = _touch(roots / "lowres" / "mask_only" / case / "combined_labels_lowres.nii.gz")
    assert bp._mask_data_stamp("23")[1][0] == lowres

    # The local dataset comes first, for both files.
    mask = _touch(roots / "pants" / "mask_only" / case / "combined_labels.nii.gz")
    ct = _touch(roots / "pants" / "image_only" / case / "ct.nii.gz")
    stamp = bp._mask_data_stamp("23")
    assert stamp[1][0] == mask and stamp[2][0] == ct


def test_stamp_changes_with_the_mask_the_ct_and_the_scheme(roots, monkeypatch):
    case = "PanTS_00000023"
    mask = roots / "pants" / "mask_only" / case / "combined_labels.nii.gz"
    ct = roots / "pants" / "image_only" / case / "ct.nii.gz"
    _touch(mask)
    first = bp._mask_data_stamp("23")
    assert first[2] is None

    _touch(ct)
    with_ct = bp._mask_data_stamp("23")
    assert with_ct != first

    _touch(ct, b"longer")
    assert bp._mask_data_stamp("23") != with_ct
    current = bp._mask_data_stamp("23")

    os.utime(mask, ns=(1, 1))
    assert bp._mask_data_stamp("23") != current
    current = bp._mask_data_stamp("23")

    monkeypatch.setattr(bp, "LABEL_SCHEME", "viewer-v2")
    assert bp._mask_data_stamp("23") != current


# ---- the label-based measurement ----


def test_label_metrics_match_the_per_label_reference(tmp_path, monkeypatch):
    zooms = (2.0, 2.0, 2.5)
    mask = np.zeros((10, 8, 6), dtype=np.uint8)
    ct = np.full(mask.shape, -1000.0, dtype=np.float32)
    mask[1:4, 1:4, 0:3] = 14  # 27 voxels, reaches the first slice
    ct[1:4, 1:4, 0:3] = 60.0
    ct[1, 1, 0] = 80.0  # mean 1640 / 27 = 60.7407..., far from a rounding edge
    mask[5:9, 2:7, 2:4] = 3  # 40 voxels, interior only
    ct[5:9, 2:7, 2:4] = 200.0
    mask[0, 0, 5] = 7  # one voxel on the last slice: too small to count as cut off
    ct[0, 0, 5] = -20.0

    affine = np.diag([*zooms, 1.0])
    mask_path = tmp_path / "labels.nii.gz"
    ct_path = tmp_path / "ct.nii.gz"
    nib.save(nib.Nifti1Image(mask, affine), str(mask_path))
    nib.save(nib.Nifti1Image(ct, affine), str(ct_path))

    monkeypatch.setattr(bp, "MESH_LABELS", {
        3: {"key": "aorta", "name": "Aorta"},
        7: {"key": "common_bile_duct", "name": "Common Bile Duct"},
        12: {"key": "kidney_left", "name": "Left Kidney"},
        14: {"key": "liver", "name": "Liver"},
        99: {"key": "beyond_the_mask", "name": "Beyond"},
    })
    monkeypatch.setattr(bp, "_ai_mask_path_for", lambda _case: str(mask_path))
    monkeypatch.setattr(bp, "_ai_local_image_path", lambda _case: str(ct_path))

    by_name = {m["organ_name"]: m for m in bp._ai_compute_organ_metrics_from_labels("1")["organ_metrics"]}

    voxel_cm3 = 2.0 * 2.0 * 2.5 / 1000.0
    assert set(by_name) == {"aorta", "common_bile_duct", "liver"}
    assert by_name["liver"] == {
        "organ_name": "liver",
        "volume_cm3": round(27 * voxel_cm3, 2),
        "voxel_count": 27,
        "truncated": True,
        "mean_hu": 60.7,
    }
    assert by_name["aorta"] == {
        "organ_name": "aorta",
        "volume_cm3": round(40 * voxel_cm3, 2),
        "voxel_count": 40,
        "truncated": False,
        "mean_hu": 200.0,
    }
    assert by_name["common_bile_duct"]["voxel_count"] == 1
    assert by_name["common_bile_duct"]["mean_hu"] == -20.0
    assert by_name["common_bile_duct"]["truncated"] is False


def test_label_metrics_ignore_negative_labels_and_work_without_a_ct(tmp_path, monkeypatch):
    mask = np.zeros((6, 6, 4), dtype=np.int16)
    mask[0:2, 0:2, 1:3] = -5
    mask[3:5, 3:5, 1:3] = 14
    mask_path = tmp_path / "labels.nii.gz"
    nib.save(nib.Nifti1Image(mask, np.eye(4)), str(mask_path))

    monkeypatch.setattr(bp, "MESH_LABELS", {14: {"key": "liver", "name": "Liver"}})
    monkeypatch.setattr(bp, "_ai_mask_path_for", lambda _case: str(mask_path))
    monkeypatch.setattr(bp, "_ai_local_image_path", lambda _case: None)

    metrics = bp._ai_compute_organ_metrics_from_labels("1")["organ_metrics"]

    assert metrics == [{"organ_name": "liver", "volume_cm3": 0.01, "voxel_count": 8, "truncated": False}]


def test_zero_padded_ids_share_the_case_cache(monkeypatch):
    calls = _counting(monkeypatch)
    monkeypatch.setattr(bp, "_mask_data_stamp", lambda _case: ("scheme", "mask", "ct"))

    _post("7")
    _post("007")

    assert calls == ["7"]
    assert list(bp._MASK_DATA_CACHE) == ["7"]


def test_label_metrics_ignore_values_above_the_catalog(tmp_path, monkeypatch):
    mask = np.zeros((6, 6, 4), dtype=np.int32)
    mask[0:2, 0:2, 1:3] = 2 ** 30  # would size the count arrays at gigabytes
    mask[3:5, 3:5, 1:3] = 14
    mask_path = tmp_path / "labels.nii.gz"
    nib.save(nib.Nifti1Image(mask, np.eye(4)), str(mask_path))

    monkeypatch.setattr(bp, "MESH_LABELS", {14: {"key": "liver", "name": "Liver"}})
    monkeypatch.setattr(bp, "_ai_mask_path_for", lambda _case: str(mask_path))
    monkeypatch.setattr(bp, "_ai_local_image_path", lambda _case: None)

    metrics = bp._ai_compute_organ_metrics_from_labels("1")["organ_metrics"]

    assert metrics == [{"organ_name": "liver", "volume_cm3": 0.01, "voxel_count": 8, "truncated": False}]
