"""A run records when it started, which GET /api/me/runs lists it by.

The Upload page's in-process path keeps each run as <runs>/<session>/job.json
(see api_blueprint._set_inference_job). The listing itself is covered in
test_account_deletion.py and test_auth_endpoints.py; this pins the writer.
"""

from __future__ import annotations

import json
import time

import nibabel as nib
import numpy as np
from flask import Flask

import api.api_blueprint as api_routes


def test_a_started_run_records_its_start_time(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    monkeypatch.setattr(api_routes, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(api_routes.role_store, "has_role", lambda *_args: False)
    monkeypatch.setattr(api_routes.plan_store, "check_inference", lambda *_args: None)
    monkeypatch.setattr(api_routes.plan_store, "record_inference", lambda *_args: None)
    monkeypatch.setattr(api_routes.plan_store, "finish_inference", lambda *_args: None)
    # The model never runs here; the worker thread ends at once.
    monkeypatch.setattr(api_routes, "run_auto_segmentation", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(api_routes, "_get_inference_job", lambda _sid: None)
    ct = tmp_path / "ct.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.int16), np.eye(4)), str(ct))

    before = time.time()
    try:
        with Flask(__name__).test_request_context(method="POST"):
            response, status = api_routes._start_auto_segmentation(
                "started-run", "ePAI", server_input_path=str(ct),
            )
        assert status == 200, response.get_json()
        # The worker thread ends the run as failed (no model), which rewrites the
        # record; the start time has to survive that.
        record = {}
        for _ in range(100):
            record = json.loads((runs / "started-run" / "job.json").read_text())
            if record["status"] == "failed":
                break
            time.sleep(0.05)
        assert record["status"] == "failed"
        assert before <= record["created_at"] <= time.time()
        assert record["user_id"] == "owner"
        assert record["model"] == "ePAI"
    finally:
        api_routes.inference_jobs.pop("started-run", None)
