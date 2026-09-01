#!/usr/bin/env bash
# Harness validation_loop (ADR 0022): ensure recipe-result.json landed in the
# sandbox output directory before post-recipe-validate runs.
set -euo pipefail

_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=recipe-paths.sh
source "${_script_dir}/recipe-paths.sh"

: "${FULLSEND_OUTPUT_SCHEMA:?FULLSEND_OUTPUT_SCHEMA must be set}"

OUTPUT_DIR="output"
if [[ ! -d "${OUTPUT_DIR}" ]]; then
  echo "FAIL: output directory not found"
  exit 1
fi

_output_file="${FULLSEND_OUTPUT_FILE:-recipe-result.json}"
_output_file="$(basename "${_output_file}")"
RESULT_FILE="${OUTPUT_DIR}/${_output_file}"
if [[ ! -f "${RESULT_FILE}" ]]; then
  echo "FAIL: ${RESULT_FILE} not found — write recipe-result.json to \$FULLSEND_OUTPUT_DIR/\$FULLSEND_OUTPUT_FILE (not /sandbox/workspace/)"
  exit 1
fi
echo "Validating: ${RESULT_FILE} against ${FULLSEND_OUTPUT_SCHEMA}"

if ! python3 -m json.tool "${RESULT_FILE}" > /dev/null 2>&1; then
  echo "FAIL: ${RESULT_FILE} is not valid JSON"
  exit 1
fi

if ! python3 -c "import jsonschema" 2>/dev/null; then
  echo "FAIL: python3 jsonschema package is not installed (required by ADR 0022)"
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
    print('PASS: output validated against schema')
except ValidationError as e:
    print(f'FAIL: schema validation error: {e.message}')
    if e.path:
        print(f'  at: {\".\".join(str(p) for p in e.path)}')
    sys.exit(1)
" "${RESULT_FILE}" "${FULLSEND_OUTPUT_SCHEMA}"

status="$(jq -r '.status // empty' "${RESULT_FILE}")"
if [[ "${status}" == "drafted" ]]; then
  package="$(jq -r '.package // empty' "${RESULT_FILE}")"
  if [[ -z "${package}" || "${package}" == "null" ]]; then
    echo "FAIL: drafted result is missing package identity"
    exit 1
  fi
  recipe_version="${package##*@}"
  recipe_name="${package%@${recipe_version}}"
  recipe_dir="${RECIPE_PACKAGES_DIR}/${recipe_name}/${recipe_version}"
  missing=()
  for name in manifest.json build.entrypoint.sh verify.smoke.sh; do
    if [[ ! -f "${recipe_dir}/${name}" ]]; then
      missing+=("${recipe_dir}/${name}")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "FAIL: drafted result requires recipe files under ${recipe_dir}/"
    for path in "${missing[@]}"; do
      echo "  missing: ${path}"
    done
    echo "Write under \${RECIPE_PACKAGES_DIR}/<name>/<version>/ (target-repo mount), not /sandbox/workspace/packages/."
    exit 1
  fi
  echo "PASS: recipe bundle present under ${recipe_dir}"
fi
