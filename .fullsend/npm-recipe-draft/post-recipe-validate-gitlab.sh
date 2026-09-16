#!/usr/bin/env bash
# Post-recipe validation: the deterministic safety gate (GitLab adaptation).
#
# GitLab fork of post-recipe-validate.sh for the Fullsend GitLab spike.
# Everything above the "Post-actions" section is identical to the GitHub
# version. Changes below that line:
#   - gh CLI            → curl to GitLab REST API
#   - PUSH_TOKEN        → GITLAB_TOKEN (personal or project access token)
#   - REGISTRY_PUSH_TOKEN → GITLAB_TOKEN (single PAT covers both repos in spike)
#   - github.com URLs   → GITLAB_HOST URLs
#   - Deferred publish  → removed (no Actions artifact dance; inline only)
#   - gh pr create      → POST /projects/:id/merge_requests
#   - gh issue comment  → POST /projects/:id/issues/:iid/notes
set -euo pipefail

# ── Forge-neutral: validation (identical to GitHub version) ──────────────

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

if [[ ! -d "${REPO_ROOT}/node_modules/ajv" ]]; then
    echo "[post-validate] Installing validator dependencies in ${REPO_ROOT}"
    (cd -- "${REPO_ROOT}" && npm ci --ignore-scripts --no-audit --no-fund --omit=dev)
fi

result_name="${FULLSEND_OUTPUT_FILE:-recipe-result.json}"

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
    echo "[post-validate] Missing ${result_name}: searched FULLSEND_VALIDATED_ITERATION_DIR, ./iteration-*/output, and FULLSEND_OUTPUT_DIR" >&2
    exit 1
fi

INPUT_FILE="${RECIPE_INPUT_FILE_RUNNER:-/tmp/fullsend-npm-recipe-draft/recipe-input.json}"

# shellcheck source=recipe-paths.sh
source "${script_dir}/recipe-paths.sh"
if ! RENDER_ROOT="$(runner_repo_root)"; then
  echo "[post-validate] REPO_DIR is not set or conflicts with TARGET_REPO_DIR; refusing to validate the recipe bundle" >&2
  exit 1
fi

status_file="$(mktemp)"
comment_body_file="$(mktemp)"
trap 'rm -f -- "${status_file}" "${comment_body_file}"' EXIT

echo "[post-validate] Validating ${result_file} against fact bundle ${INPUT_FILE}"
echo "[post-validate] Rendering recipe bundle into REPO_DIR=${RENDER_ROOT}"

REPO_ROOT="${REPO_ROOT}" RENDER_ROOT="${RENDER_ROOT}" RESULT_FILE="${result_file}" INPUT_FILE="${INPUT_FILE}" \
    STATUS_FILE="${status_file}" COMMENT_BODY_FILE="${comment_body_file}" \
    node --input-type=module <<'VALIDATE_EOF'
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const repoRoot = process.env.REPO_ROOT;
const renderRoot = process.env.RENDER_ROOT;
const resultPath = process.env.RESULT_FILE;
const inputPath = process.env.INPUT_FILE;
const statusFile = process.env.STATUS_FILE;
const commentBodyFile = process.env.COMMENT_BODY_FILE;

const modUrl = pathToFileURL(`${repoRoot}/scripts/lib/post-validate.mjs`).href;
const { runPostValidation } = await import(modUrl);

const outcome = runPostValidation({ resultPath, inputPath, repoRoot, renderRoot });

if (!outcome.ok) {
  console.error(`[post-validate] FAILED (${outcome.reason_code}): ${outcome.message || ''}`);
  for (const e of outcome.errors || []) {
    console.error(`  ${e.check || 'schema'}: ${e.path} — ${e.message}`);
  }
  process.exit(1);
}

console.log(`[post-validate] OK: status=${outcome.status}`);
if (outcome.rendered) {
  console.log(`[post-validate] Rendered ${outcome.rendered.files.length} file(s) to ${outcome.rendered.output_dir}`);
  for (const f of outcome.rendered.files) console.log(`  - ${f}`);
}
if (outcome.audit_path) {
  console.log(`[post-validate] Fact-bundle audit artifact: ${outcome.audit_path}`);
}

writeFileSync(statusFile, JSON.stringify({
  status: outcome.status,
  identity: outcome.identity ?? '',
  output_dir: outcome.rendered?.output_dir ?? '',
  audit_path: outcome.audit_path ?? '',
  draft_source_dir: outcome.draft_source_dir ?? '',
  auto_pr: outcome.status === 'drafted',
}) + '\n', 'utf-8');
writeFileSync(commentBodyFile, (outcome.message ?? '') + '\n', 'utf-8');
VALIDATE_EOF

echo "[post-validate] Passed"

# ── GitLab post-actions ──────────────────────────────────────────────────
#
# Credentials: a single GITLAB_TOKEN (personal or project access token with
# api scope) covers both the kitchen repo (issue comments) and the registry
# repo (push + MR creation). No deferred publish — inline only.

# GitLab instance. Default to gitlab.cee.redhat.com (Lightwell self-hosted).
GITLAB_HOST="${GITLAB_HOST:-gitlab.cee.redhat.com}"
GITLAB_API="https://${GITLAB_HOST}/api/v4"

# Resolve GITLAB_TOKEN from Fullsend's token or env.
GITLAB_TOKEN="${GITLAB_TOKEN:-${FULLSEND_MR_TOKEN:-}}"
if [[ -z "${GITLAB_TOKEN}" ]]; then
    echo "[post-validate] GITLAB_TOKEN (or FULLSEND_MR_TOKEN) is not set; cannot perform post-actions" >&2
    exit 1
fi

json_field() {
    node -e 'const{readFileSync}=require("node:fs");const o=JSON.parse(readFileSync(process.argv[1],"utf-8"));process.stdout.write(String(o[process.argv[2]]??""))' \
        "${status_file}" "$1"
}

require_env() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "[post-validate] ${name} is not set; refusing to ${2}" >&2
        exit 1
    fi
}

sanitize_ref() {
    local s="$1"
    s="${s//[^a-zA-Z0-9]/-}"
    while [[ "${s}" == *--* ]]; do s="${s//--/-}"; done
    s="${s#-}"; s="${s%-}"
    printf '%s' "${s}"
}

urlencode_path() {
    node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

gitlab_comment() {
    local project_path="$1" issue_iid="$2" body_file="$3"
    local encoded
    encoded="$(urlencode_path "${project_path}")"
    curl -sf --request POST \
        --header "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
        --header "Content-Type: application/json" \
        --data "$(jq -nc --rawfile body "${body_file}" '{body: $body}')" \
        "${GITLAB_API}/projects/${encoded}/issues/${issue_iid}/notes" >/dev/null
}

gitlab_create_mr() {
    local project_path="$1" source_branch="$2" target_branch="$3" title="$4" description="$5"
    local encoded
    encoded="$(urlencode_path "${project_path}")"
    curl -sf --request POST \
        --header "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
        --header "Content-Type: application/json" \
        --data "$(jq -nc \
            --arg src "${source_branch}" \
            --arg tgt "${target_branch}" \
            --arg t "${title}" \
            --arg d "${description}" \
            '{source_branch:$src,target_branch:$tgt,title:$t,description:$d}')" \
        "${GITLAB_API}/projects/${encoded}/merge_requests" >/dev/null
}

ensure_git_identity() {
    if [[ -n "$(git config user.email || true)" && -n "$(git config user.name || true)" ]]; then
        return 0
    fi
    local user_json
    if user_json="$(curl -sf --header "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
            "${GITLAB_API}/user" 2>/dev/null)"; then
        local username email
        username="$(printf '%s' "${user_json}" | jq -r '.username // empty')"
        email="$(printf '%s' "${user_json}" | jq -r '.email // empty')"
        if [[ -n "${username}" && -n "${email}" ]]; then
            git config user.email "${email}"
            git config user.name "${username}"
            return 0
        fi
    fi
    git config user.email "fullsend-bot@noreply.${GITLAB_HOST}"
    git config user.name "fullsend-bot"
}

ensure_recipe_scripts_executable() {
    local recipe_dir="$1"
    local manifest="${recipe_dir}/manifest.json"
    local entrypoint smoke

    [[ -f "${manifest}" ]] || return 0
    entrypoint="$(jq -r '.entrypoint // empty' "${manifest}")"
    smoke="$(jq -r '.smoke // empty' "${manifest}")"
    if [[ -n "${entrypoint}" && -f "${recipe_dir}/${entrypoint}" ]]; then
        chmod +x "${recipe_dir}/${entrypoint}"
    fi
    if [[ -n "${smoke}" && -f "${recipe_dir}/${smoke}" ]]; then
        chmod +x "${recipe_dir}/${smoke}"
    fi
}

status="$(json_field status)"
identity="$(json_field identity)"
output_dir="$(json_field output_dir)"
audit_path="$(json_field audit_path)"
draft_source_dir="$(json_field draft_source_dir)"
auto_pr="$(json_field auto_pr)"

REGISTRY_REPO_FULL_NAME="${REGISTRY_REPO_FULL_NAME:-${REPO_FULL_NAME:-}}"
REGISTRY_PUSH_REPO_FULL_NAME="${REGISTRY_PUSH_REPO_FULL_NAME:-${REGISTRY_REPO_FULL_NAME}}"
KITCHEN_REPO_FULL_NAME="${KITCHEN_REPO_FULL_NAME:-${STATUS_REPO:-${REPO_FULL_NAME:-}}}"
ISSUE_NUMBER="${ISSUE_NUMBER:-${STATUS_NUMBER:-}}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"

case "${status}" in
    drafted)
        require_env REGISTRY_REPO_FULL_NAME      "open the recipe MR"
        require_env ISSUE_NUMBER                  "open the recipe MR"
        require_env TARGET_BRANCH                 "open the recipe MR"
        if [[ -z "${identity}" || -z "${output_dir}" ]]; then
            echo "[post-validate] drafted outcome is missing identity/output_dir; refusing to open an MR" >&2
            exit 1
        fi
        if [[ ! -d "${output_dir}" ]]; then
            echo "[post-validate] rendered bundle dir ${output_dir} is absent; refusing to open an MR" >&2
            exit 1
        fi

        branch="agent/${ISSUE_NUMBER}-npm-recipe-$(sanitize_ref "${identity}")"
        echo "[post-validate] Opening recipe MR for ${identity} on branch ${branch}"
        echo "[post-validate] Clone base=${REGISTRY_PUSH_REPO_FULL_NAME}@${TARGET_BRANCH} MR=${REGISTRY_REPO_FULL_NAME}"

        render_root="${RENDER_ROOT%/}"
        if [[ "${output_dir}" != "${render_root}"/* ]]; then
            echo "[post-validate] rendered bundle ${output_dir} is outside ${render_root}; refusing to publish" >&2
            exit 1
        fi
        bundle_rel="${output_dir#"${render_root}/"}"

        publish_dir="$(mktemp -d)"
        (
            trap 'rm -rf -- "${publish_dir}"' EXIT
            set -euo pipefail
            git -c protocol.version=2 clone --depth 1 --branch "${TARGET_BRANCH}" \
                "https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${REGISTRY_PUSH_REPO_FULL_NAME}.git" \
                "${publish_dir}"
            cd -- "${publish_dir}"
            ensure_git_identity
            git checkout -B "${branch}"
            bundle_dest="${publish_dir}/${bundle_rel}"
            mkdir -p "$(dirname -- "${bundle_dest}")"
            cp -a -- "${output_dir}/." "${bundle_dest}/"
            ensure_recipe_scripts_executable "${bundle_dest}"
            git add -- "${bundle_rel}"
            git commit -m "npm-recipe: onboard ${identity}" -m "" -m "Assisted-by: Claude"
            push_url="https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${REGISTRY_PUSH_REPO_FULL_NAME}.git"
            if ! git push "${push_url}" "HEAD:${branch}"; then
                git push --force-with-lease "${push_url}" "HEAD:${branch}"
            fi
        )

        gitlab_create_mr \
            "${REGISTRY_REPO_FULL_NAME}" \
            "${branch}" \
            "${TARGET_BRANCH}" \
            "npm-recipe: onboard ${identity}" \
            "Automated npm recipe onboarding for \`${identity}\` (fixes #${ISSUE_NUMBER}).

Rendered from trusted deterministic facts by the npm-recipe-draft gate."

        echo "[post-validate] Recipe MR opened for ${identity}"
        ;;

    needs_human)
        require_env KITCHEN_REPO_FULL_NAME       "comment on the issue"
        require_env ISSUE_NUMBER                  "comment on the issue"
        require_env REGISTRY_REPO_FULL_NAME      "push needs_human recipe"
        require_env REGISTRY_PUSH_REPO_FULL_NAME "push needs_human recipe"
        if [[ -z "${identity}" || -z "${output_dir}" || ! -d "${output_dir}" ]]; then
            echo "[post-validate] needs_human is missing identity or recipe bundle; refusing" >&2
            exit 1
        fi

        echo "[post-validate] needs_human outcome for ${identity}: posting issue comment"
        gitlab_comment "${KITCHEN_REPO_FULL_NAME}" "${ISSUE_NUMBER}" "${comment_body_file}"

        render_root="${RENDER_ROOT%/}"
        if [[ "${output_dir}" != "${render_root}"/* ]]; then
            echo "[post-validate] rendered bundle ${output_dir} is outside ${render_root}; refusing to publish" >&2
            exit 1
        fi
        bundle_rel="${output_dir#"${render_root}/"}"

        branch="agent/${ISSUE_NUMBER}-npm-recipe-$(sanitize_ref "${identity}")"
        publish_dir="$(mktemp -d)"
        (
            trap 'rm -rf -- "${publish_dir}"' EXIT
            set -euo pipefail
            git -c protocol.version=2 clone --depth 1 --branch "${TARGET_BRANCH}" \
                "https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${REGISTRY_PUSH_REPO_FULL_NAME}.git" \
                "${publish_dir}"
            cd -- "${publish_dir}"
            ensure_git_identity
            git checkout -B "${branch}"
            bundle_dest="${publish_dir}/${bundle_rel}"
            mkdir -p "$(dirname -- "${bundle_dest}")"
            cp -a -- "${output_dir}/." "${bundle_dest}/"
            ensure_recipe_scripts_executable "${bundle_dest}"
            git add -- "${bundle_rel}"
            git commit -m "npm-recipe: onboard ${identity} (needs human review)" -m "" -m "Assisted-by: Claude"
            push_url="https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${REGISTRY_PUSH_REPO_FULL_NAME}.git"
            if ! git push "${push_url}" "HEAD:${branch}"; then
                git push --force-with-lease "${push_url}" "HEAD:${branch}"
            fi
        )

        echo "[post-validate] needs_human recipe pushed to ${branch}; manual MR required"
        ;;

    input_error)
        require_env KITCHEN_REPO_FULL_NAME "comment on the issue"
        require_env ISSUE_NUMBER           "comment on the issue"
        echo "[post-validate] input_error outcome for ${identity:-<unknown>}: posting an issue comment, no MR"
        gitlab_comment "${KITCHEN_REPO_FULL_NAME}" "${ISSUE_NUMBER}" "${comment_body_file}"
        echo "[post-validate] Issue comment posted; no recipe bundle to publish"
        ;;

    *)
        echo "[post-validate] unexpected outcome status '${status}'; refusing to act" >&2
        exit 1
        ;;
esac
