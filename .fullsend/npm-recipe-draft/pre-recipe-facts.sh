#!/usr/bin/env bash
# Pre-recipe facts: deterministic fact provisioning for npm-recipe-draft.
#
# Runs on the RUNNER (outside the sandbox) BEFORE the sandbox starts, with full
# runner credentials — the trusted half of the split-trust model described in
# building-custom-agents.md. Its job is to resolve the target package identity
# and emit the pre-computed deterministic facts (git URL, immutable source SHA,
# provenance) that the agent's prompt promises but must never fabricate.
#
# Data flow (see .fullsend/harness/npm-recipe-draft.yaml):
#   1. this pre-script writes the facts JSON to a fixed runner path
#   2. host_files copies that file into the sandbox at $RECIPE_INPUT_FILE
#   3. the agent reads $RECIPE_INPUT_FILE and either drafts (facts present) or
#      emits needs_human (facts absent) — it never guesses.
# The agent never sees the runner's credentials; it only receives this file.
#
# fullsend v0.36.0 runtime contract (internal/cli/run.go):
#   - the pre-script inherits the runner process env plus env.runner values
#     (childScriptEnv); a non-zero exit aborts the whole run before the sandbox
#     is created.
#   - host_files `src` is expanded with os.ExpandEnv (the runner PROCESS env),
#     which does NOT see env.runner values, so this script and the host_files
#     entry share one literal path rather than an env indirection.
set -euo pipefail

# Repo root: this script lives at <repo>/.fullsend/npm-recipe-draft/, so the
# repo root is two directories up from the script directory. Deriving it from
# BASH_SOURCE (rather than a runner env var) mirrors post-recipe-validate.sh and
# keeps the script runnable both in CI and locally via `fullsend run`.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

# Fixed staging path. The harness host_files entry references this SAME literal
# path (see the comment above about os.ExpandEnv); keep the two in sync.
INPUT_FILE="/tmp/fullsend-npm-recipe-draft/recipe-input.json"
mkdir -p "$(dirname -- "${INPUT_FILE}")"

# Resolve the package identity to onboard, in priority order:
#   1. RECIPE_PACKAGE            — explicit override (manual/CI/tests)
#   2. GITHUB_EVENT_PATH comment — the "/fs-onboard <name@version>" argument
# Anything else leaves IDENTITY empty, which produces a needs_human input rather
# than failing the run.
IDENTITY="${RECIPE_PACKAGE:-}"

if [[ -z "${IDENTITY}" && -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
    body="$(jq -r '.comment.body // ""' "${GITHUB_EVENT_PATH}" 2>/dev/null || true)"
    first_line="$(printf '%s\n' "${body}" | head -1 | tr -d '\r')"
    cmd="$(printf '%s' "${first_line}" | awk '{print $1}')"
    if [[ "${cmd}" == "/fs-onboard" ]]; then
        IDENTITY="$(printf '%s' "${first_line}" | awk '{print $2}')"
    fi
fi

echo "[pre-facts] resolved identity: ${IDENTITY:-<none>}"

# Derive the facts from the repo's committed, deterministic facts module and
# write the agent input file. Importing facts.mjs is INFRASTRUCTURE: a failure
# there (missing module, syntax error) is a real setup fault and crashes the
# pre-script via `set -e`. An invalid or unknown identity, by contrast, is a
# legitimate business outcome that yields facts_available:false so the agent can
# emit needs_human — it must not fail the run.
REPO_ROOT="${REPO_ROOT}" IDENTITY="${IDENTITY}" INPUT_FILE="${INPUT_FILE}" \
    node --input-type=module <<'FACTS_EOF'
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repoRoot = process.env.REPO_ROOT;
const identity = process.env.IDENTITY || '';
const inputFile = process.env.INPUT_FILE;

const factsUrl = pathToFileURL(`${repoRoot}/scripts/lib/facts.mjs`).href;
const { getFacts, validateFacts } = await import(factsUrl);

let payload;
if (!identity) {
  payload = {
    identity: '',
    facts_available: false,
    reason: 'No package identity was provided to /fs-onboard (expected "name@version").',
  };
} else {
  try {
    const facts = getFacts(identity);
    const check = validateFacts(facts);
    if (!check.valid) {
      payload = {
        identity,
        facts_available: false,
        reason: `Pre-computed facts for ${identity} failed internal validation: ${check.errors.map(e => `${e.path} ${e.message}`).join('; ')}`,
      };
    } else {
      payload = { identity, facts_available: true, facts };
    }
  } catch (err) {
    // getFacts throws for invalid-shape or unknown-package identities. Both mean
    // "we have no deterministic facts for this" — a needs_human case, not a run
    // failure. Only the import above (infrastructure) is allowed to crash.
    payload = { identity, facts_available: false, reason: err.message };
  }
}

writeFileSync(inputFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
console.log(`[pre-facts] wrote ${inputFile} (facts_available=${payload.facts_available})`);
FACTS_EOF

echo "[pre-facts] done"
