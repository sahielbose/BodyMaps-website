import os
import json
import uuid
import time
import shutil
import tempfile
import zipfile
from werkzeug.utils import secure_filename
from datetime import datetime, timezone
from contextlib import contextmanager
try:
    import fcntl
except ModuleNotFoundError:
    fcntl = None
    import msvcrt
else:
    msvcrt = None


class QueueFullError(RuntimeError):
    """Raised when the durable inference queue has reached its admission cap."""


class InferenceJobQueue:
    def __init__(self, root_dir: str):
        self.root_dir = os.path.abspath(root_dir)
        self.jobs_dir = os.path.join(self.root_dir, "jobs")
        self.inputs_dir = os.path.join(self.root_dir, "inputs")
        self.results_dir = os.path.join(self.root_dir, "results")
        self.lock_path = os.path.join(self.root_dir, ".lock")
        try:
            self.max_pending = max(1, int(os.getenv("INFERENCE_QUEUE_MAX_PENDING", "8")))
        except (TypeError, ValueError):
            self.max_pending = 8
        os.makedirs(self.jobs_dir, exist_ok=True)
        os.makedirs(self.inputs_dir, exist_ok=True)
        os.makedirs(self.results_dir, exist_ok=True)
        open(self.lock_path, "a").close()
        if os.path.getsize(self.lock_path) == 0:
            with open(self.lock_path, "wb") as f:
                f.write(b"0")

    @contextmanager
    def _locked(self):
        with open(self.lock_path, "r+b") as lock_file:
            if fcntl is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            else:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)

            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                else:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)

    def _job_path(self, job_id: str) -> str:
        try:
            safe_job_id = str(uuid.UUID(str(job_id)))
        except (TypeError, ValueError):
            return ""
        return os.path.join(self.jobs_dir, f"{safe_job_id}.json")

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _read_job(self, job_id: str):
        path = self._job_path(job_id)
        if not path or not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_job(self, job: dict):
        path = self._job_path(job["job_id"])
        if not path:
            raise ValueError("Invalid job ID")
        tmp_fd, tmp_path = tempfile.mkstemp(prefix="job_", suffix=".json", dir=self.jobs_dir)
        os.close(tmp_fd)
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False)
        os.replace(tmp_path, path)

    def create_job(self, input_stream, input_filename: str, session_id: str | None = None, model: str = "ePAI", max_attempts: int = 3):
        job_id = str(uuid.uuid4())
        session_id = session_id or job_id

        safe_input_name = secure_filename(str(input_filename or ""))
        if safe_input_name.lower().endswith(".nii.gz"):
            ext = ".nii.gz"
        elif safe_input_name.lower().endswith(".nii"):
            ext = ".nii"
        else:
            ext = ".bin"

        # Refuse a full queue before copying the input, so a rejected job never
        # writes to disk. The count is taken again under the lock below, since
        # another job can be admitted while this one copies.
        with self._locked():
            if self._active_count() >= self.max_pending:
                raise self._queue_full()

        input_copy_path = os.path.join(self.inputs_dir, f"{job_id}{ext}")
        with open(input_copy_path, "wb") as output_stream:
            shutil.copyfileobj(input_stream, output_stream)

        now = self._now()
        job = {
            "job_id": job_id,
            "session_id": session_id,
            "model": model,
            "status": "queued",
            "created_at": now,
            "updated_at": now,
            "attempts": 0,
            "max_attempts": int(max_attempts),
            "lease_owner": None,
            "lease_until": None,
            "error": None,
            "input_file_path": input_copy_path,
            "result_mask_path": None,
            "result_csv_path": None,
            "result_zip_path": None,
        }

        with self._locked():
            if self._active_count() >= self.max_pending:
                try:
                    os.remove(input_copy_path)
                except OSError:
                    pass
                raise self._queue_full()
            self._write_job(job)

        return job

    def _active_count(self) -> int:
        """Jobs still holding a queue slot. Call with the lock held."""
        active = 0
        for name in os.listdir(self.jobs_dir):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.jobs_dir, name), "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except (OSError, ValueError, TypeError):
                continue
            if existing.get("status") in {"queued", "leased", "running"}:
                active += 1
        return active

    def _queue_full(self) -> QueueFullError:
        return QueueFullError(
            f"Inference queue is full ({self.max_pending} pending jobs)"
        )

    def get_job(self, job_id: str):
        with self._locked():
            return self._read_job(job_id)

    def lease_next_job(self, worker_id: str, lease_seconds: int = 900):
        lease_seconds = max(30, int(lease_seconds))
        now_epoch = int(time.time())

        with self._locked():
            candidates = []
            for name in os.listdir(self.jobs_dir):
                if not name.endswith(".json"):
                    continue
                path = os.path.join(self.jobs_dir, name)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        job = json.load(f)
                except Exception:
                    continue

                status = job.get("status")
                lease_until = job.get("lease_until")
                lease_expired = True
                if lease_until:
                    try:
                        lease_expired = int(lease_until) <= now_epoch
                    except Exception:
                        lease_expired = True

                if status == "queued":
                    candidates.append(job)
                elif status in {"leased", "running"} and lease_expired:
                    if int(job.get("attempts", 0)) < int(job.get("max_attempts", 3)):
                        candidates.append(job)
                    else:
                        job["status"] = "failed"
                        job["error"] = "Job exceeded max attempts after lease timeouts"
                        job["updated_at"] = self._now()
                        self._write_job(job)

            if not candidates:
                return None

            candidates.sort(key=lambda x: x.get("created_at", ""))
            job = candidates[0]
            job["status"] = "leased"
            job["attempts"] = int(job.get("attempts", 0)) + 1
            job["lease_owner"] = worker_id
            job["lease_until"] = str(now_epoch + lease_seconds)
            job["updated_at"] = self._now()
            self._write_job(job)
            return job

    def heartbeat(self, job_id: str, worker_id: str, lease_seconds: int = 900):
        lease_seconds = max(30, int(lease_seconds))
        now_epoch = int(time.time())

        with self._locked():
            job = self._read_job(job_id)
            if not job:
                return None
            if job.get("lease_owner") != worker_id:
                raise PermissionError("Lease owner mismatch")
            if job.get("status") not in {"leased", "running"}:
                raise ValueError("Job is not active")

            job["status"] = "running"
            job["lease_until"] = str(now_epoch + lease_seconds)
            job["updated_at"] = self._now()
            self._write_job(job)
            return job

    def fail_job(self, job_id: str, worker_id: str, error: str):
        with self._locked():
            job = self._read_job(job_id)
            if not job:
                return None
            if job.get("lease_owner") != worker_id:
                raise PermissionError("Lease owner mismatch")

            job["status"] = "failed"
            job["error"] = (error or "Unknown error")[:4000]
            job["lease_until"] = None
            job["updated_at"] = self._now()
            self._write_job(job)
            return job

    def complete_job(self, job_id: str, worker_id: str, result_mask_path: str, result_csv_path: str | None = None):
        if not os.path.exists(result_mask_path):
            raise FileNotFoundError(f"Result mask not found: {result_mask_path}")
        if result_csv_path and not os.path.exists(result_csv_path):
            raise FileNotFoundError(f"Result CSV not found: {result_csv_path}")

        with self._locked():
            job = self._read_job(job_id)
            if not job:
                return None
            if job.get("lease_owner") != worker_id:
                raise PermissionError("Lease owner mismatch")

            safe_job_id = str(uuid.UUID(str(job["job_id"])))
            result_dir = os.path.join(self.results_dir, safe_job_id)
            os.makedirs(result_dir, exist_ok=True)

            mask_dest = os.path.join(result_dir, "combined_labels.nii.gz")
            # Workers upload the model's own label ids (run_epai_worker.sh
            # copies the raw nnU-Net prediction). Rewrite a copy into viewer
            # ids with the same map the in-process runner uses. The upload stays
            # raw and every result post makes a fresh copy, so a repeated post
            # converts once too. Never the PanTS dataset table: that is for
            # dataset masks only. The copy is converted beside the result and
            # only then moved over it, so a bad repeat post leaves an earlier
            # good result untouched.
            from services.auto_segmentor import MODEL_TO_VIEWER, _remap_combined_labels
            label_map = MODEL_TO_VIEWER.get(job.get("model"))
            staged = os.path.join(result_dir, f".incoming-{uuid.uuid4().hex}.nii.gz")
            shutil.copy2(result_mask_path, staged)
            try:
                if label_map is not None:
                    try:
                        _remap_combined_labels(staged, label_map)
                    except (OSError, MemoryError):
                        raise
                    except Exception as e:
                        raise ValueError(f"Result mask is not a readable NIfTI: {e}") from e
                os.replace(staged, mask_dest)
            finally:
                if os.path.exists(staged):
                    os.remove(staged)

            csv_dest = None
            if result_csv_path:
                csv_dest = os.path.join(result_dir, "output.csv")
                shutil.copy2(result_csv_path, csv_dest)

            zip_dest = os.path.join(result_dir, "auto_masks.zip")
            with zipfile.ZipFile(zip_dest, "w", zipfile.ZIP_DEFLATED) as zipf:
                zipf.write(mask_dest, arcname="combined_labels.nii.gz")
                if csv_dest and os.path.exists(csv_dest):
                    zipf.write(csv_dest, arcname="output.csv")

            job["status"] = "succeeded"
            job["error"] = None
            job["lease_until"] = None
            job["updated_at"] = self._now()
            job["result_mask_path"] = mask_dest
            job["result_csv_path"] = csv_dest
            job["result_zip_path"] = zip_dest
            self._write_job(job)
            return job
