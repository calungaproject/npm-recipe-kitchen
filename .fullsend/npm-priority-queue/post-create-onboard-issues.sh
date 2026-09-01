#!/usr/bin/env bash
# Post-script: validate priority-result.json and open onboard issues for Agent 2.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

if [[ ! -d "${REPO_ROOT}/node_modules/ajv" ]]; then
  echo "[post-priority] Installing validator dependencies in ${REPO_ROOT}"
  (cd -- "${REPO_ROOT}" && npm ci --ignore-scripts --no-audit --no-fund --omit=dev)
fi

result_name="${FULLSEND_OUTPUT_FILE:-priority-result.json}"
result_file=""
if [[ -n "${FULLSEND_VALIDATED_ITERATION_DIR:-}" && -f "${FULLSEND_VALIDATED_ITERATION_DIR}/${result_name}" ]]; then
  result_file="${FULLSEND_VALIDATED_ITERATION_DIR}/${result_name}"
else
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
  echo "[post-priority] Missing ${result_name}" >&2
  exit 1
fi

INPUT_FILE="/tmp/fullsend-npm-priority-queue/priority-input.json"
node "${REPO_ROOT}/scripts/lib/validate-priority-result.mjs" "${result_file}" "${INPUT_FILE}"

KITCHEN_REPO="${KITCHEN_REPO_FULL_NAME:-${GITHUB_REPOSITORY:-}}"
if [[ -z "${KITCHEN_REPO}" ]]; then
  echo "[post-priority] KITCHEN_REPO_FULL_NAME or GITHUB_REPOSITORY required" >&2
  exit 1
fi

GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "${GH_TOKEN}" ]]; then
  echo "[post-priority] GH_TOKEN or GITHUB_TOKEN required to create issues" >&2
  exit 1
fi
export GH_TOKEN

DRY_RUN="${PRIORITY_QUEUE_DRY_RUN:-false}"
if [[ -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
  DRY_RUN="$(jq -r '.inputs.dry_run // empty' "${GITHUB_EVENT_PATH}" 2>/dev/null || echo "${DRY_RUN}")"
fi

for label in npm-priority-candidate npm-onboard npm-priority-queue-run; do
  gh label create "${label}" --repo "${KITCHEN_REPO}" \
    --description "npm TL onboarding automation" --color "1D76DB" --force 2>/dev/null || true
done

created=0

while IFS= read -r entry; do
  candidate="$(jq -r '.candidate' <<<"${entry}")"
  rationale="$(jq -r '.rationale' <<<"${entry}")"
  demand="$(jq -r '.demand' <<<"${entry}")"
  affected="$(jq -c '.affected_packages' <<<"${entry}")"
  score="$(jq -r '.combined_score // empty' <<<"${entry}")"

  title="[npm-onboard] ${candidate}"
  body="$(cat <<EOF
## npm priority queue candidate

Automated by **npm-priority-queue** (Agent 1). Agent 2 (\`npm-recipe-draft\`) will run when \`/fs-onboard\` is posted below.

| Field | Value |
|-------|-------|
| Candidate | \`${candidate}\` |
| Combined score | ${score:-n/a} |
| Weekly npm downloads | ${demand} |
| Waiting packages | ${affected} |

### Rationale

${rationale}

---
*Do not edit the onboard comment — it triggers the recipe-draft harness.*
EOF
)"

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[post-priority] dry-run: would create issue for ${candidate}"
    continue
  fi

  issue_url="$(gh issue create \
    --repo "${KITCHEN_REPO}" \
    --title "${title}" \
    --body "${body}" \
    --label "npm-priority-candidate" \
    --label "npm-onboard")"

  issue_number="${issue_url##*/}"
  gh issue comment "${issue_number}" --repo "${KITCHEN_REPO}" \
    --body "/fs-onboard ${candidate}"

  echo "[post-priority] created ${issue_url} and posted /fs-onboard"
  created=$((created + 1))
done < <(jq -c '.entries[]' "${result_file}")

echo "[post-priority] dispatched ${created} onboard issue(s)"
