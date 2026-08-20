#!/usr/bin/env bash
# Post-recipe validation: the deterministic safety gate for npm-recipe-draft.
#
# Runs on the RUNNER (outside the sandbox) after the agent exits. Fullsend
# invokes it with cwd = the run directory and blocks the result (fails the run)
# if this script exits non-zero. It re-runs the repo's semantic validator
# against the agent's recipe-result.json before the result is acted on.
#
# Runtime contract (fullsend v0.36.0, internal/cli/run.go):
#   cwd                              = the run directory (contains iteration-*/)
#   FULLSEND_VALIDATED_ITERATION_DIR = <run>/iteration-N/output (the validated
#                                      iteration), when present
# This script does NOT rely on REPO_ROOT or FULLSEND_OUTPUT_DIR being exported
# (they are not, for runner-side post-scripts); it derives the repo root from
# its own on-disk location instead.
set -euo pipefail

# Repo root: this script lives at <repo>/.fullsend/npm-recipe-draft/, so the
# repo root is two directories up from the script directory.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

# The runner-side validator depends on ajv (scripts/lib/validate.mjs), but the
# managed fullsend workflow checks out the repo without installing node
# dependencies and node_modules/ is gitignored, so ajv is absent here. Install
# production deps on demand from the committed lockfile. Guard on ajv's presence
# so repeat runs and local `fullsend run` (where deps already exist) skip the
# network round-trip. --ignore-scripts keeps the install from executing package
# lifecycle scripts inside this trusted gate.
if [[ ! -d "${REPO_ROOT}/node_modules/ajv" ]]; then
    echo "[post-validate] Installing validator dependencies in ${REPO_ROOT}"
    (cd -- "${REPO_ROOT}" && npm ci --ignore-scripts --no-audit --no-fund --omit=dev)
fi

result_name="${FULLSEND_OUTPUT_FILE:-recipe-result.json}"

# Locate the agent's result file. Prefer the iteration fullsend validated;
# fall back to scanning iteration-*/output and picking the numerically highest
# (latest) iteration; finally try FULLSEND_OUTPUT_DIR for local/manual runs.
result_file=""
if [[ -n "${FULLSEND_VALIDATED_ITERATION_DIR:-}" && -f "${FULLSEND_VALIDATED_ITERATION_DIR}/${result_name}" ]]; then
    result_file="${FULLSEND_VALIDATED_ITERATION_DIR}/${result_name}"
else
    # nullglob so a no-match glob expands to nothing rather than the literal
    # pattern; select the highest iteration number so iteration-10 beats
    # iteration-9 (lexicographic "last wins" would pick iteration-9).
    shopt -s nullglob
    latest_iter=-1
    for dir in iteration-*/output; do
        iter_num="${dir%/output}"
        iter_num="${iter_num#iteration-}"
        if [[ "${iter_num}" =~ ^[0-9]+$ && -f "${dir}/${result_name}" && "${iter_num}" -gt "${latest_iter}" ]]; then
            latest_iter="${iter_num}"
            result_file="${dir}/${result_name}"
        fi
    done
    shopt -u nullglob
    if [[ -z "${result_file}" && -n "${FULLSEND_OUTPUT_DIR:-}" && -f "${FULLSEND_OUTPUT_DIR}/${result_name}" ]]; then
        result_file="${FULLSEND_OUTPUT_DIR}/${result_name}"
    fi
fi

if [[ -z "${result_file}" ]]; then
    echo "[post-validate] Missing ${result_name}: searched FULLSEND_VALIDATED_ITERATION_DIR, ./iteration-*/output, and FULLSEND_OUTPUT_DIR" >&2
    exit 1
fi

echo "[post-validate] Validating ${result_file}"

REPO_ROOT="${REPO_ROOT}" RESULT_FILE="${result_file}" node --input-type=module <<'VALIDATE_EOF'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repoRoot = process.env.REPO_ROOT;
const resultPath = process.env.RESULT_FILE;

const validatorUrl = pathToFileURL(`${repoRoot}/scripts/lib/recipe-validator.mjs`).href;
const { validateRecipeResult, validateNeedsHumanResult } = await import(validatorUrl);

let result;
try {
  result = JSON.parse(readFileSync(resultPath, 'utf-8'));
} catch (err) {
  console.error(`[post-validate] FAILED: ${resultPath} is not valid JSON — ${err.message}`);
  process.exit(1);
}

// The agent runs in an untrusted sandbox; treat its output as untrusted input.
// Branch on the declared status so needs_human results are held to their own
// contract (reason + escalation_target, no drafted fields). Any status other
// than the two we recognize is rejected outright rather than validated as a
// drafted result.
let validation;
if (result.status === 'needs_human') {
  validation = validateNeedsHumanResult(result);
} else if (result.status === 'drafted') {
  validation = validateRecipeResult(result);
} else {
  console.error(`[post-validate] FAILED: unknown result.status ${JSON.stringify(result.status)} — expected "drafted" or "needs_human"`);
  process.exit(1);
}

if (!validation.valid) {
  console.error('[post-validate] FAILED:');
  for (const e of validation.errors) {
    console.error(`  ${e.check || 'schema'}: ${e.path} — ${e.message}`);
  }
  process.exit(1);
}

console.log(`[post-validate] OK: status=${result.status}`);
VALIDATE_EOF

echo "[post-validate] Passed"
