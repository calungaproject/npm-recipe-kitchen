#!/usr/bin/env bash
# Post-recipe validation script for Fullsend agent output.
# Runs as a deterministic post-step after the agent produces a recipe-result.
# Exits non-zero if validation fails, blocking the result from being rendered.
#
# Expected environment:
#   FULLSEND_OUTPUT_DIR — directory containing the agent's recipe-result.json
#   REPO_ROOT           — repository root for locating schemas and facts
set -euo pipefail

: "${FULLSEND_OUTPUT_DIR:?FULLSEND_OUTPUT_DIR required}"
: "${REPO_ROOT:?REPO_ROOT required}"

result_file="${FULLSEND_OUTPUT_DIR}/recipe-result.json"

[[ -f "${result_file}" ]] || {
    echo "[post-validate] Missing recipe-result.json in ${FULLSEND_OUTPUT_DIR}" >&2
    exit 1
}

echo "[post-validate] Validating ${result_file}"
node --input-type=module <<'VALIDATE_EOF'
import { readFileSync } from 'node:fs';
import { validateRecipeResult } from './scripts/lib/recipe-validator.mjs';

const resultPath = process.env.FULLSEND_OUTPUT_DIR + '/recipe-result.json';
const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
const validation = validateRecipeResult(result);

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
