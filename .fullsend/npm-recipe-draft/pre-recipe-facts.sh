#!/usr/bin/env bash
# Pre-recipe facts: the trusted half of the split-trust model.
#
# Runs on the runner (outside the sandbox, with full credentials) before the
# sandbox starts. It resolves the target identity and writes the deterministic
# facts (git URL, immutable source SHA, provenance) the agent must never
# fabricate. host_files then copies the file to $RECIPE_INPUT_FILE; the agent
# reads it and either drafts or emits needs_human (best-effort recipe only when
# facts are available). Fact-collection failure aborts the run and comments on
# the kitchen issue.
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

export REGISTRY_CONTRACT_PROVENANCE="${REGISTRY_CONTRACT_PROVENANCE:-${REPO_ROOT}/registry-contract/provenance.json}"

post_fact_collection_failure() {
    local reason_code reason identity_label kitchen_repo issue_number token

    [[ -f "${INPUT_FILE}" ]] || return 0
    reason_code="$(jq -r '.reason_code // "UNKNOWN"' "${INPUT_FILE}")"
    reason="$(jq -r '.reason // "Fact collection failed"' "${INPUT_FILE}")"
    identity_label="$(jq -r '.identity // empty' "${INPUT_FILE}")"
    if [[ -z "${identity_label}" || "${identity_label}" == "null" ]]; then
        identity_label="${IDENTITY:-<unknown>}"
    fi

    issue_number="${ISSUE_NUMBER:-${STATUS_NUMBER:-}}"
    if [[ -z "${issue_number}" && -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
        issue_number="$(jq -r '.issue.number // empty' "${GITHUB_EVENT_PATH}" 2>/dev/null || true)"
    fi
    kitchen_repo="${KITCHEN_REPO_FULL_NAME:-${STATUS_REPO:-${GITHUB_REPOSITORY:-}}}"
    token="${PUSH_TOKEN:-${GITHUB_TOKEN:-}}"

    if [[ -z "${issue_number}" || -z "${kitchen_repo}" || -z "${token}" ]]; then
        echo "[pre-facts] cannot post issue comment (need issue number, repo, and token)" >&2
        return 0
    fi

    local body
    body="$(cat <<EOF
Fact collection failed for \`${identity_label}\` — the recipe agent did **not** run.

- **Code:** \`${reason_code}\`
- **Detail:** ${reason}

Fix the underlying issue and re-run \`/fs-onboard ${identity_label}\`.
EOF
)"
    GH_TOKEN="${token}" gh issue comment "${issue_number}" \
        --repo "${kitchen_repo}" \
        --body "${body}" \
        || echo "[pre-facts] gh issue comment failed (non-fatal)" >&2
}

if ! REPO_ROOT="${REPO_ROOT}" IDENTITY="${IDENTITY}" INPUT_FILE="${INPUT_FILE}" \
    node "${REPO_ROOT}/scripts/lib/collect-facts-cli.mjs"; then
    post_fact_collection_failure
    exit 1
fi

echo "[pre-facts] done"
