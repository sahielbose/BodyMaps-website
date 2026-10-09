#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:5001}"
INPUT_PATH="${INPUT_PATH:-}"
MODEL_NAME="${MODEL_NAME:-ePAI}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-3600}"
SESSION_ID="${SESSION_ID:-smoke-$(date +%s)}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/pull_queue_smoke}"
WORKER_API_TOKEN="${WORKER_API_TOKEN:-}"

if [[ -z "${WORKER_API_TOKEN}" ]]; then
  echo "ERROR: WORKER_API_TOKEN is required (creating a job needs the worker token)."
  exit 1
fi

if [[ -z "${INPUT_PATH}" ]]; then
  echo "ERROR: INPUT_PATH is required."
  echo "Example: INPUT_PATH=/path/to/ct.nii.gz API_BASE=https://server-a WORKER_API_TOKEN=... ./scripts/smoke_test_pull_queue.sh"
  exit 1
fi

if [[ ! -f "${INPUT_PATH}" ]]; then
  echo "ERROR: INPUT_PATH does not exist: ${INPUT_PATH}"
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
create_resp="${OUTPUT_DIR}/create_job.json"
create_status="${OUTPUT_DIR}/create_job.status"

echo "[1/4] Creating job on ${API_BASE}/api/jobs"
curl -sS -X POST "${API_BASE}/api/jobs" \
  -H "X-Worker-Token: ${WORKER_API_TOKEN}" \
  -F "MAIN_NIFTI=@${INPUT_PATH}" \
  -F "session_id=${SESSION_ID}" \
  -F "MODEL_NAME=${MODEL_NAME}" \
  -o "${create_resp}" \
  -w "%{http_code}" > "${create_status}"

CREATE_HTTP_CODE="$(cat "${create_status}")"
if [[ "${CREATE_HTTP_CODE}" != "201" ]]; then
  echo "ERROR: job creation failed with HTTP ${CREATE_HTTP_CODE}"
  cat "${create_resp}"
  exit 1
fi

JOB_ID="$(python - <<'PY' "${create_resp}"
import json,sys
p=sys.argv[1]
with open(p,"r",encoding="utf-8") as f:
    data=json.load(f)
print(data.get("job_id", ""))
PY
)"

if [[ -z "${JOB_ID}" ]]; then
  echo "ERROR: Could not read job_id from response:"
  cat "${create_resp}"
  exit 1
fi

echo "Created job_id=${JOB_ID} session_id=${SESSION_ID}"

deadline=$(( $(date +%s) + MAX_WAIT_SECONDS ))
status_file="${OUTPUT_DIR}/status_${JOB_ID}.json"


echo "[2/4] Polling job status"
while true; do
  curl -sS "${API_BASE}/api/jobs/${JOB_ID}" -o "${status_file}"

  STATUS="$(python - <<'PY' "${status_file}"
import json,sys
p=sys.argv[1]
with open(p,"r",encoding="utf-8") as f:
    data=json.load(f)
print(data.get("status", ""))
PY
)"

  echo "status=${STATUS}"

  if [[ "${STATUS}" == "succeeded" ]]; then
    break
  fi

  if [[ "${STATUS}" == "failed" ]]; then
    echo "ERROR: job failed"
    cat "${status_file}"
    exit 2
  fi

  if (( $(date +%s) > deadline )); then
    echo "ERROR: timeout waiting for job completion"
    cat "${status_file}"
    exit 3
  fi

  sleep "${POLL_SECONDS}"
done

result_zip="${OUTPUT_DIR}/${JOB_ID}_auto_masks.zip"

echo "[3/4] Downloading result zip"
curl -sS -L "${API_BASE}/api/jobs/${JOB_ID}/download" -o "${result_zip}"

if [[ ! -s "${result_zip}" ]]; then
  echo "ERROR: result zip is empty"
  exit 4
fi

echo "[4/4] Done"
echo "Result saved to: ${result_zip}"
echo "Last status payload: ${status_file}"
