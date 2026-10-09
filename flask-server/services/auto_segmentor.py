import contextlib
import os
import uuid
import signal
import subprocess
import re
import csv
import shlex
import shutil
import threading
from dotenv import load_dotenv

from services import gpu_workers

# Load environment variables
load_dotenv()

def _is_truthy(value) -> bool:
    return gpu_workers._truthy(value)


def max_parallel_jobs() -> int:
    """How many model jobs may run at once.

    1 (strictly one at a time, as before) unless GPU workers are enabled and
    GPU_WORKER_PARALLEL asks for more; never more than there are workers, since
    each worker runs one job at a time, and 1 while the older EPAI_REMOTE_ENABLED
    mode is on. Read once at import.
    """
    if not gpu_workers.enabled():
        return 1
    if _is_truthy(os.getenv("EPAI_REMOTE_ENABLED", "false")):
        # The older explicit single-host ePAI mode sends every ePAI job to one
        # fixed GPU outside the worker pool; only serial jobs are safe there.
        return 1
    try:
        wanted = int(os.getenv("GPU_WORKER_PARALLEL", "1"))
    except ValueError:
        wanted = 1
    return max(1, min(wanted, len(gpu_workers.hosts())))


# A job holds one of these slots for its whole run, so concurrent requests queue
# instead of OOM-ing a GPU. One slot = the old single global lock.
_job_slots = threading.BoundedSemaphore(max_parallel_jobs())

# bdmap1's own GPU runs at most one model at a time, however many jobs are in
# flight: it is the machine that serves the website (shared CPU/GPU memory), so
# fallback jobs queue here rather than pile onto it.
_local_gpu_lock = threading.Lock()


_session_locks = {}  # session id -> [lock, waiters+holder count]


@contextlib.contextmanager
def _session_exclusive(session_id):
    """A session never runs against itself.

    A repeat request (a retry, a double click) for a session whose job is still
    queued or running used to serialize behind it on the single global lock.
    With several jobs in flight it would overlap it, two runs writing the same
    workspace, outputs, process entry and job state. It waits here instead, and
    it does so before taking a job slot, so a waiting duplicate costs no capacity.
    """
    if not session_id:
        yield
        return
    with _session_procs_lock:
        entry = _session_locks.setdefault(session_id, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _session_procs_lock:
            entry[1] -= 1
            if entry[1] == 0:
                _session_locks.pop(session_id, None)


# Where each session's model commands ran, for services/job_run_log: session id
# -> {"ran_on": [short host names], "fell_back": bool}. The API layer takes it
# with pop_run_info() when the job ends. Bookkeeping only; never affects a run.
_run_info = {}


def _note_run(session_id, host, fell_back=False):
    if not session_id or not host:
        return
    with _session_procs_lock:
        if len(_run_info) > 1000:  # a caller that never pops must not grow this forever
            _run_info.pop(next(iter(_run_info)), None)
        info = _run_info.setdefault(session_id, {"ran_on": [], "fell_back": False})
        short = str(host).split(".")[0]
        if short not in info["ran_on"]:
            info["ran_on"].append(short)
        info["fell_back"] = info["fell_back"] or bool(fell_back)


def pop_run_info(session_id):
    """The machines this session's model commands ran on (and whether any fell
    back to the web host), or {} if none were recorded. Removes the entry."""
    with _session_procs_lock:
        return _run_info.pop(session_id, None) or {}


def _current_session_cancelled() -> bool:
    sid = getattr(_thread_session, "sid", None)
    return bool(sid) and sid in _cancelled_sessions


@contextlib.contextmanager
def _local_gpu_slot(cancelled):
    """Hold the web host's GPU for one local model run; cancellable while waiting."""
    while not _local_gpu_lock.acquire(timeout=1.0):
        if cancelled():
            raise RuntimeError("Inference cancelled")
    try:
        # Also covers a cancel that landed while waiting but just as the lock
        # came free (no process existed to kill), and a lock that was free.
        if cancelled():
            raise RuntimeError("Inference cancelled")
        yield
    finally:
        _local_gpu_lock.release()

# ── Per-session subprocess tracking (for user-initiated cancel) ──
# Each session's worker thread binds its session id thread-locally; _tracked_run
# then registers the live Popen under that id so /api/cancel-inference/<sid>
# can kill exactly that session's process group and nobody else's.
_session_procs = {}
_session_procs_lock = threading.Lock()
# Sessions the user cancelled. Lets a remote GPU-worker run stop between its
# sync/preflight/run phases, when there is no local process to signal yet.
# Only recorded for a session whose job holds the GPU slot (_active_sessions);
# a queued job is stopped by its on_start status check instead, and a cancel
# after the job ended must not poison a later run of the same session.
_cancelled_sessions = set()
_active_sessions = {}  # session id -> token of the run holding the GPU slot
_thread_session = threading.local()


def bind_session(session_id):
    """Associate the calling worker thread with a session id."""
    _thread_session.sid = session_id


def _tracked_run(cmd, check=False, capture_output=False, **kwargs):
    """Drop-in for subprocess.run that makes the child killable per-session.

    Starts the child in its own process group (start_new_session) and registers
    it under the thread's bound session id for cancel_session(). Mirrors the
    subprocess.run semantics used in this module (check / capture_output /
    shell / executable / cwd / stdout / stderr / text).
    """
    if capture_output:
        kwargs.setdefault("stdout", subprocess.PIPE)
        kwargs.setdefault("stderr", subprocess.PIPE)
    kwargs.setdefault("start_new_session", True)
    sid = getattr(_thread_session, "sid", None)

    # Model commands (shell strings) run on a remote GPU worker when enabled,
    # so bdmap1's GPU stays free. Any remote problem other than a user cancel
    # ends in the normal local run below, so the remote path can never fail a
    # job that a local run would complete.
    retry_of = None  # worker whose failed run the local run below re-does
    remote_attempted = False
    remote_dir = getattr(_thread_session, "remote_session_dir", None)
    if remote_dir and kwargs.get("shell") and isinstance(cmd, str) and gpu_workers.enabled():
        remote_attempted = True
        registered = []

        def _register(argv):
            # A caller that did not redirect stderr (most model runs) would leave
            # the worker's error text only in the server log, where the decision
            # to re-run locally cannot see it (e.g. "CUDA out of memory" on a
            # scan too big for the GPU). Capture it on our side; run_on_worker
            # writes it to the log and hands the caller the result it expects.
            own_stderr = kwargs.get("stderr") is None
            ssh_proc = subprocess.Popen(
                argv,
                stdout=kwargs.get("stdout"),
                stderr=subprocess.PIPE if own_stderr else kwargs.get("stderr"),
                text=kwargs.get("text"), start_new_session=True,
            )
            ssh_proc.gw_own_stderr = own_stderr
            registered.append(ssh_proc)
            if sid:
                with _session_procs_lock:
                    _session_procs[sid] = ssh_proc
            return ssh_proc

        def _cancelled():
            return bool(sid) and sid in _cancelled_sessions

        try:
            result = gpu_workers.run(cmd, remote_dir, kwargs.get("cwd"), _register, _cancelled)
        except gpu_workers.WorkerCancelled as e:
            raise RuntimeError("Inference cancelled") from e
        except Exception as e:
            # WorkerUnavailable (nothing ran), RemoteRunFailed (a remote run
            # failed, hung or lost its results) or an unexpected error in the
            # dispatch code itself: all end in the local run below.
            known = (gpu_workers.WorkerUnavailable, gpu_workers.RemoteRunFailed)
            if registered and not isinstance(e, known):
                # Unexpected error after the remote start: leave nothing running there.
                kill = getattr(registered[-1], "kill_remote", None)
                if kill is not None:
                    kill()
            if _cancelled():
                raise RuntimeError("Inference cancelled") from e
            if isinstance(e, gpu_workers.RemoteRunFailed) and not e.retry_locally:
                # E.g. the scan does not fit in GPU memory: a local re-run would
                # fail the same way and could hang the web host. Fail the job
                # exactly as the local run would have.
                print(f"[gpu_workers] {e}; not re-running locally")
                _note_run(sid, e.host)
                if check:
                    raise subprocess.CalledProcessError(
                        e.returncode or 1, cmd, output=e.output, stderr=e.output) from e
                return subprocess.CompletedProcess(cmd, e.returncode or 1, "", e.output)
            if not gpu_workers.local_fallback_allowed():
                raise RuntimeError(f"GPU worker run failed and local fallback is disabled: {e}") from e
            if isinstance(e, gpu_workers.RemoteRunFailed):
                retry_of = e.host
            elif not isinstance(e, gpu_workers.WorkerUnavailable):
                print(f"[gpu_workers] unexpected dispatch error: {e!r}")
            print(f"[gpu_workers] {e}; running locally on this host")
        else:
            _note_run(sid, getattr(result, "host", None))
            if check and result.returncode != 0:
                raise subprocess.CalledProcessError(result.returncode, cmd, output=result.stdout, stderr=result.stderr)
            return result
        finally:
            if sid and registered:
                with _session_procs_lock:
                    if _session_procs.get(sid) is registered[-1]:
                        _session_procs.pop(sid, None)

    is_model_cmd = bool(remote_dir) and bool(kwargs.get("shell")) and isinstance(cmd, str)
    if is_model_cmd and gpu_workers.enabled():
        local_slot = _local_gpu_slot(_current_session_cancelled)
    else:
        local_slot = contextlib.nullcontext()
    with local_slot:
        proc = subprocess.Popen(cmd, **kwargs)
        if sid:
            with _session_procs_lock:
                _session_procs[sid] = proc
        try:
            stdout, stderr = proc.communicate()
        finally:
            if sid:
                with _session_procs_lock:
                    if _session_procs.get(sid) is proc:
                        _session_procs.pop(sid, None)
    if is_model_cmd:
        # Ran on this host: either workers are off, or this is a fallback.
        _note_run(sid, gpu_workers._local_hostname(), fell_back=remote_attempted)
    if retry_of and proc.returncode == 0:
        # Local succeeded where the worker failed: the worker is at fault.
        gpu_workers.mark_failed(retry_of)
        print(f"[gpu_workers] {retry_of} failed a job that ran fine locally; skipping it for a while")
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def cancel_session(session_id):
    """Best-effort kill of one session's inference subprocess (SIGTERM the
    process group, SIGKILL 5s later if it ignores that). Returns True if a
    live process was signalled. Safe to call for queued/unknown sessions."""
    with _session_procs_lock:
        proc = _session_procs.get(session_id)
        if session_id in _active_sessions:
            _cancelled_sessions.add(session_id)
    if not proc or proc.poll() is not None:
        return False
    kill_remote = getattr(proc, "kill_remote", None)
    if kill_remote is not None:
        # Remote job: killing the local ssh alone would orphan the remote
        # process tree, so signal it on the worker as well.
        threading.Thread(target=kill_remote, daemon=True).start()
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)

        def _force_kill():
            try:
                proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except Exception:
                    pass

        threading.Thread(target=_force_kill, daemon=True).start()
        return True
    except Exception as e:
        print(f"[cancel] failed to kill process for session {session_id}: {e}")
        return False


def cancel_all_inference():
    """Kill every tracked inference subprocess (admin 'stop everything').
    Prefer cancel_session() for a single user's job; this is the blunt
    kill-all kept for the global /cancel-inference endpoint."""
    with _session_procs_lock:
        sids = list(_session_procs.keys())
    for sid in sids:
        cancel_session(sid)

def get_least_used_gpu(default_gpu=None):
    if default_gpu is None:
        try:
            available_gpus_str = os.getenv("AVAILABLE_GPUS", "")
            available_gpus = [int(x) for x in available_gpus_str.split(",") if x.strip().isdigit()]
            if not available_gpus:
                raise ValueError("No available GPUs specified.")

            result = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                universal_newlines=True
            )
            mem_usages = [int(x) for x in result.strip().split("\n")]
            least_used_gpu = min(available_gpus, key=lambda i: mem_usages[i])
            return str(least_used_gpu)
        except Exception as e:
            print("⚠️ Failed to get GPU info, defaulting to 0:", e)
            return "0"
    else:
        return str(default_gpu)


def _resolve_conda_exe():
    """Locate the conda binary.

    gunicorn on the server runs without a login shell, so it does not pick up
    the PATH that conda's shell init exports. shutil.which("conda") therefore
    returns nothing there even though conda is installed and working.

    Half the runners in this file already worked around that with a hardcoded
    fallback and half raised instead, which is why ePAI, Atlas-Net and
    LesionSegmenter failed while OpenVAE and MedFormer kept working. Same box,
    same conda, different error handling.

    Override with CONDA_EXE_PATH if conda lives somewhere not listed here.
    """
    explicit = os.path.expanduser(os.getenv("CONDA_EXE_PATH", "").strip())
    if explicit and os.path.exists(explicit):
        return explicit

    found = shutil.which("conda")
    if found:
        return found

    for candidate in (
        "/home/apps/anaconda3/condabin/conda",
        "/home/visitor/miniconda3/condabin/conda",
        "/home/visitor/anaconda3/condabin/conda",
        "/opt/conda/condabin/conda",
        "/opt/anaconda3/condabin/conda",
        "/root/miniconda3/condabin/conda",
    ):
        if os.path.exists(candidate):
            return candidate
    return ""


def _env_command(env_name, binary="python"):
    """Shell-safe prefix that runs `binary` inside conda env `env_name`.

    Prefers the env's own binary (~/.conda/envs/<env>/bin/<binary>). That needs
    neither conda on PATH nor an env activation, and it is why LesionSegmenter
    kept working on the server while every other model failed with "Could not
    find conda": gunicorn runs without a login shell, so it never inherits the
    PATH conda's init exports.

    Falls back to `conda run -n <env> <binary>` when the binary is not where
    conda conventionally puts it, so a differently-configured box degrades to
    the old behaviour instead of breaking.

    Set CONDA_ENVS_DIR if envs do not live under ~/.conda/envs.
    """
    envs_dir = os.path.expanduser(
        os.getenv("CONDA_ENVS_DIR", "").strip() or "~/.conda/envs"
    )
    direct = os.path.join(envs_dir, env_name, "bin", binary)
    if os.path.exists(direct):
        return shlex.quote(direct)

    conda_exe = _resolve_conda_exe()
    if not conda_exe:
        raise RuntimeError(
            f"Could not run '{binary}' in conda env '{env_name}'. Looked for "
            f"{direct} and could not find conda on PATH either. Set "
            f"CONDA_ENVS_DIR or CONDA_EXE_PATH."
        )
    return f"{shlex.quote(conda_exe)} run -n {shlex.quote(env_name)} {shlex.quote(binary)}"


def _resolve_conda_activate_path():
    candidates = [
        os.path.expanduser(os.getenv("CONDA_ACTIVATE_PATH", "").strip()),
        "/root/miniconda3/etc/profile.d/conda.sh",
        "/root/anaconda3/etc/profile.d/conda.sh",
        "/home/visitor/miniconda3/etc/profile.d/conda.sh",
        "/home/visitor/anaconda3/etc/profile.d/conda.sh",
        "/opt/conda/etc/profile.d/conda.sh",
        "/opt/anaconda3/etc/profile.d/conda.sh",
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return ""


def run_auto_segmentation(input_path, session_dir, model, session_id=None, on_start=None):
    """Run one model; see _run_auto_segmentation. Always clears per-job state."""
    token = object()
    with _session_exclusive(session_id):
        try:
            return _run_auto_segmentation(input_path, session_dir, model, session_id, on_start, token)
        finally:
            _thread_session.remote_session_dir = None
            if session_id:
                with _session_procs_lock:
                    # Only clear our own state.
                    if _active_sessions.get(session_id) is token:
                        del _active_sessions[session_id]
                        _cancelled_sessions.discard(session_id)


def _run_auto_segmentation(input_path, session_dir, model, session_id=None, on_start=None, token=None):
    """
    Dispatch to the appropriate model inference function.
    Limited by _job_slots (one at a time unless GPU workers allow more), so
    concurrent requests queue instead of OOM-ing.
    Returns the output directory path on success, raises on failure.

    session_id: binds this worker thread so _tracked_run/cancel_session can
        target its subprocesses. on_start: called once the GPU slot is
        acquired (i.e. the job leaves the queue); returning False aborts the
        run (used when the user cancelled while the job was still queued) and
        makes this function return None.
    """
    with _job_slots:
        if session_id:
            # Before on_start: a cancel landing after its status check is
            # still recorded. A flag left from an earlier run is dropped.
            with _session_procs_lock:
                _cancelled_sessions.discard(session_id)
                _active_sessions[session_id] = token if token is not None else object()
        if on_start is not None:
            try:
                if on_start() is False:
                    return None
            except Exception as e:
                print(f"[on_start] callback error for {session_id}: {e}")
        if session_id:
            bind_session(session_id)
        # GPU models may run on a remote worker (services/gpu_workers.py).
        # ShapeKit is CPU post-processing and stays local.
        # Keep the path exactly as the model commands spell it (it can contain
        # "api/../.."); gpu_workers recreates it on the worker.
        # (os.path.abspath would normalize the "..", so join without it.)
        raw_session_dir = (
            session_dir if os.path.isabs(session_dir)
            else os.path.join(os.getcwd(), session_dir)
        )
        _thread_session.remote_session_dir = raw_session_dir if model != 'ShapeKit' else None
        if model == 'ePAI':
            conda_path = _resolve_conda_activate_path()
            return _run_epai_inference(
                input_path=input_path,
                session_dir=session_dir,
                conda_path=conda_path,
                epai_env_name=os.getenv("CONDA_ENV_EPAI", "epai"),
                fallback_script_path=os.getenv("EPAI_SCRIPT_PATH", ""),
            )
        elif model == 'SuPreM':
            return _run_suprem_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'OpenVAE':
            return _run_openvae_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'MedFormer':
            return _run_medformer_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'R-Super':
            return _run_rsuper_inference(input_path=input_path, session_dir=session_dir)
        elif model == 'Atlas-Net':
            conda_path = _resolve_conda_activate_path()
            return _run_atlasnet_inference(
                input_path=input_path,
                session_dir=session_dir,
                conda_path=conda_path,
                atlasnet_env_name=os.getenv("CONDA_ENV_ATLASNET", "epai"),
            )
        elif model == 'ShapeKit':
            return _run_shapekit_inference(input_dir=input_path, session_dir=session_dir)
        elif model == 'LesionSegmenter':
            conda_path = _resolve_conda_activate_path()
            return _run_lesionsegmenter_inference(
                input_path=input_path,
                session_dir=session_dir,
                conda_path=conda_path,
                lesionseg_env_name=os.getenv("CONDA_ENV_LESIONSEG", "epai"),
            )
        elif model == "MedIA-Agentic-Organs":
            return _run_media_agentic_inference(input_path=input_path, session_dir=session_dir, model_type="organs")
        elif model == "MedIA-Agentic-Vertebrae":
            return _run_media_agentic_inference(input_path=input_path, session_dir=session_dir, model_type="vertebrae")
        else:
            raise ValueError(f"Unknown model: {model}")


# Viewer label scheme (constants.ts segmentation_categories, 1-indexed)
_VIEWER_LABELS = {
    "adrenal_gland_left": 1, "adrenal_gland_right": 2, "aorta": 3,
    "bladder": 4, "celiac_artery": 5, "colon": 6, "common_bile_duct": 7,
    "duodenum": 8, "femur_left": 9, "femur_right": 10, "gall_bladder": 11,
    "kidney_left": 12, "kidney_right": 13, "liver": 14,
    "lung_left": 15, "lung_right": 16, "pancreas": 17,
    "pancreas_body": 18, "pancreas_head": 19, "pancreas_tail": 20,
    "pancreatic_duct": 21, "pancreatic_lesion": 22, "postcava": 23,
    "prostate": 24, "spleen": 25, "stomach": 26,
    "superior_mesenteric_artery": 27, "veins": 28,
    # extended labels for full ePAI output
    "intestine": 29, "renal_vein_left": 30, "renal_vein_right": 31, "cbd_stent": 32,
    # LesionSegmenter extra lesion classes (pancreatic_lesion already at 22)
    "liver_lesion": 33, "kidney_lesion": 34, "colon_lesion": 35,
}

# ePAI model label → viewer label (all 25 classes from dataset.json)
_EPAI_TO_VIEWER = {
    1:  _VIEWER_LABELS["aorta"],
    2:  _VIEWER_LABELS["adrenal_gland_left"],
    3:  _VIEWER_LABELS["adrenal_gland_right"],
    4:  _VIEWER_LABELS["common_bile_duct"],
    5:  _VIEWER_LABELS["celiac_artery"],
    6:  _VIEWER_LABELS["colon"],
    7:  _VIEWER_LABELS["duodenum"],
    8:  _VIEWER_LABELS["gall_bladder"],
    9:  _VIEWER_LABELS["postcava"],
    10: _VIEWER_LABELS["kidney_left"],
    11: _VIEWER_LABELS["kidney_right"],
    12: _VIEWER_LABELS["liver"],
    13: _VIEWER_LABELS["pancreas"],
    14: _VIEWER_LABELS["pancreatic_duct"],
    15: _VIEWER_LABELS["superior_mesenteric_artery"],
    16: _VIEWER_LABELS["intestine"],
    17: _VIEWER_LABELS["spleen"],
    18: _VIEWER_LABELS["stomach"],
    19: _VIEWER_LABELS["veins"],
    20: _VIEWER_LABELS["renal_vein_left"],
    21: _VIEWER_LABELS["renal_vein_right"],
    22: _VIEWER_LABELS["cbd_stent"],
    23: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pdac
    24: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_cyst
    25: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pnet
}

# Atlas-Net model label → viewer label (from dataset.json)
_ATLASNET_TO_VIEWER = {
    1: _VIEWER_LABELS["aorta"],
    2: _VIEWER_LABELS["adrenal_gland_left"],
    3: _VIEWER_LABELS["adrenal_gland_right"],
    4: _VIEWER_LABELS["common_bile_duct"],
    5: _VIEWER_LABELS["celiac_artery"],       # celiac_aa
    6: _VIEWER_LABELS["colon"],
    7: _VIEWER_LABELS["duodenum"],
    8: _VIEWER_LABELS["gall_bladder"],
    9: _VIEWER_LABELS["postcava"],
    10: _VIEWER_LABELS["kidney_left"],
    11: _VIEWER_LABELS["kidney_right"],
    12: _VIEWER_LABELS["liver"],
    13: _VIEWER_LABELS["pancreas"],
    14: _VIEWER_LABELS["pancreatic_duct"],
    15: _VIEWER_LABELS["superior_mesenteric_artery"],
    16: _VIEWER_LABELS["colon"],              # intestine (small intestine)
    17: _VIEWER_LABELS["spleen"],
    18: _VIEWER_LABELS["stomach"],
    19: _VIEWER_LABELS["veins"],
    20: _VIEWER_LABELS["veins"],              # renal_vein_left
    21: _VIEWER_LABELS["veins"],              # renal_vein_right
    # 22: cbd_stent — no viewer equivalent
    23: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pdac
    24: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_cyst
    25: _VIEWER_LABELS["pancreatic_lesion"],  # pancreatic_pnet
}

# SuPreM model label → viewer label
_SUPREM_TO_VIEWER = {
    1: _VIEWER_LABELS["spleen"],
    2: _VIEWER_LABELS["kidney_right"],
    3: _VIEWER_LABELS["kidney_left"],
    4: _VIEWER_LABELS["gall_bladder"],
    6: _VIEWER_LABELS["liver"],
    7: _VIEWER_LABELS["stomach"],
    8: _VIEWER_LABELS["aorta"],
    9: _VIEWER_LABELS["postcava"],
    11: _VIEWER_LABELS["pancreas"],
    12: _VIEWER_LABELS["adrenal_gland_right"],
    13: _VIEWER_LABELS["adrenal_gland_left"],
    14: _VIEWER_LABELS["duodenum"],
    16: _VIEWER_LABELS["lung_right"],
    17: _VIEWER_LABELS["lung_left"],
    18: _VIEWER_LABELS["colon"],
    21: _VIEWER_LABELS["bladder"],
    22: _VIEWER_LABELS["prostate"],
    23: _VIEWER_LABELS["femur_left"],
    24: _VIEWER_LABELS["femur_right"],
    25: _VIEWER_LABELS["celiac_artery"],
}
    
    # MedIA-Agentic Organs model (cads551) label → viewer label
# Model outputs: 1=spleen, 2=kidney_right, 3=kidney_left, 4=gallbladder, 5=liver,
# 6=stomach, 7=aorta, 8=inferior_vena_cava, 9=portal_vein_and_splenic_vein,
# 10=pancreas, 11=adrenal_gland_right, 12=adrenal_gland_left, 13-17=lung lobes
_MEDIA_AGENTIC_ORGANS_TO_VIEWER = {
    1: _VIEWER_LABELS["spleen"],
    2: _VIEWER_LABELS["kidney_right"],
    3: _VIEWER_LABELS["kidney_left"],
    4: _VIEWER_LABELS["gall_bladder"],
    5: _VIEWER_LABELS["liver"],
    6: _VIEWER_LABELS["stomach"],
    7: _VIEWER_LABELS["aorta"],
    8: _VIEWER_LABELS["postcava"],  # inferior_vena_cava
    9: _VIEWER_LABELS["veins"],  # portal_vein_and_splenic_vein
    10: _VIEWER_LABELS["pancreas"],
    11: _VIEWER_LABELS["adrenal_gland_right"],
    12: _VIEWER_LABELS["adrenal_gland_left"],
    13: _VIEWER_LABELS["lung_right"],  # lung_upper_lobe_left
    14: _VIEWER_LABELS["lung_right"],  # lung_lower_lobe_left
    15: _VIEWER_LABELS["lung_left"],  # lung_upper_lobe_right
    16: _VIEWER_LABELS["lung_left"],  # lung_middle_lobe_right
    17: _VIEWER_LABELS["lung_left"],  # lung_lower_lobe_right
}

# MedIA-Agentic Vertebrae model (cads552) label → viewer label
# Model outputs: 1=L5, 2=L4, 3=L3, 4=L2, 5=L1, 6=T12...17=T1, 18=C7...24=C1
# Viewer vertebrae labels: L5=33, L4=34, ... C1=56
_MEDIA_AGENTIC_VERTEBRAE_TO_VIEWER = {
    1: 33, 2: 34, 3: 35, 4: 36, 5: 37,  # L5-L1
    6: 38, 7: 39, 8: 40, 9: 41, 10: 42, 11: 43, 12: 44, 13: 45, 14: 46, 15: 47, 16: 48, 17: 49,  # T12-T1
    18: 50, 19: 51, 20: 52, 21: 53, 22: 54, 23: 55, 24: 56,  # C7-C1
}

# LesionSegmenter model label -> viewer label (43-class PanTS label space).
# Only classes with a confident 1:1 match in the viewer's scheme are mapped.
# NOT mapped (no viewer category exists yet, left as background rather than
# guessing at a slot and risking a mislabeled structure): esophagus, rectum,
# vertebrae_* (10 classes), trachea, heart, hip_left, hip_right, sacrum,
# uterus. pancreatic_lesion maps onto the same viewer slot ePAI and Atlas-Net
# use for their PDAC/cyst/PNET subtypes. liver_lesion/kidney_lesion/colon_lesion
# get their own viewer slots (33/34/35) -- this single model already computes all
# four lesions in one forward pass, so surfacing the other three is free at
# runtime. NOTE: only pancreatic_lesion has ground-truth validation on PanTS;
# the other three are surfaced but flagged experimental in the UI.
_LESIONSEG_TO_VIEWER = {
    1: _VIEWER_LABELS["aorta"],
    2: _VIEWER_LABELS["gall_bladder"],
    3: _VIEWER_LABELS["kidney_left"],
    4: _VIEWER_LABELS["kidney_right"],
    5: _VIEWER_LABELS["liver"],
    6: _VIEWER_LABELS["pancreas_body"],
    7: _VIEWER_LABELS["pancreas_head"],
    8: _VIEWER_LABELS["pancreas_tail"],
    9: _VIEWER_LABELS["postcava"],
    10: _VIEWER_LABELS["spleen"],
    11: _VIEWER_LABELS["stomach"],
    12: _VIEWER_LABELS["adrenal_gland_left"],
    13: _VIEWER_LABELS["adrenal_gland_right"],
    14: _VIEWER_LABELS["bladder"],
    15: _VIEWER_LABELS["celiac_artery"],  # celiac_trunk -> celiac_artery
    16: _VIEWER_LABELS["colon"],
    17: _VIEWER_LABELS["duodenum"],
    19: _VIEWER_LABELS["prostate"],
    21: _VIEWER_LABELS["lung_left"],
    22: _VIEWER_LABELS["lung_right"],
    39: _VIEWER_LABELS["liver_lesion"],
    40: _VIEWER_LABELS["pancreatic_lesion"],
    41: _VIEWER_LABELS["kidney_lesion"],
    42: _VIEWER_LABELS["colon_lesion"],
}

# Every model whose raw output _remap_combined_labels rewrites into viewer ids,
# with the map it uses. The in-process runners below, the pull-worker queue and
# the session organ stats all go by this one table. Models missing from it keep
# their output as written, in-process and from a pull worker alike.
MODEL_TO_VIEWER = {
    "ePAI": _EPAI_TO_VIEWER,
    "Atlas-Net": _ATLASNET_TO_VIEWER,
    "SuPreM": _SUPREM_TO_VIEWER,
    "MedIA-Agentic-Organs": _MEDIA_AGENTIC_ORGANS_TO_VIEWER,
    "MedIA-Agentic-Vertebrae": _MEDIA_AGENTIC_VERTEBRAE_TO_VIEWER,
    "LesionSegmenter": _LESIONSEG_TO_VIEWER,
}


def _remap_combined_labels(nii_path: str, label_map: dict) -> None:
    """Remap integer labels in a NIfTI file in-place to match the viewer's scheme."""
    import nibabel as nib
    import numpy as np
    img = nib.load(nii_path)
    data = np.asarray(img.dataobj).copy()
    remapped = np.zeros_like(data)
    for src, dst in label_map.items():
        remapped[data == src] = dst
    nib.save(nib.Nifti1Image(remapped, img.affine, img.header), nii_path)


def _stage_nifti_gz(input_path: str, dest_path: str) -> None:
    """Point dest_path (always *_0000.nii.gz or ct.nii.gz) at input_path.

    input_path is usually already gzip-compressed, so a symlink is enough --
    cheap, no copy of a multi-hundred-MB CT. But uploads that arrive as a
    bare .nii (e.g. the local-NIfTI picker) are NOT gzipped; symlinking one
    of those under a .gz-suffixed name promises gzip bytes that aren't
    there, and every reader (nibabel, SimpleITK) fails with "not a gzip
    file" the moment a model tries to load it. Detect that case and
    actually convert instead of just renaming.
    """
    if os.path.lexists(dest_path):
        os.remove(dest_path)
    if input_path.endswith(".gz"):
        os.symlink(os.path.abspath(input_path), dest_path)
    else:
        import nibabel as nib
        nib.save(nib.load(input_path), dest_path)


def _normalize_case_id(input_path_or_filename: str) -> str:
    normalized_input = os.path.normpath(input_path_or_filename or "")
    parent_dir = os.path.basename(os.path.dirname(normalized_input))
    leaf_name = os.path.basename(normalized_input)

    if leaf_name.lower() in {"ct.nii", "ct.nii.gz"} and re.match(r"^BDMAP_\d+$", parent_dir):
        return parent_dir

    filename_no_ext = re.sub(r"(\.nii(\.gz)?)$", "", leaf_name, flags=re.IGNORECASE)
    if re.match(r"^BDMAP_\d+$", filename_no_ext):
        return filename_no_ext
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", filename_no_ext).strip("_")
    if cleaned:
        return f"CASE_{cleaned}"
    return f"CASE_{uuid.uuid4().hex[:8]}"


def _ensure_output_csv_template(output_csv_path: str, case_id: str):
    header_path = os.getenv("EPAI_OUTPUT_CSV_TEMPLATE", "/home/visitor/inference/output.csv")
    header = None
    if os.path.exists(header_path):
        with open(header_path, "r", newline="") as f:
            reader = csv.reader(f)
            header = next(reader, None)

    if not header:
        header = [
            "bdmap_id", "shape", "spacing", "pancreas_pr", "pancreas_pr_component_count", "pancreas_pr_voxel_size",
            "pancreas_pr_volume_size", "duct_pr", "duct_pr_component_count", "duct_pr_voxel_size", "duct_pr_volume_size",
            "PDAC_pr", "PDAC_pr_component_count", "PDAC_pr_voxel_size", "PDAC_pr_volume_size",
            "PDAC_pr_largest_component_largest_logit", "cyst_pr", "cyst_pr_component_count", "cyst_pr_voxel_size",
            "cyst_pr_volume_size", "cyst_pr_largest_component_largest_logit", "PNET_pr", "PNET_pr_component_count",
            "PNET_pr_voxel_size", "PNET_pr_volume_size", "PNET_pr_largest_component_largest_logit"
        ]

    with open(output_csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerow([case_id] + [""] * (len(header) - 1))


def _run_epai_inference(input_path: str, session_dir: str, conda_path: str, epai_env_name: str, fallback_script_path: str):
    case_id = _normalize_case_id(input_path)

    epai_workspace = os.path.join(session_dir, "epai")
    input_dir = os.path.join(epai_workspace, "eval")
    save_dir = os.path.join(epai_workspace, "out")
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(save_dir, exist_ok=True)

    nnunet_input = os.path.join(input_dir, f"{case_id}_0000.nii.gz")
    _stage_nifti_gz(input_path, nnunet_input)

    input_csv_path = os.path.join(epai_workspace, "input.csv")
    output_csv_path = os.path.join(epai_workspace, "output.csv")
    with open(input_csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["BDMAP ID"])
        writer.writerow([case_id])

    _ensure_output_csv_template(output_csv_path, case_id)

    ckpt_path = os.getenv(
        "EPAI_CKPT_PATH",
        "/home/visitor/ePAI/model/qchen76_2025_0421/nnUNetTrainer__nnUNetPlans__3d_fullres",
    )
    nnunet_raw = os.getenv("EPAI_NNUNET_RAW", "/home/visitor/ePAI/nnUNet/raw")
    nnunet_preprocessed = os.getenv("EPAI_NNUNET_PREPROCESSED", "/home/visitor/ePAI/nnUNet/preprocessed")
    nnunet_results = os.getenv("EPAI_NNUNET_RESULTS", "/home/visitor/ePAI/nnUNet/results")

    if _is_truthy(os.getenv("EPAI_REMOTE_ENABLED", "false")):
        _run_epai_remote_inference(
            case_id=case_id,
            input_path=input_path,
            input_csv_path=input_csv_path,
            output_csv_path=output_csv_path,
            save_dir=save_dir,
            ckpt_path=ckpt_path,
            nnunet_raw=nnunet_raw,
            nnunet_preprocessed=nnunet_preprocessed,
            nnunet_results=nnunet_results,
            epai_env_name=epai_env_name,
        )
    else:
        selected_gpu = get_least_used_gpu()

        if fallback_script_path and os.path.exists(fallback_script_path):
            script_cmd = [
                "bash", fallback_script_path, session_dir, case_id,
                input_dir, save_dir, input_csv_path, output_csv_path, ckpt_path,
            ]
            run_payload = f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} " + " ".join(shlex.quote(x) for x in script_cmd)
        else:
            run_payload = (
                f"export nnUNet_N_proc_DA={shlex.quote(os.getenv('EPAI_N_PROC_DA', '36'))} && "
                f"export nnUNet_raw={shlex.quote(nnunet_raw)} && "
                f"export nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} && "
                f"export nnUNet_results={shlex.quote(nnunet_results)} && "
                f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
                f"nnUNetv2_predict_from_modelfolder "
                f"-i {shlex.quote(input_dir)} "
                f"-o {shlex.quote(save_dir)} "
                f"-m {shlex.quote(ckpt_path)} "
                f"-f all "
                f"--input_csv {shlex.quote(input_csv_path)} "
                f"--output_csv {shlex.quote(output_csv_path)} "
                f"--continue_prediction "
                f"-npp {shlex.quote(os.getenv('EPAI_NPP', '3'))} "
                f"-nps {shlex.quote(os.getenv('EPAI_NPS', '3'))} "
                f"-num_parts 1 "
                f"-part_id 0 "
                f"-chk {shlex.quote(os.getenv('EPAI_CHECKPOINT_NAME', 'checkpoint_final.pth'))}"
            )

        if conda_path and os.path.exists(conda_path):
            full_cmd = (
                f"source {shlex.quote(conda_path)} && "
                f"conda activate {shlex.quote(epai_env_name)} && "
                f"{run_payload}"
            )
        else:
            if fallback_script_path and os.path.exists(fallback_script_path):
                conda_exe = _resolve_conda_exe()
                if not conda_exe:
                    raise RuntimeError(
                        "Could not find conda, needed to run the ePAI fallback script. "
                        "Set CONDA_EXE_PATH."
                    )
                script_cmd = [
                    "bash", fallback_script_path, session_dir, case_id,
                    input_dir, save_dir, input_csv_path, output_csv_path, ckpt_path,
                ]
                full_cmd = (
                    f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
                    f"{shlex.quote(conda_exe)} run -n {shlex.quote(epai_env_name)} "
                    + " ".join(shlex.quote(x) for x in script_cmd)
                )
            else:
                full_cmd = (
                    f"nnUNet_N_proc_DA={shlex.quote(os.getenv('EPAI_N_PROC_DA', '36'))} "
                    f"nnUNet_raw={shlex.quote(nnunet_raw)} "
                    f"nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} "
                    f"nnUNet_results={shlex.quote(nnunet_results)} "
                    f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
                    f"{_env_command(epai_env_name, 'nnUNetv2_predict_from_modelfolder')} "
                    f"-i {shlex.quote(input_dir)} "
                    f"-o {shlex.quote(save_dir)} "
                    f"-m {shlex.quote(ckpt_path)} "
                    f"-f all "
                    f"--input_csv {shlex.quote(input_csv_path)} "
                    f"--output_csv {shlex.quote(output_csv_path)} "
                    f"--continue_prediction "
                    f"-npp {shlex.quote(os.getenv('EPAI_NPP', '3'))} "
                    f"-nps {shlex.quote(os.getenv('EPAI_NPS', '3'))} "
                    f"-num_parts 1 "
                    f"-part_id 0 "
                    f"-chk {shlex.quote(os.getenv('EPAI_CHECKPOINT_NAME', 'checkpoint_final.pth'))}"
                )

        print(f"[INFO] Running ePAI command for case {case_id}")
        print(full_cmd)
        try:
            _tracked_run(
                full_cmd,
                shell=True,
                executable="/bin/bash",
                check=True,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                "ePAI inference command failed"
                f"\nCommand: {full_cmd}"
                f"\nExit code: {e.returncode}"
            ) from e

    case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    if not os.path.exists(case_pred):
        raise RuntimeError(f"Expected ePAI output not found: {case_pred}")

    output_ct_dir = os.path.join(session_dir, "outputs", "ct")
    os.makedirs(output_ct_dir, exist_ok=True)
    combined_label_path = os.path.join(output_ct_dir, "combined_labels.nii.gz")
    shutil.copy2(case_pred, combined_label_path)
    shutil.copy2(output_csv_path, os.path.join(output_ct_dir, "output.csv"))
    _remap_combined_labels(combined_label_path, _EPAI_TO_VIEWER)

    return output_ct_dir


def _run_suprem_inference(input_path: str, session_dir: str) -> str:
    """
    Run SuPreM segmentation natively using the extracted inference.py.

    Input layout:
        <session_dir>/suprem/inputs/ct/ct.nii.gz

    Output layout written by inference.py:
        <session_dir>/suprem/outputs/ct/combined_labels.nii.gz
        <session_dir>/suprem/outputs/ct/segmentations/*.nii.gz
    """
    suprem_workspace = os.path.join(session_dir, "suprem")
    input_case_dir = os.path.join(suprem_workspace, "inputs", "ct")
    output_dir = os.path.join(suprem_workspace, "outputs")
    os.makedirs(input_case_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    # inference.py expects the file named ct.nii.gz inside a case subfolder
    ct_link = os.path.join(input_case_dir, "ct.nii.gz")
    _stage_nifti_gz(input_path, ct_link)

    suprem_src = os.getenv("SUPREM_SRC_PATH", "/home/visitor/suprem_native/workspace/SuPreM")
    checkpoint = os.getenv(
        "SUPREM_CHECKPOINT_PATH",
        "/home/visitor/suprem_native/workspace/SuPreM/pretrained_checkpoints/supervised_suprem_unet_2100.pth",
    )
    conda_env = os.getenv("CONDA_ENV_SUPREM", "suprem")
    conda_exe = _resolve_conda_exe()
    selected_gpu = get_least_used_gpu()
    inputs_dir = os.path.join(suprem_workspace, "inputs")

    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"-W ignore {shlex.quote(os.path.join(suprem_src, 'inference.py'))} "
        f"--data_root_path {shlex.quote(inputs_dir)} "
        f"--save_dir {shlex.quote(output_dir)} "
        f"--resume {shlex.quote(checkpoint)} "
        f"--backbone unet "
        f"--store_result"
    )

    print(f"[INFO] Running SuPreM native inference")
    print(full_cmd)
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True,
                     cwd=suprem_src)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"SuPreM inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    case_output = os.path.join(output_dir, "ct")
    if not os.path.isdir(case_output):
        raise RuntimeError(f"SuPreM output directory not found: {case_output}")

    combined_label_path = os.path.join(case_output, "combined_labels.nii.gz")
    if os.path.exists(combined_label_path):
        _remap_combined_labels(combined_label_path, _SUPREM_TO_VIEWER)

    return case_output


def _run_openvae_inference(input_path: str, session_dir: str) -> str:
    """
    Run OpenVAE 3D reconstruction via sliding-window patch inference.

    Output layout:
        <session_dir>/openvae/reconstructed_ct.nii.gz
    """
    output_dir = os.path.join(session_dir, "openvae")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "reconstructed_ct.nii.gz")

    openvae_src = os.getenv("OPENVAE_SRC_PATH", "/home/visitor/openvae")
    checkpoint = os.getenv("OPENVAE_CHECKPOINT_PATH",
                           "/home/visitor/openvae/ckpt/OpenVAE-3D-4x-patch64-10K/autoencoder_best.pt")
    conda_env = os.getenv("CONDA_ENV_OPENVAE", "openvae")
    conda_exe = _resolve_conda_exe()
    selected_gpu = get_least_used_gpu()

    inference_script = os.path.join(openvae_src, "test", "test_3dvae.py")

    # Use fine-tuned OpenVAE weights if present; fall back to public MAISI checkpoint
    use_maisi_fallback = not os.path.exists(checkpoint)
    if use_maisi_fallback:
        print(f"[INFO] OpenVAE checkpoint not found at {checkpoint}; using --maisi_ckpt (public MONAI MAISI autoencoder)")
        ckpt_arg = "--maisi_ckpt"
        patch_arg = "--patch_size 80 80 80"
    else:
        ckpt_arg = f"--checkpoint {shlex.quote(checkpoint)}"
        patch_arg = "--patch_size 64 64 64"

    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"{shlex.quote(inference_script)} "
        f"--input {shlex.quote(os.path.abspath(input_path))} "
        f"{ckpt_arg} "
        f"--output {shlex.quote(output_path)} "
        f"{patch_arg} "
        f"--amp"
    )
    print(f"[INFO] Running OpenVAE inference\n{full_cmd}")
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True, cwd=openvae_src)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"OpenVAE inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    if not os.path.exists(output_path):
        raise RuntimeError(f"OpenVAE output not found: {output_path}")

    return output_dir


def _combine_medformer_masks(raw_save_path: str, bdmap_id: str, output_path: str):
    """
    Combine MedFormer's per-organ binary masks into a single combined_labels.nii.gz
    using the viewer's integer label scheme.
    """
    import glob
    import nibabel as nib
    import numpy as np

    # MedFormer appends dataset/model_name to save_path; use glob to find predictions dir
    pred_dirs = glob.glob(os.path.join(raw_save_path, "**", bdmap_id, "predictions"), recursive=True)
    if not pred_dirs:
        raise RuntimeError(f"No predictions directory found under {raw_save_path}")

    pred_dir = pred_dirs[0]
    mask_files = glob.glob(os.path.join(pred_dir, "*.nii.gz"))
    if not mask_files:
        raise RuntimeError(f"No mask files found in {pred_dir}")

    ref_img = nib.load(mask_files[0])
    combined = np.zeros(ref_img.shape, dtype=np.uint8)

    for mask_file in mask_files:
        organ_name = os.path.basename(mask_file).replace(".nii.gz", "")
        label_int = _VIEWER_LABELS.get(organ_name)
        if label_int is None:
            continue
        mask_data = np.asarray(nib.load(mask_file).dataobj)
        combined[mask_data > 0] = label_int

    nib.save(nib.Nifti1Image(combined, ref_img.affine, ref_img.header), output_path)


def _run_medformer_inference(input_path: str, session_dir: str) -> str:
    """
    Run MedFormer segmentation (26 abdominal structures + pancreatic lesion).
    Outputs combined_labels.nii.gz mapped to the viewer's label scheme.
    """
    output_dir = os.path.join(session_dir, "medformer")
    os.makedirs(output_dir, exist_ok=True)

    rsuper_src = os.getenv("RSUPER_SRC_PATH", "/home/visitor/rsuper/rsuper_train")
    checkpoint = os.getenv(
        "MEDFORMER_CHECKPOINT_PATH",
        "/home/visitor/rsuper/MedFormerPanTS/pants_pancreas_release/fold_0_latest.pth",
    )
    class_list = os.getenv(
        "MEDFORMER_CLASS_LIST",
        "/home/visitor/rsuper/MedFormerPanTS/labels_pants.yaml",
    )
    conda_env = os.getenv("CONDA_ENV_MEDFORMER", "rsuper")
    conda_exe = _resolve_conda_exe()
    selected_gpu = get_least_used_gpu()

    # MedFormer needs the filename to contain ".nii.gz" to enter the NIfTI branch;
    # stage input as a flat BDMAP_00000001.nii.gz directly in the input dir
    bdmap_id = "BDMAP_00000001"
    staging_dir = os.path.join(output_dir, "input")
    os.makedirs(staging_dir, exist_ok=True)
    staged_ct = os.path.join(staging_dir, f"{bdmap_id}.nii.gz")
    if not os.path.exists(staged_ct):
        shutil.copy2(input_path, staged_ct)

    raw_save_path = os.path.join(output_dir, "raw_output")
    os.makedirs(raw_save_path, exist_ok=True)

    inference_script = os.path.join(rsuper_src, "predict_abdomenatlas.py")
    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"{shlex.quote(inference_script)} "
        f"--load {shlex.quote(checkpoint)} "
        f"--img_path {shlex.quote(os.path.join(output_dir, 'input'))} "
        f"--class_list {shlex.quote(class_list)} "
        f"--save_path {shlex.quote(raw_save_path)} "
        f"--gpu {shlex.quote(selected_gpu)} "
        f"--organ_mask_on_lesion"
    )
    print(f"[INFO] Running MedFormer inference\n{full_cmd}")
    try:
        _tracked_run(
            full_cmd, shell=True, executable="/bin/bash", check=True, cwd=rsuper_src,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"MedFormer inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    combined_label_path = os.path.join(output_dir, "combined_labels.nii.gz")
    _combine_medformer_masks(raw_save_path, bdmap_id, combined_label_path)

    if not os.path.exists(combined_label_path):
        raise RuntimeError(f"MedFormer combined_labels not created at {combined_label_path}")

    return output_dir


def _run_rsuper_inference(input_path: str, session_dir: str) -> str:
    """
    Run R-Super (MedFormer + report supervision) segmentation.
    Same pipeline as MedFormer, different checkpoint trained on Merlin + PanTS reports.
    """
    output_dir = os.path.join(session_dir, "rsuper")
    os.makedirs(output_dir, exist_ok=True)

    rsuper_src = os.getenv("RSUPER_SRC_PATH", "/home/visitor/rsuper/rsuper_train")
    checkpoint = os.getenv(
        "RSUPER_CHECKPOINT_PATH",
        "/home/visitor/rsuper/R-SuperPanTSMerlin/merlin_pancreas_pants_release/fold_0_latest.pth",
    )
    class_list = os.getenv(
        "MEDFORMER_CLASS_LIST",
        "/home/visitor/rsuper/MedFormerPanTS/labels_pants.yaml",
    )
    conda_env = os.getenv("CONDA_ENV_MEDFORMER", "rsuper")
    conda_exe = _resolve_conda_exe()
    selected_gpu = get_least_used_gpu()

    bdmap_id = "BDMAP_00000001"
    staging_dir = os.path.join(output_dir, "input")
    os.makedirs(staging_dir, exist_ok=True)
    staged_ct = os.path.join(staging_dir, f"{bdmap_id}.nii.gz")
    if not os.path.exists(staged_ct):
        shutil.copy2(input_path, staged_ct)

    raw_save_path = os.path.join(output_dir, "raw_output")
    os.makedirs(raw_save_path, exist_ok=True)

    inference_script = os.path.join(rsuper_src, "predict_abdomenatlas.py")
    full_cmd = (
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(conda_env)} "
        f"{shlex.quote(inference_script)} "
        f"--load {shlex.quote(checkpoint)} "
        f"--img_path {shlex.quote(staging_dir)} "
        f"--class_list {shlex.quote(class_list)} "
        f"--save_path {shlex.quote(raw_save_path)} "
        f"--gpu {shlex.quote(selected_gpu)} "
        f"--organ_mask_on_lesion"
    )
    print(f"[INFO] Running R-Super inference\n{full_cmd}")
    try:
        _tracked_run(
            full_cmd, shell=True, executable="/bin/bash", check=True, cwd=rsuper_src,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"R-Super inference failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    combined_label_path = os.path.join(output_dir, "combined_labels.nii.gz")
    _combine_medformer_masks(raw_save_path, bdmap_id, combined_label_path)

    if not os.path.exists(combined_label_path):
        raise RuntimeError(f"R-Super combined_labels not created at {combined_label_path}")

    return output_dir


def _run_atlasnet_inference(input_path: str, session_dir: str, conda_path: str, atlasnet_env_name: str) -> str:
    case_id = _normalize_case_id(input_path)

    atlasnet_workspace = os.path.join(session_dir, "atlasnet")
    input_dir = os.path.join(atlasnet_workspace, "eval")
    save_dir = os.path.join(atlasnet_workspace, "out")
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(save_dir, exist_ok=True)

    nnunet_input = os.path.join(input_dir, f"{case_id}_0000.nii.gz")
    _stage_nifti_gz(input_path, nnunet_input)

    ckpt_path = os.getenv(
        "ATLASNET_CKPT_PATH",
        "/home/visitor/atlasnet/model/nnUNet_results/Dataset001_ATLASNet/nnUNetTrainer__nnUNetPlans__3d_fullres",
    )
    nnunet_raw = os.getenv("ATLASNET_NNUNET_RAW", "/home/visitor/atlasnet/nnUNet/raw")
    nnunet_preprocessed = os.getenv("ATLASNET_NNUNET_PREPROCESSED", "/home/visitor/atlasnet/nnUNet/preprocessed")
    nnunet_results = os.getenv("ATLASNET_NNUNET_RESULTS", "/home/visitor/atlasnet/nnUNet/results")

    selected_gpu = get_least_used_gpu()
    conda_exe = _resolve_conda_exe()
    if not conda_exe:
        raise RuntimeError("Could not find conda. Set CONDA_ACTIVATE_PATH or ensure `conda` is on PATH.")

    full_cmd = (
        f"nnUNet_raw={shlex.quote(nnunet_raw)} "
        f"nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} "
        f"nnUNet_results={shlex.quote(nnunet_results)} "
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{_env_command(atlasnet_env_name, 'nnUNetv2_predict_from_modelfolder')} "
        f"-i {shlex.quote(input_dir)} "
        f"-o {shlex.quote(save_dir)} "
        f"-m {shlex.quote(ckpt_path)} "
        f"-f all "
        f"-npp 2 -nps 2 "
        f"-chk checkpoint_final.pth"
    )

    print(f"[INFO] Running Atlas-Net command for case {case_id}")
    print(full_cmd)
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"Atlas-Net inference command failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    if not os.path.exists(case_pred):
        raise RuntimeError(f"Expected Atlas-Net output not found: {case_pred}")

    output_ct_dir = os.path.join(session_dir, "outputs", "ct")
    os.makedirs(output_ct_dir, exist_ok=True)
    combined_label_path = os.path.join(output_ct_dir, "combined_labels.nii.gz")
    shutil.copy2(case_pred, combined_label_path)
    _remap_combined_labels(combined_label_path, _ATLASNET_TO_VIEWER)

    return output_ct_dir


def _run_lesionsegmenter_inference(input_path: str, session_dir: str, conda_path: str, lesionseg_env_name: str) -> str:
    """LesionSegmenter: nnU-Net ResidualEncoderUNet-L, 43-class PanTS label space
    including pancreatic/liver/kidney/colon lesion.

    -step_size 0.7 and --disable_tta are not defaults elsewhere in this file --
    they're here because they were validated end-to-end against real ground
    truth on 229 held-out lesion-positive cases: 1x (no mirror-TTA) at step 0.7
    is statistically indistinguishable from the slow 8x-TTA/step-0.5 default
    (paired Dice delta not significant, 95% CI crosses zero) while running
    roughly 5x faster. Dropping either flag trades speed for nothing -- do not
    remove them to "be safe", the safety case is what's cited above.

    Runs scripts/lesionseg_predict.py instead of the bare nnUNetv2_predict_from_modelfolder
    CLI every other model here uses -- that CLI has no flag for GPU-accelerated export
    resampling, and this wrapper applies it (~26-42s -> ~1-6s on the export stage, no
    accuracy cost, see the script's own docstring). Directly measured on identical
    case/flags/environment: 2m18s (bare CLI) -> 1m5s (this wrapper) end to end. Still a
    fresh subprocess per request -- NOT the warm-predictor optimization, that's separate.
    """
    case_id = _normalize_case_id(input_path)

    lesionseg_workspace = os.path.join(session_dir, "lesionsegmenter")
    input_dir = os.path.join(lesionseg_workspace, "eval")
    save_dir = os.path.join(lesionseg_workspace, "out")
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(save_dir, exist_ok=True)

    nnunet_input = os.path.join(input_dir, f"{case_id}_0000.nii.gz")
    _stage_nifti_gz(input_path, nnunet_input)

    ckpt_path = os.getenv(
        "LESIONSEG_CKPT_PATH",
        "/home/visitor/lesionsegmenter/model/nnUNet_results/Dataset_LesionSegmenter/nnUNetTrainer__nnUNetPlans__3d_fullres",
    )
    nnunet_raw = os.getenv("LESIONSEG_NNUNET_RAW", "/home/visitor/lesionsegmenter/nnUNet/raw")
    nnunet_preprocessed = os.getenv("LESIONSEG_NNUNET_PREPROCESSED", "/home/visitor/lesionsegmenter/nnUNet/preprocessed")
    nnunet_results = os.getenv("LESIONSEG_NNUNET_RESULTS", "/home/visitor/lesionsegmenter/nnUNet/results")

    selected_gpu = get_least_used_gpu()
    predict_script = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts", "lesionseg_predict.py")

    # `conda run -n <env> python ...` re-resolves and activates the environment on every
    # single request -- measured at ~1.75s of pure overhead versus calling that env's
    # python binary directly (0.013s). Paid once per request just like the cold model
    # load, so it's worth skipping. Falls back to `conda run` if the env's binary isn't
    # where conda envs conventionally live (e.g. a differently-configured deployment),
    # so this degrades to the previous behavior rather than breaking outright.
    run_prefix = _env_command(lesionseg_env_name)

    full_cmd = (
        f"nnUNet_raw={shlex.quote(nnunet_raw)} "
        f"nnUNet_preprocessed={shlex.quote(nnunet_preprocessed)} "
        f"nnUNet_results={shlex.quote(nnunet_results)} "
        f"CUDA_VISIBLE_DEVICES={shlex.quote(selected_gpu)} "
        f"{run_prefix} {shlex.quote(predict_script)} "
        f"-i {shlex.quote(input_dir)} "
        f"-o {shlex.quote(save_dir)} "
        f"-m {shlex.quote(ckpt_path)} "
        f"-step_size 0.7 "
        f"--disable_tta "
        f"-chk checkpoint_final.pth"
    )

    print(f"[INFO] Running LesionSegmenter command for case {case_id}")
    print(full_cmd)
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"LesionSegmenter inference command failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    if not os.path.exists(case_pred):
        raise RuntimeError(f"Expected LesionSegmenter output not found: {case_pred}")

    output_ct_dir = os.path.join(session_dir, "outputs", "ct")
    os.makedirs(output_ct_dir, exist_ok=True)
    combined_label_path = os.path.join(output_ct_dir, "combined_labels.nii.gz")
    shutil.copy2(case_pred, combined_label_path)
    _remap_combined_labels(combined_label_path, _LESIONSEG_TO_VIEWER)

    return output_ct_dir


def _run_checked_process(cmd: list[str], error_prefix: str):
    process = _tracked_run(cmd, text=True, capture_output=True)
    if process.returncode != 0:
        raise RuntimeError(
            f"{error_prefix}"
            f"\nCommand: {' '.join(shlex.quote(x) for x in cmd)}"
            f"\nExit code: {process.returncode}"
            f"\nSTDOUT:\n{(process.stdout or '').strip()}"
            f"\nSTDERR:\n{(process.stderr or '').strip()}"
        )
    return process


def _run_epai_remote_inference(
    case_id: str,
    input_path: str,
    input_csv_path: str,
    output_csv_path: str,
    save_dir: str,
    ckpt_path: str,
    nnunet_raw: str,
    nnunet_preprocessed: str,
    nnunet_results: str,
    epai_env_name: str,
):
    remote_host = (os.getenv("EPAI_REMOTE_HOST", "") or "").strip()
    remote_user = (os.getenv("EPAI_REMOTE_USER", "") or "").strip()
    if not remote_host or not remote_user:
        raise RuntimeError("EPAI remote mode is enabled, but EPAI_REMOTE_HOST or EPAI_REMOTE_USER is missing.")

    remote_port = str((os.getenv("EPAI_REMOTE_SSH_PORT", "22") or "22").strip())
    remote_base_dir = (os.getenv("EPAI_REMOTE_BASE_DIR", "/tmp/epai_jobs") or "/tmp/epai_jobs").strip()
    remote_env = (os.getenv("EPAI_REMOTE_CONDA_ENV", epai_env_name) or epai_env_name).strip()
    remote_conda_activate_path = (os.getenv("EPAI_REMOTE_CONDA_ACTIVATE_PATH", "") or "").strip()
    remote_conda_exe = (os.getenv("EPAI_REMOTE_CONDA_EXE", "conda") or "conda").strip()

    remote_ckpt_path = (os.getenv("EPAI_REMOTE_CKPT_PATH", ckpt_path) or ckpt_path).strip()
    remote_nnunet_raw = (os.getenv("EPAI_REMOTE_NNUNET_RAW", nnunet_raw) or nnunet_raw).strip()
    remote_nnunet_preprocessed = (
        os.getenv("EPAI_REMOTE_NNUNET_PREPROCESSED", nnunet_preprocessed) or nnunet_preprocessed
    ).strip()
    remote_nnunet_results = (os.getenv("EPAI_REMOTE_NNUNET_RESULTS", nnunet_results) or nnunet_results).strip()
    remote_gpu = (os.getenv("EPAI_REMOTE_GPU", "0") or "0").strip()

    remote_job_dir = f"{remote_base_dir.rstrip('/')}/{case_id}_{uuid.uuid4().hex[:8]}"
    remote_input_dir = f"{remote_job_dir}/eval"
    remote_save_dir = f"{remote_job_dir}/out"
    remote_case_input = f"{remote_input_dir}/{case_id}_0000.nii.gz"
    remote_input_csv = f"{remote_job_dir}/input.csv"
    remote_output_csv = f"{remote_job_dir}/output.csv"
    remote_pred = f"{remote_save_dir}/{case_id}.nii.gz"

    remote_target = f"{remote_user}@{remote_host}"

    _run_checked_process(
        ["ssh", "-p", remote_port, remote_target, f"mkdir -p {shlex.quote(remote_input_dir)} {shlex.quote(remote_save_dir)}"],
        "Failed to initialize remote ePAI workspace",
    )

    _run_checked_process(
        ["scp", "-P", remote_port, input_path, f"{remote_target}:{remote_case_input}"],
        "Failed to copy CT file to remote GPU server",
    )
    _run_checked_process(
        ["scp", "-P", remote_port, input_csv_path, f"{remote_target}:{remote_input_csv}"],
        "Failed to copy input CSV to remote GPU server",
    )
    _run_checked_process(
        ["scp", "-P", remote_port, output_csv_path, f"{remote_target}:{remote_output_csv}"],
        "Failed to copy output CSV template to remote GPU server",
    )

    inference_cmd = (
        f"nnUNet_N_proc_DA={shlex.quote(os.getenv('EPAI_N_PROC_DA', '36'))} "
        f"nnUNet_raw={shlex.quote(remote_nnunet_raw)} "
        f"nnUNet_preprocessed={shlex.quote(remote_nnunet_preprocessed)} "
        f"nnUNet_results={shlex.quote(remote_nnunet_results)} "
        f"CUDA_VISIBLE_DEVICES={shlex.quote(remote_gpu)} "
        f"nnUNetv2_predict_from_modelfolder "
        f"-i {shlex.quote(remote_input_dir)} "
        f"-o {shlex.quote(remote_save_dir)} "
        f"-m {shlex.quote(remote_ckpt_path)} "
        f"-f all "
        f"--input_csv {shlex.quote(remote_input_csv)} "
        f"--output_csv {shlex.quote(remote_output_csv)} "
        f"--continue_prediction "
        f"-npp {shlex.quote(os.getenv('EPAI_NPP', '3'))} "
        f"-nps {shlex.quote(os.getenv('EPAI_NPS', '3'))} "
        f"-num_parts 1 "
        f"-part_id 0 "
        f"-chk {shlex.quote(os.getenv('EPAI_CHECKPOINT_NAME', 'checkpoint_final.pth'))}"
    )

    if remote_conda_activate_path:
        remote_run_cmd = (
            f"source {shlex.quote(remote_conda_activate_path)} && "
            f"conda activate {shlex.quote(remote_env)} && "
            f"{inference_cmd}"
        )
    else:
        remote_run_cmd = (
            f"{shlex.quote(remote_conda_exe)} run -n {shlex.quote(remote_env)} "
            f"bash -lc {shlex.quote(inference_cmd)}"
        )

    _run_checked_process(
        ["ssh", "-p", remote_port, remote_target, remote_run_cmd],
        "Remote ePAI inference command failed",
    )

    local_case_pred = os.path.join(save_dir, f"{case_id}.nii.gz")
    _run_checked_process(
        ["scp", "-P", remote_port, f"{remote_target}:{remote_pred}", local_case_pred],
        "Failed to download remote ePAI mask output",
    )
    _run_checked_process(
        ["scp", "-P", remote_port, f"{remote_target}:{remote_output_csv}", output_csv_path],
        "Failed to download remote ePAI CSV output",
    )

    if _is_truthy(os.getenv("EPAI_REMOTE_CLEANUP", "true")):
        _run_checked_process(
            ["ssh", "-p", remote_port, remote_target, f"rm -rf {shlex.quote(remote_job_dir)}"],
            "Failed to clean up remote ePAI workspace",
        )


def _run_shapekit_inference(input_dir: str, session_dir: str) -> str:
    """
    Run ShapeKit post-processing on a segmentation output directory.

    ShapeKit expects: input_folder/case_id/segmentations/<organ>.nii.gz
    We receive:       input_dir/combined_labels.nii.gz  (viewer label values)

    Steps:
      1. Split combined_labels.nii.gz into per-organ files in ShapeKit's layout
      2. Run ShapeKit
      3. Reassemble refined organs back into combined_labels.nii.gz with viewer label values
    """
    import numpy as np
    import nibabel as nib

    output_dir = os.path.join(session_dir, "shapekit")
    log_dir    = os.path.join(session_dir, "shapekit_logs")
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(log_dir, exist_ok=True)

    shapekit_src = os.getenv("SHAPEKIT_SRC_PATH", "/home/visitor/ShapeKit")
    conda_env    = os.getenv("CONDA_ENV_SHAPEKIT", "shapekit")
    conda_exe    = _resolve_conda_exe()
    cpu_count    = os.getenv("SHAPEKIT_CPU_NUM", "16")

    if not os.path.isdir(shapekit_src):
        raise RuntimeError(
            f"ShapeKit source not found at {shapekit_src}. "
            "Install it with:\n"
            f"  git clone https://github.com/BodyMaps/ShapeKit.git {shapekit_src}\n"
            f"  conda create -n {conda_env} python=3.10 -y\n"
            f"  conda run -n {conda_env} pip install -r {shapekit_src}/requirements.txt\n"
            "Or set SHAPEKIT_SRC_PATH and CONDA_ENV_SHAPEKIT env vars to the correct paths."
        )

    # --- Step 1: split combined_labels.nii.gz into per-organ files ---
    combined_path = os.path.join(input_dir, "combined_labels.nii.gz")
    if not os.path.isfile(combined_path):
        raise RuntimeError(
            f"ShapeKit requires combined_labels.nii.gz but it was not found in: {input_dir}"
        )

    # Organs that ShapeKit's config.yaml knows how to process
    _SHAPEKIT_ORGANS = {
        "adrenal_gland_left", "adrenal_gland_right", "aorta", "bladder",
        "colon", "duodenum", "femur_left", "femur_right", "gall_bladder",
        "intestine", "kidney_left", "kidney_right", "liver",
        "lung_left", "lung_right", "pancreas", "postcava", "prostate",
        "spleen", "stomach",
    }
    # viewer label value → organ name
    _label_to_name = {v: k for k, v in _VIEWER_LABELS.items()}

    case_id      = "case001"
    sk_input_dir = os.path.join(session_dir, "shapekit_input")
    seg_dir      = os.path.join(sk_input_dir, case_id, "segmentations")
    os.makedirs(seg_dir, exist_ok=True)

    combined_img  = nib.load(combined_path)
    combined_data = np.asarray(combined_img.dataobj, dtype=np.int16)
    affine, header = combined_img.affine, combined_img.header

    for label_val, organ_name in _label_to_name.items():
        if organ_name not in _SHAPEKIT_ORGANS:
            continue
        mask = (combined_data == label_val).astype(np.int16)
        if not np.any(mask):
            continue
        nib.save(
            nib.Nifti1Image(mask, affine, header),
            os.path.join(seg_dir, f"{organ_name}.nii.gz"),
        )
    print(f"[INFO] Split {len(os.listdir(seg_dir))} organ files into {seg_dir}")

    # --- Step 2: run ShapeKit ---
    sk_raw_output = os.path.join(session_dir, "shapekit_raw")
    os.makedirs(sk_raw_output, exist_ok=True)

    full_cmd = (
        f"{_env_command(conda_env)} "
        f"-W ignore {shlex.quote(os.path.join(shapekit_src, 'main.py'))} "
        f"--input_folder {shlex.quote(os.path.abspath(sk_input_dir))} "
        f"--output_folder {shlex.quote(os.path.abspath(sk_raw_output))} "
        f"--cpu_count {cpu_count} "
        f"--log_folder {shlex.quote(os.path.abspath(log_dir))} "
        f"--continue_prediction"
    )
    print(f"[INFO] Running ShapeKit post-processing\n{full_cmd}")
    try:
        _tracked_run(full_cmd, shell=True, executable="/bin/bash", check=True, cwd=shapekit_src)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"ShapeKit post-processing failed\nCommand: {full_cmd}\nExit code: {e.returncode}"
        ) from e

    # --- Step 3: reassemble combined_labels.nii.gz with viewer label values ---
    refined_seg_dir = os.path.join(sk_raw_output, case_id, "segmentations")
    if not os.path.isdir(refined_seg_dir):
        raise RuntimeError(f"ShapeKit produced no segmentation output in: {refined_seg_dir}")

    # Start from the original combined labels (preserves labels ShapeKit doesn't touch)
    result_data = combined_data.copy()

    for organ_file in os.listdir(refined_seg_dir):
        if not organ_file.endswith(".nii.gz"):
            continue
        organ_name   = organ_file[: -len(".nii.gz")]
        viewer_label = _VIEWER_LABELS.get(organ_name)
        if viewer_label is None:
            continue
        organ_data = np.asarray(nib.load(os.path.join(refined_seg_dir, organ_file)).dataobj)
        # Clear old pixels for this organ, write refined mask
        result_data[result_data == viewer_label] = 0
        result_data[organ_data > 0] = viewer_label

    nib.save(
        nib.Nifti1Image(result_data, affine, header),
        os.path.join(output_dir, "combined_labels.nii.gz"),
    )
    print(f"[INFO] ShapeKit refined combined_labels saved to {output_dir}")
    return output_dir


def _run_media_agentic_inference(
    input_path: str,
    session_dir: str,
    model_type: str,  # "organs" or "vertebrae"
) -> str:
    """
    Run MedIA-Agentic model inference using nnU-Net predictor.
    
    Args:
        input_path: Path to input NIfTI file
        session_dir: Session directory for outputs
        model_type: Either "organs" (cads551) or "vertebrae" (cads552)
    
    Returns:
        Path to output directory containing combined_labels.nii.gz
    """
    import subprocess
    import shutil
    
    output_dir = os.path.join(session_dir, "inference_result")
    os.makedirs(output_dir, exist_ok=True)
    
    # Prepare input directory structure for nnU-Net
    nnunet_input_dir = os.path.join(session_dir, "nnunet_input")
    os.makedirs(nnunet_input_dir, exist_ok=True)
    
    # Copy input file with nnU-Net naming convention
    input_filename = os.path.basename(input_path)
    case_id = input_filename.replace(".nii.gz", "").replace(".nii", "")
    nnunet_input_file = os.path.join(nnunet_input_dir, f"{case_id}_0000.nii.gz")
    
    if input_path.endswith(".nii.gz"):
        shutil.copy(input_path, nnunet_input_file)
    else:
        # Convert .nii to .nii.gz
        import nibabel as nib
        img = nib.load(input_path)
        nib.save(img, nnunet_input_file)
    
    # Set up nnU-Net output directory
    nnunet_output_dir = os.path.join(session_dir, "nnunet_output")
    os.makedirs(nnunet_output_dir, exist_ok=True)
    
    # Determine model path based on type
    if model_type == "organs":
        model_folder = os.path.expanduser("~/bodymaps_models/media_agentic/cads551_nnunet")
        label_map = _MEDIA_AGENTIC_ORGANS_TO_VIEWER
    else:  # vertebrae
        model_folder = os.path.expanduser("~/bodymaps_models/media_agentic/cads552_nnunet")
        label_map = _MEDIA_AGENTIC_VERTEBRAE_TO_VIEWER
    
    # Run inference using the standalone script
    inference_script = os.path.expanduser("~/bodymaps_models/media_agentic/run_inference.py")
    
    cmd = [
        "conda", "run", "-n", "epai", "python", inference_script,
        "--input_dir", nnunet_input_dir,
        "--output_dir", nnunet_output_dir,
        "--model_folder", model_folder,
    ]
    
    print(f"[INFO] Running MedIA-Agentic {model_type} inference...")
    print(f"[INFO] Command: {' '.join(cmd)}")
    
    # This model runs on the web host's own GPU (it is not routed to a worker),
    # so with several jobs in flight it queues on the same lock as every other
    # local model run. Only taken when workers are enabled (the disabled path is
    # unchanged: one job at a time already).
    gpu_slot = _local_gpu_slot(_current_session_cancelled) if gpu_workers.enabled() else contextlib.nullcontext()
    with gpu_slot:
        result = subprocess.run(cmd, capture_output=True, text=True)
    _note_run(getattr(_thread_session, "sid", None), gpu_workers._local_hostname())
    
    if result.returncode != 0:
        print(f"[ERROR] MedIA-Agentic inference failed: {result.stderr}")
        raise RuntimeError(f"MedIA-Agentic inference failed: {result.stderr}")
    
    print(f"[INFO] MedIA-Agentic inference stdout: {result.stdout}")
    
    # Find output file
    output_file = os.path.join(nnunet_output_dir, f"{case_id}.nii.gz")
    if not os.path.exists(output_file):
        # Try without case_id (nnU-Net might use different naming)
        for f in os.listdir(nnunet_output_dir):
            if f.endswith(".nii.gz") and not f.startswith("."):
                output_file = os.path.join(nnunet_output_dir, f)
                break
    
    if not os.path.exists(output_file):
        raise FileNotFoundError(f"No output file found in {nnunet_output_dir}")
    
    # Copy to final location and remap labels
    final_output = os.path.join(output_dir, "combined_labels.nii.gz")
    shutil.copy(output_file, final_output)
    
    # Remap labels to viewer scheme
    _remap_combined_labels(final_output, label_map)
    
    print(f"[INFO] MedIA-Agentic {model_type} inference complete: {final_output}")
    return output_dir
