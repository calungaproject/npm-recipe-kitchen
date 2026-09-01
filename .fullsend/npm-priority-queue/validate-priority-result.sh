#!/usr/bin/env bash
# Harness validation_loop (ADR 0022): ensure priority-result.json landed in the
# sandbox output directory. Runs on the runner (cwd = iteration-N/) after
# SafeDownload — not inside the sandbox.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

: "${FULLSEND_OUTPUT_SCHEMA:?FULLSEND_OUTPUT_SCHEMA must be set}"

OUTPUT_DIR="output"
if [[ ! -d "${OUTPUT_DIR}" ]]; then
  echo "[validate-priority] FAIL: output directory not found in $(pwd)" >&2
  exit 1
fi

result_name="${FULLSEND_OUTPUT_FILE:-priority-result.json}"
result_name="$(basename "${result_name}")"
result_path="${OUTPUT_DIR}/${result_name}"
input_path="/tmp/fullsend-npm-priority-queue/priority-input.json"

if [[ ! -f "${result_path}" ]]; then
  echo "[validate-priority] FAIL: ${result_path} not found — write priority-result.json to \$FULLSEND_OUTPUT_DIR/\$FULLSEND_OUTPUT_FILE (not /sandbox/workspace/)" >&2
  exit 1
fi

if ! python3 -m json.tool "${result_path}" > /dev/null 2>&1; then
  echo "[validate-priority] FAIL: ${result_path} is not valid JSON" >&2
  exit 1
fi

if ! python3 -c "import jsonschema" 2>/dev/null; then
  echo "[validate-priority] FAIL: python3 jsonschema package is not installed (required by ADR 0022)" >&2
  exit 1
fi

python3 -c "
import json, sys
from jsonschema import validate, ValidationError

with open(sys.argv[1]) as f:
    instance = json.load(f)
with open(sys.argv[2]) as f:
    schema = json.load(f)
try:
    validate(instance=instance, schema=schema)
    print('[validate-priority] PASS: output validated against schema')
except ValidationError as e:
    print(f'[validate-priority] FAIL: schema validation error: {e.message}')
    if e.path:
        print(f'  at: {\".\".join(str(p) for p in e.path)}')
    sys.exit(1)
" "${result_path}" "${FULLSEND_OUTPUT_SCHEMA}"

if [[ ! -d "${REPO_ROOT}/node_modules/ajv" ]]; then
  (cd -- "${REPO_ROOT}" && npm ci --ignore-scripts --no-audit --no-fund --omit=dev)
fi

node "${REPO_ROOT}/scripts/lib/validate-priority-result.mjs" "${result_path}" "${input_path}"

export FULLSEND_VALIDATED_ITERATION_DIR="$(cd -- "${OUTPUT_DIR}" && pwd)"
echo "[validate-priority] ok: ${result_path}"
