#!/usr/bin/env bash
# One-command cold start for the interactive segmentation demo.
#
# From a fresh checkout (plus the one-time setup in INTERACTIVE_DEMO.md),
# this brings up all three processes the feature needs, in order, waiting
# for each to be healthy before the next:
#
#   1. nninteractive-server  (the segmentation model, port 1527)
#   2. Flask backend         (the site's API, port 5001)
#   3. Vite dev server       (the viewer, port 5173)
#
# then prints the demo URL. Ctrl+C stops everything it started. Servers that
# are already up on their ports are reused, not restarted, so it is safe to
# re-run. Case 1 of the PanTS demo dataset is downloaded automatically the
# first time (two files, ~90 MB, from the public HuggingFace mirror), and
# the model server fetches its weights (~400 MB) on ITS first start — the
# first run takes a few minutes, every run after that is seconds.
#
# Overrides (env vars):
#   NNINTERACTIVE_ENV     python env that has nninteractive-server installed
#                         (default: ../nninteractive-env next to this repo)
#   NNINTERACTIVE_DEVICE  mps | cuda | cpu (default: mps on Apple Silicon,
#                         else cuda). cpu is a last resort — predictions
#                         take minutes and on macOS have deadlocked.
#   BODYMAPS_DATA         dataset folder with image_only/ + mask_only/
#                         (default: ../local-data/pants next to this repo)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NNINTERACTIVE_ENV="${NNINTERACTIVE_ENV:-$ROOT/../nninteractive-env}"
DATA_DIR="${BODYMAPS_DATA:-$ROOT/../local-data/pants}"
LOG_DIR="$ROOT/tmp/demo-logs"
CASE_ID="PanTS_00000001"
HF_BASE="https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main"
MODEL_PORT=1527
FLASK_PORT=5001
WEB_PORT=5173

mkdir -p "$LOG_DIR"
PIDS=()
cleanup() {
  # Only reap what we started; pre-existing servers are left alone.
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup INT TERM EXIT

say()  { printf '\033[1m[demo]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[demo]\033[0m %s\n' "$*" >&2; exit 1; }

# localhost, not 127.0.0.1: Vite binds IPv6-only ([::1]) on some setups, and
# an IPv4-only probe would wait forever on a server that is actually up.
port_up() { curl -s -o /dev/null --max-time 2 "http://localhost:$1$2"; }

wait_port() { # port, path, label, timeout_s
  local waited=0
  until port_up "$1" "$2"; do
    sleep 2; waited=$((waited + 2))
    # NB: plain `[ ... ] && say` here would kill the whole script under
    # set -e whenever the condition is false (a failing last command).
    if [ $((waited % 20)) -eq 0 ]; then say "still waiting for $3 (${waited}s)..."; fi
    if [ "$waited" -ge "$4" ]; then fail "$3 did not come up within ${4}s — see $LOG_DIR"; fi
  done
}

# ---------------------------------------------------------------- checks --
[ -x "$ROOT/flask-server/.venv/bin/python" ] || fail \
  "flask-server/.venv missing. One-time setup:
    cd flask-server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"

[ -x "$NNINTERACTIVE_ENV/bin/nninteractive-server" ] || fail \
  "nninteractive-server not found at $NNINTERACTIVE_ENV. One-time setup:
    python3 -m venv $NNINTERACTIVE_ENV && $NNINTERACTIVE_ENV/bin/pip install nnInteractive
  (or set NNINTERACTIVE_ENV to an env that already has it)"

[ -d "$ROOT/PanTS-Demo/node_modules" ] || {
  say "PanTS-Demo/node_modules missing — running npm install (one time)..."
  (cd "$ROOT/PanTS-Demo" && npm install) || fail "npm install failed"
}

if [ ! -f "$ROOT/flask-server/.env" ]; then
  say "creating flask-server/.env from .env.example (PANTS_PATH -> $DATA_DIR)"
  cp "$ROOT/flask-server/.env.example" "$ROOT/flask-server/.env"
  printf '\nPANTS_PATH=%s\n' "$DATA_DIR" >>"$ROOT/flask-server/.env"
fi

if [ ! -f "$DATA_DIR/image_only/$CASE_ID/ct.nii.gz" ]; then
  say "demo case not found locally — downloading case 1 (~90 MB, one time)..."
  mkdir -p "$DATA_DIR/image_only/$CASE_ID" "$DATA_DIR/mask_only/$CASE_ID"
  curl -fL --progress-bar -o "$DATA_DIR/image_only/$CASE_ID/ct.nii.gz" \
    "$HF_BASE/image_only/$CASE_ID/ct.nii.gz?download=true" \
    || fail "could not download the demo CT from HuggingFace"
  curl -fL --progress-bar -o "$DATA_DIR/mask_only/$CASE_ID/combined_labels.nii.gz" \
    "$HF_BASE/mask_only/$CASE_ID/combined_labels.nii.gz?download=true" \
    || fail "could not download the demo labels from HuggingFace"
fi

# ---------------------------------------------------- 1. model server ----
if port_up "$MODEL_PORT" /healthz; then
  say "model server already running on :$MODEL_PORT — reusing it"
else
  if [ -z "${NNINTERACTIVE_DEVICE:-}" ]; then
    case "$(uname -sm)" in
      "Darwin arm64") NNINTERACTIVE_DEVICE=mps ;;
      *)              NNINTERACTIVE_DEVICE=cuda ;;
    esac
  fi
  say "starting nninteractive-server (--device $NNINTERACTIVE_DEVICE) — first run downloads ~400 MB of weights"
  # MPS fallback: autozoom uses adaptive_avg_pool3d, which MPS lacks; without
  # the env var, prompts on large structures hang inside the model server.
  # Timeouts stay at the server's defaults on purpose: the backend's client
  # auto-heartbeats, and expired idle sessions are replayed transparently.
  PYTORCH_ENABLE_MPS_FALLBACK=1 "$NNINTERACTIVE_ENV/bin/nninteractive-server" \
    --device "$NNINTERACTIVE_DEVICE" --no-torch-compile \
    >>"$LOG_DIR/model-server.log" 2>&1 &
  PIDS+=($!)
  wait_port "$MODEL_PORT" /healthz "model server" 900
fi
say "model server is up"

# ---------------------------------------------------------- 2. backend ----
if port_up "$FLASK_PORT" /; then
  say "backend already running on :$FLASK_PORT — reusing it"
else
  say "starting Flask backend on :$FLASK_PORT"
  (cd "$ROOT/flask-server" && exec .venv/bin/python app.py) \
    >>"$LOG_DIR/flask.log" 2>&1 &
  PIDS+=($!)
  wait_port "$FLASK_PORT" / "Flask backend" 120
fi
say "backend is up"

# ----------------------------------------------------------- 3. viewer ----
if port_up "$WEB_PORT" /; then
  say "viewer already running on :$WEB_PORT — reusing it"
else
  say "starting Vite dev server on :$WEB_PORT"
  (cd "$ROOT/PanTS-Demo" && exec npx vite --port "$WEB_PORT" --strictPort) \
    >>"$LOG_DIR/vite.log" 2>&1 &
  PIDS+=($!)
  wait_port "$WEB_PORT" / "Vite dev server" 120
fi

cat <<EOF

  ─────────────────────────────────────────────────────────────
  Ready. Open:  http://localhost:$WEB_PORT/case/1

  A 5-minute tour (details in INTERACTIVE_DEMO.md):
    1. Segments panel -> add a class -> annotation toolbar ->
       "Segment from click" -> click an organ once: full 3D mask.
    2. Keep clicking: each click REFINES the same object.
       Right-click an overshoot at its EDGE to carve it away.
       Green/red dots mark where your prompts landed.
    3. Ctrl+Z rewinds the newest prompt, model context included.
    4. Try "Segment from scribble" (stroke over a structure)
       and "Segment from lasso" (circle it).
    5. Arm a tool on an EXISTING organ label: the model continues
       from that mask instead of starting over.

  Logs: $LOG_DIR    Stop everything: Ctrl+C
  ─────────────────────────────────────────────────────────────
EOF

wait
