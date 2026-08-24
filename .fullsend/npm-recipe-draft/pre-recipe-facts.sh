#!/usr/bin/env bash
# Pre-recipe facts: the trusted half of the split-trust model.
#
# Runs on the runner (outside the sandbox, with full credentials) before the
# sandbox starts. It resolves the target identity and writes the deterministic
# facts (git URL, immutable source SHA, provenance) the agent must never
# fabricate. host_files then copies the file to $RECIPE_INPUT_FILE; the agent
# reads it and either drafts (facts present) or emits needs_human (facts
# absent). A non-zero exit aborts the run before the sandbox is created.
set -euo pipefail

# Repo root is two dirs up from this script; deriving it from BASH_SOURCE (not a
# runner env var) keeps the script runnable in CI and locally via `fullsend run`.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

# Fixed staging path — the harness host_files `src` references this same literal
# path (it's expanded with the runner process env, not env.runner). Keep in sync.
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

# Pinned registry-contract input (Gate A): a read-only, reviewed snapshot of the
# target registry's manifest contract, never derived from npm metadata. Defaults
# to the committed provenance.json; an out-of-band override may point elsewhere.
# The collector blocks without it (every package → REGISTRY_CONTRACT_UNAVAILABLE),
# so the default keeps the collector able to run.
export REGISTRY_CONTRACT_PROVENANCE="${REGISTRY_CONTRACT_PROVENANCE:-${REPO_ROOT}/registry-contract/provenance.json}"

# Collect facts (live artifact + source verification) and write the agent input.
# Failure contract inside collect-facts-cli.mjs:
#   - operational faults (timeout, DNS/TLS, 429/5xx, oversize, bad JSON) exit
#     non-zero → `set -e` aborts the run as retryable infrastructure.
#   - package/policy/input/blocked outcomes write facts_available:false (with a
#     reason_code) and exit 0, so the agent emits a bounded needs_human.
REPO_ROOT="${REPO_ROOT}" IDENTITY="${IDENTITY}" INPUT_FILE="${INPUT_FILE}" \
    node "${REPO_ROOT}/scripts/lib/collect-facts-cli.mjs"

echo "[pre-facts] done"
