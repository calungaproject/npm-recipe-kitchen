#!/usr/bin/env bash
# Validation loop: schema + entry-count checks for priority-result.json.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

result_name="${FULLSEND_OUTPUT_FILE:-priority-result.json}"
output_dir="${FULLSEND_OUTPUT_DIR:-/sandbox/workspace/output}"
result_path="${output_dir}/${result_name}"
input_path="/tmp/fullsend-npm-priority-queue/priority-input.json"

if [[ ! -f "${result_path}" ]]; then
  echo "[validate-priority] missing ${result_path}" >&2
  exit 1
fi

if [[ ! -d "${REPO_ROOT}/node_modules/ajv" ]]; then
  (cd -- "${REPO_ROOT}" && npm ci --ignore-scripts --no-audit --no-fund --omit=dev)
fi

node "${REPO_ROOT}/scripts/lib/validate-priority-result.mjs" "${result_path}" "${input_path}"

export FULLSEND_VALIDATED_ITERATION_DIR="${output_dir}"
echo "[validate-priority] ok: ${result_path}"
