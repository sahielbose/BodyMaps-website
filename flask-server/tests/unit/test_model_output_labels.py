"""AI model masks are converted into viewer ids once, and read by viewer id after that.

The in-process runners rewrite a model's own label numbers into the viewer catalog
with _remap_combined_labels. Session organ stats used to index that rewritten mask
by the model's own numbers (ePAI liver is 12, the viewer's left kidney), and masks
from a pull worker were never rewritten at all.
"""

from __future__ import annotations

import io
import zipfile

import nibabel as nib
import numpy as np
import pytest

import api.utils as api_utils
from services.auto_segmentor import _EPAI_TO_VIEWER
from services.inference_job_queue import InferenceJobQueue
from services.label_scheme import PANTS_TO_VIEWER, VIEWER_IDS

# ePAI's own ids: kidney_left 10, liver 12, spleen 17, postcava 9, pancreatic_pdac 23.
EPAI_RAW = {"kidney_left": 10, "liver": 12, "spleen": 17, "postcava": 9, "pancreatic_lesion": 23}
# A different voxel count per organ, so a metric read at the wrong id shows up.
VOXELS = {"kidney_left": 8, "liver": 27, "spleen": 12, "postcava": 4, "pancreatic_lesion": 2}


def _blobs(values: dict) -> np.ndarray:
    labels = np.zeros((10, 10, 10), dtype=np.uint8)
    flat = labels.reshape(-1)
    start = 0
    for organ, value in values.items():
        flat[start:start + VOXELS[organ]] = value
        start += VOXELS[organ] + 3
    return labels


def _save(path, data):
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(path))


def _values(path) -> dict:
    data = np.asanyarray(nib.load(str(path)).dataobj)
    return {int(v): int((data == v).sum()) for v in np.unique(data) if v}


def test_session_organ_stats_read_the_viewer_ids_the_session_mask_holds(tmp_path):
    out = tmp_path / "outputs" / "ct"
    out.mkdir(parents=True)
    # What _remap_combined_labels leaves on disk after an ePAI run.
    _save(out / "combined_labels.nii.gz", _blobs({organ: VIEWER_IDS[organ] for organ in EPAI_RAW}))
    _save(tmp_path / "ct.nii.gz", np.full((10, 10, 10), 40, dtype=np.int16))
    job = {"status": "completed", "ct_path": str(tmp_path / "ct.nii.gz"), "output_mask_dir": str(out), "model": "ePAI"}

    metrics = {m["organ_name"]: m for m in api_utils.get_session_mask_data("session", job)["organ_metrics"]}

    for organ, count in VOXELS.items():
        assert metrics[organ]["voxel_count"] == count, organ
    # Every organ ePAI can produce is listed once, under its catalog name.
    assert set(metrics) == {
        key for key, viewer_id in VIEWER_IDS.items() if viewer_id in set(_EPAI_TO_VIEWER.values())
    }
    assert metrics["intestine"]["voxel_count"] == 0


def _queue_job(tmp_path, model="ePAI"):
    queue = InferenceJobQueue(str(tmp_path / "queue"))
    job = queue.create_job(io.BytesIO(b"scan"), "ct.nii.gz", session_id="session", model=model)
    assert queue.lease_next_job("worker-1")["job_id"] == job["job_id"]
    return queue, job


def test_pull_worker_results_are_remapped_into_viewer_ids_exactly_once(tmp_path):
    queue, job = _queue_job(tmp_path)
    upload = tmp_path / "upload" / "combined_labels.nii.gz"
    upload.parent.mkdir()
    _save(upload, _blobs(EPAI_RAW))
    expected = {VIEWER_IDS[organ]: VOXELS[organ] for organ in EPAI_RAW}

    done = queue.complete_job(job["job_id"], "worker-1", str(upload))
    assert _values(done["result_mask_path"]) == expected
    with zipfile.ZipFile(done["result_zip_path"]) as archive:
        zipped = tmp_path / "zipped.nii.gz"
        zipped.write_bytes(archive.read("combined_labels.nii.gz"))
    assert _values(zipped) == expected
    # The upload itself stays raw.
    assert _values(upload) == {EPAI_RAW[organ]: VOXELS[organ] for organ in EPAI_RAW}

    # Posting the result again converts the new copy once more, not the old one twice.
    again = queue.complete_job(job["job_id"], "worker-1", str(upload))
    assert _values(again["result_mask_path"]) == expected

    # Not the PanTS dataset table: that would make ePAI's pdac (23) a prostate.
    assert int(PANTS_TO_VIEWER[EPAI_RAW["pancreatic_lesion"]]) == VIEWER_IDS["prostate"]
    assert VIEWER_IDS["prostate"] not in expected


def test_pull_worker_results_of_an_unmapped_model_are_kept_as_written(tmp_path):
    queue, job = _queue_job(tmp_path, model="MedFormer")
    upload = tmp_path / "combined_labels.nii.gz"
    _save(upload, _blobs(EPAI_RAW))

    done = queue.complete_job(job["job_id"], "worker-1", str(upload))
    assert _values(done["result_mask_path"]) == _values(upload)


def test_an_unreadable_pull_worker_result_is_refused(tmp_path):
    queue, job = _queue_job(tmp_path)
    upload = tmp_path / "combined_labels.nii.gz"
    upload.write_bytes(b"not a nifti")

    with pytest.raises(ValueError):
        queue.complete_job(job["job_id"], "worker-1", str(upload))
    assert queue.get_job(job["job_id"])["status"] == "leased"


def test_a_bad_repeat_post_keeps_the_earlier_good_result(tmp_path):
    queue, job = _queue_job(tmp_path)
    upload = tmp_path / "upload" / "combined_labels.nii.gz"
    upload.parent.mkdir()
    _save(upload, _blobs(EPAI_RAW))
    done = queue.complete_job(job["job_id"], "worker-1", str(upload))
    good = _values(done["result_mask_path"])

    bad = tmp_path / "bad.nii.gz"
    bad.write_bytes(b"not a nifti")
    with pytest.raises(ValueError):
        queue.complete_job(job["job_id"], "worker-1", str(bad))

    assert _values(done["result_mask_path"]) == good
    assert queue.get_job(job["job_id"])["status"] == "succeeded"
    # No half-written copy is left beside the result.
    leftovers = [p.name for p in tmp_path.rglob(".incoming-*")]
    assert leftovers == []
