#!/usr/bin/env python3
import os
import time
import json
import shlex
import socket
import tempfile
import subprocess
from pathlib import Path

import requests


def env(name: str, default: str = "") -> str:
    return (os.getenv(name, default) or "").strip()


def build_headers(token: str, worker_id: str) -> dict:
    return {
        "X-Worker-Token": token,
        "X-Worker-Id": worker_id,
    }


def run_inference(input_path: str, work_dir: str) -> tuple[str, str | None]:
    # The command must leave the model's own label ids in output_mask. The
    # server converts the uploaded mask into the viewer's ids itself, so a
    # command that converted it as well would shift the labels twice.
    output_mask = os.path.join(work_dir, "combined_labels.nii.gz")
    output_csv = os.path.join(work_dir, "output.csv")

    script_path = env("WORKER_INFER_SCRIPT")
    cmd_template = env("WORKER_INFER_CMD_TEMPLATE")

    if script_path:
        cmd = ["bash", script_path, input_path, output_mask, output_csv]
        result = subprocess.run(cmd, text=True, capture_output=True)
    elif cmd_template:
        cmd_str = cmd_template.format(
            input_path=shlex.quote(input_path),
            output_mask=shlex.quote(output_mask),
            output_csv=shlex.quote(output_csv),
            work_dir=shlex.quote(work_dir),
        )
        result = subprocess.run(cmd_str, shell=True, executable="/bin/bash", text=True, capture_output=True)
    else:
        raise RuntimeError("Set WORKER_INFER_SCRIPT or WORKER_INFER_CMD_TEMPLATE on worker host")

    if result.returncode != 0:
        raise RuntimeError(
            "Inference command failed"
            f"\nExit code: {result.returncode}"
            f"\nSTDOUT:\n{(result.stdout or '').strip()}"
            f"\nSTDERR:\n{(result.stderr or '').strip()}"
        )

    if not os.path.exists(output_mask):
        raise RuntimeError(f"Inference finished but output mask missing: {output_mask}")

    return output_mask, output_csv if os.path.exists(output_csv) else None


def main():
    server_base = env("WORKER_SERVER_BASE_URL")
    api_token = env("WORKER_API_TOKEN")
    worker_id = env("WORKER_ID", socket.gethostname())
    poll_seconds = int(env("WORKER_POLL_SECONDS", "5"))
    lease_seconds = int(env("WORKER_LEASE_SECONDS", "900"))

    if not server_base:
        raise RuntimeError("WORKER_SERVER_BASE_URL is required, e.g. https://server-a.example.com")
    if not api_token:
        raise RuntimeError("WORKER_API_TOKEN is required")

    server_base = server_base.rstrip("/")
    next_url = f"{server_base}/api/jobs/next"

    session = requests.Session()
    headers = build_headers(api_token, worker_id)

    print(f"[worker] started id={worker_id} server={server_base}")

    while True:
        try:
            resp = session.get(next_url, headers=headers, params={"lease_seconds": lease_seconds}, timeout=30)
            if resp.status_code == 204:
                time.sleep(poll_seconds)
                continue

            resp.raise_for_status()
            job = resp.json()
            job_id = job["job_id"]
            print(f"[worker] leased job {job_id}")

            with tempfile.TemporaryDirectory(prefix=f"job_{job_id}_") as work_dir:
                input_path = os.path.join(work_dir, "input.nii.gz")

                with session.get(job["input_download_url"], headers=headers, stream=True, timeout=300) as download_resp:
                    download_resp.raise_for_status()
                    with open(input_path, "wb") as out:
                        for chunk in download_resp.iter_content(chunk_size=1024 * 1024):
                            if chunk:
                                out.write(chunk)

                heartbeat_payload = {"worker_id": worker_id, "lease_seconds": lease_seconds}
                session.post(job["heartbeat_url"], headers=headers, json=heartbeat_payload, timeout=30).raise_for_status()

                output_mask, output_csv = run_inference(input_path=input_path, work_dir=work_dir)

                files = {
                    "prediction": ("combined_labels.nii.gz", open(output_mask, "rb"), "application/gzip"),
                }
                if output_csv:
                    files["output_csv"] = ("output.csv", open(output_csv, "rb"), "text/csv")

                try:
                    result_resp = session.post(
                        job["result_upload_url"],
                        headers=headers,
                        files=files,
                        data={"worker_id": worker_id},
                        timeout=600,
                    )
                    result_resp.raise_for_status()
                finally:
                    for _, file_obj, _ in files.values():
                        file_obj.close()

                print(f"[worker] completed job {job_id}")

        except Exception as e:
            error_text = str(e)
            print(f"[worker] error: {error_text}")
            try:
                if "job" in locals() and isinstance(job, dict) and job.get("fail_url"):
                    session.post(
                        job["fail_url"],
                        headers=headers,
                        json={"worker_id": worker_id, "error": error_text[:3000]},
                        timeout=30,
                    )
            except Exception as fail_err:
                print(f"[worker] failed to mark job as failed: {fail_err}")
            time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
