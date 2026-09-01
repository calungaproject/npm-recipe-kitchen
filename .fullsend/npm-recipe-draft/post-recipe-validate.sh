#!/usr/bin/env bash
# Post-recipe validation: the deterministic safety gate.
#
# Runs on the runner after the agent exits, with cwd = the run directory.
# Fullsend blocks the result if this exits non-zero. It re-runs the semantic
# validator against the agent's recipe-result.json, then renders and publishes.
# Runner-side post-scripts don't get REPO_ROOT/FULLSEND_OUTPUT_DIR exported, so
# the repo root is derived from this script's own location.
set -euo pipefail

# Repo root is two dirs up from this script.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

# The validator needs ajv, but the managed workflow checks out without installing
# deps (node_modules/ is gitignored). Install prod deps from the lockfile on
# demand; guard on ajv so runs where deps exist skip the network round-trip.
# --ignore-scripts keeps package lifecycle scripts out of this trusted gate.
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
    # nullglob so a no-match glob expands to nothing; pick the highest iteration
    # number (numeric, so iteration-10 beats iteration-9).
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

# The exact fact bundle the pre-script produced. Reading this same file (not
# recomputing) binds validation and rendering to the facts the agent saw.
INPUT_FILE="${RECIPE_INPUT_FILE_RUNNER:-/tmp/fullsend-npm-recipe-draft/recipe-input.json}"

# Render into REPO_DIR — the sandbox working tree fullsend commits and pushes.
# REPO_ROOT (this config checkout) is never committed, so rendering there would
# silently drop the recipe from the PR. Fail closed if REPO_DIR is absent.
RENDER_ROOT="${REPO_DIR:?REPO_DIR is not set; refusing to render the recipe bundle into an unpublished checkout}"

# The node block writes its outcome to two files for the post-actions below.
# status_file holds only fields we generate (status, identity, output path);
# comment_body_file holds the human reason text, read by gh via --body-file so it
# never has to survive shell requoting.
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

// repoRoot LOCATES runner code + holds the kitchen-side audit artifact (not
// committed); renderRoot is the target-repo working tree the bundle lands in.
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

// Hand the outcome to the bash post-actions.
writeFileSync(statusFile, JSON.stringify({
  status: outcome.status,
  identity: outcome.identity ?? '',
  output_dir: outcome.rendered?.output_dir ?? '',
  audit_path: outcome.audit_path ?? '',
  draft_source_dir: outcome.draft_source_dir ?? '',
}) + '\n', 'utf-8');
writeFileSync(commentBodyFile, (outcome.message ?? '') + '\n', 'utf-8');
VALIDATE_EOF

echo "[post-validate] Passed"

# Post-actions: publish the validated outcome.
#
# Credentials are split by status:
#   drafted      -> REGISTRY_PUSH_TOKEN (optional fork) for npm-registry PR only
#   needs_human  -> PUSH_TOKEN (minted fullsend bot) for kitchen issue comment + draft PR
#   input_error  -> PUSH_TOKEN only (issue comment)

json_field() {
    # Read a top-level string field from the status file via node (already a hard
    # dependency of this gate).
    node -e 'const{readFileSync}=require("node:fs");const o=JSON.parse(readFileSync(process.argv[1],"utf-8"));process.stdout.write(String(o[process.argv[2]]??""))' \
        "${status_file}" "$1"
}

require_env() {
    # $1 = var name, $2 = action described in the failure message. Fail closed on
    # an unset/empty required var.
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "[post-validate] ${name} is not set; refusing to ${2}" >&2
        exit 1
    fi
}

sanitize_ref() {
    # Git ref-safe slug: collapse every non-alphanumeric run to a single '-' and
    # trim leading/trailing '-'. e.g. @scope/pkg@1.2.3 -> scope-pkg-1-2-3.
    local s="$1"
    s="${s//[^a-zA-Z0-9]/-}"
    while [[ "${s}" == *--* ]]; do s="${s//--/-}"; done
    s="${s#-}"; s="${s%-}"
    printf '%s' "${s}"
}


ensure_git_identity() {
    # harness-run sets no committer identity, so `git commit` would fail. Resolve
    # the minted bot's identity via the GraphQL viewer (PUSH_TOKEN), falling back
    # to a stable bot identity if the lookup fails. Set it locally in REPO_DIR.
    if [[ -n "$(git config user.email || true)" && -n "$(git config user.name || true)" ]]; then
        return 0
    fi
    local line
    if line="$(GH_TOKEN="${PUSH_TOKEN}" gh api graphql \
            -f query='{ viewer { login databaseId } }' \
            --jq '.data.viewer | "\(.databaseId)+\(.login)@users.noreply.github.com \(.login)"' 2>/dev/null)" \
        && [[ -n "${line}" && "${line}" == *" "* ]]; then
        git config user.email "${line%% *}"
        git config user.name "${line#* }"
    else
        git config user.email "fullsend-bot@users.noreply.github.com"
        git config user.name "fullsend-bot"
    fi
}

ensure_recipe_scripts_executable() {
    # Actions artifact upload/download does not preserve mode bits; npm-registry
    # lint-manifest.sh requires entrypoint and smoke scripts to be executable.
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

# Registry PR target (drafted → npm-registry). Kitchen repo (needs_human draft PR
# + issue comments). Fall back to harness env names for backward compatibility.
REGISTRY_REPO_FULL_NAME="${REGISTRY_REPO_FULL_NAME:-${REPO_FULL_NAME:-}}"
# Optional fork flow: push branch to REGISTRY_PUSH_REPO_FULL_NAME (e.g. your fork),
# open the PR against REGISTRY_REPO_FULL_NAME (upstream). When unset, both use
# REGISTRY_REPO_FULL_NAME (same-repo push + PR).
REGISTRY_PUSH_REPO_FULL_NAME="${REGISTRY_PUSH_REPO_FULL_NAME:-${REGISTRY_REPO_FULL_NAME}}"
KITCHEN_REPO_FULL_NAME="${KITCHEN_REPO_FULL_NAME:-${STATUS_REPO:-${REPO_FULL_NAME:-}}}"
ISSUE_NUMBER="${ISSUE_NUMBER:-${STATUS_NUMBER:-}}"
if [[ -z "${ISSUE_NUMBER}" && -n "${GITHUB_ISSUE_URL:-}" ]]; then
    ISSUE_NUMBER="${GITHUB_ISSUE_URL##*/}"
fi
TARGET_BRANCH="${TARGET_BRANCH:-main}"

case "${status}" in
    drafted)
        # Registry PR only. Minted PUSH_TOKEN is kitchen-scoped. Cross-repo publish
        # uses REGISTRY_PUSH_TOKEN when present in the harness env; otherwise the
        # post-script writes registry-publish-request.json for npm-recipe-registry-publish.yaml.
        require_env REGISTRY_REPO_FULL_NAME      "open the recipe PR"
        require_env REGISTRY_PUSH_REPO_FULL_NAME "push the recipe bundle"
        require_env ISSUE_NUMBER            "open the recipe PR"
        require_env TARGET_BRANCH           "open the recipe PR"
        if [[ -z "${identity}" || -z "${output_dir}" ]]; then
            echo "[post-validate] drafted outcome is missing identity/output_dir; refusing to open a PR" >&2
            exit 1
        fi
        if [[ ! -d "${output_dir}" ]]; then
            echo "[post-validate] rendered bundle dir ${output_dir} is absent; refusing to open a PR" >&2
            exit 1
        fi

        branch="agent/${ISSUE_NUMBER}-npm-recipe-$(sanitize_ref "${identity}")"
        pr_head="${branch}"
        if [[ "${REGISTRY_PUSH_REPO_FULL_NAME}" != "${REGISTRY_REPO_FULL_NAME}" ]]; then
            pr_head="${REGISTRY_PUSH_REPO_FULL_NAME%%/*}:${branch}"
        fi
        echo "[post-validate] Opening recipe PR for ${identity} on branch ${branch}"
        echo "[post-validate] Clone base=${REGISTRY_REPO_FULL_NAME}@${TARGET_BRANCH} push=${REGISTRY_PUSH_REPO_FULL_NAME} PR=${REGISTRY_REPO_FULL_NAME} head=${pr_head}"

        render_root="${RENDER_ROOT%/}"
        if [[ "${output_dir}" != "${render_root}"/* ]]; then
            echo "[post-validate] rendered bundle ${output_dir} is outside ${render_root}; refusing to publish" >&2
            exit 1
        fi
        bundle_rel="${output_dir#"${render_root}/"}"

        if [[ -z "${REGISTRY_PUSH_TOKEN:-}" ]]; then
            if [[ "${DEFER_REGISTRY_PUBLISH:-}" != "true" ]]; then
                echo "[post-validate] REGISTRY_PUSH_TOKEN is not set; refusing to publish to npm-registry" >&2
                echo "[post-validate] Set REGISTRY_PUSH_TOKEN in the harness env, or enable DEFER_REGISTRY_PUBLISH for deferred publish" >&2
                exit 1
            fi
            defer_dir="${GITHUB_WORKSPACE:-.}/output"
            bundle_archive="${defer_dir}/registry-bundle"
            mkdir -p "${bundle_archive}"
            cp -a -- "${output_dir}/." "${bundle_archive}/"
            ensure_recipe_scripts_executable "${bundle_archive}"
            jq -nc \
                --arg identity "${identity}" \
                --arg bundle_rel "${bundle_rel}" \
                --arg bundle_archive "registry-bundle" \
                --arg issue_number "${ISSUE_NUMBER}" \
                --arg registry_repo "${REGISTRY_REPO_FULL_NAME}" \
                --arg registry_push_repo "${REGISTRY_PUSH_REPO_FULL_NAME}" \
                --arg target_branch "${TARGET_BRANCH}" \
                --arg branch "${branch}" \
                --arg pr_head "${pr_head}" \
                --arg harness_run_id "${GITHUB_RUN_ID:-}" \
                '{identity:$identity,bundle_rel:$bundle_rel,bundle_archive:$bundle_archive,issue_number:$issue_number,registry_repo:$registry_repo,registry_push_repo:$registry_push_repo,target_branch:$target_branch,branch:$branch,pr_head:$pr_head,harness_run_id:$harness_run_id}' \
                > "${defer_dir}/registry-publish-request.json"
            echo "[post-validate] REGISTRY_PUSH_TOKEN not in harness env; deferred registry publish to npm-recipe-registry-publish job"
            exit 0
        fi

        registry_token="${REGISTRY_PUSH_TOKEN}"

        publish_dir="$(mktemp -d)"
        (
            trap 'rm -rf -- "${publish_dir}"' EXIT
            set -euo pipefail
            git -c protocol.version=2 clone --depth 1 --branch "${TARGET_BRANCH}" \
                "https://github.com/${REGISTRY_REPO_FULL_NAME}.git" \
                "${publish_dir}"
            cd -- "${publish_dir}"
            ensure_git_identity
            git checkout -B "${branch}"
            bundle_dest="${publish_dir}/${bundle_rel}"
            mkdir -p "$(dirname -- "${bundle_dest}")"
            cp -a -- "${output_dir}/." "${bundle_dest}/"
            ensure_recipe_scripts_executable "${bundle_dest}"
            git add -- "${bundle_rel}"
            git commit -m "npm-recipe: onboard ${identity}" -m "Assisted-by: Claude"
            push_url="https://x-access-token:${registry_token}@github.com/${REGISTRY_PUSH_REPO_FULL_NAME}.git"
            if ! git push "${push_url}" "HEAD:${branch}"; then
                git push --force-with-lease "${push_url}" "HEAD:${branch}"
            fi
            GH_TOKEN="${registry_token}" gh pr create \
                --repo "${REGISTRY_REPO_FULL_NAME}" \
                --head "${pr_head}" \
                --base "${TARGET_BRANCH}" \
                --title "npm-recipe: onboard ${identity}" \
                --body "Automated npm recipe onboarding for \`${identity}\` (fixes #${ISSUE_NUMBER}).

Rendered from trusted deterministic facts by the npm-recipe-draft gate."
        )
        echo "[post-validate] Recipe PR opened for ${identity}"
        ;;

    needs_human)
        # Kitchen-only path: minted PUSH_TOKEN only (no REGISTRY_PUSH_TOKEN).
        require_env KITCHEN_REPO_FULL_NAME "comment on the issue"
        require_env ISSUE_NUMBER           "comment on the issue"
        require_env PUSH_TOKEN             "comment on the issue"
        echo "[post-validate] needs_human outcome for ${identity:-<unknown>}: posting issue comment"
        GH_TOKEN="${PUSH_TOKEN}" gh issue comment "${ISSUE_NUMBER}" \
            --repo "${KITCHEN_REPO_FULL_NAME}" \
            --body-file "${comment_body_file}"

        if [[ -z "${identity}" ]]; then
            echo "[post-validate] needs_human without identity; no draft PR to open"
            exit 0
        fi

        draft_rel="$(REPO_ROOT="${REPO_ROOT}" IDENTITY="${identity}" \
            DRAFT_SOURCE_DIR="${draft_source_dir}" RESULT_FILE="${result_file}" \
            AUDIT_PATH="${audit_path}" REASON_FILE="${comment_body_file}" \
            node --input-type=module <<'STAGE_EOF'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repoRoot = process.env.REPO_ROOT;
const modUrl = pathToFileURL(`${repoRoot}/scripts/lib/stage-recipe-draft.mjs`).href;
const { stageRecipeDraft } = await import(modUrl);

const reason = readFileSync(process.env.REASON_FILE, 'utf-8');
const { draftRel } = stageRecipeDraft({
  kitchenRoot: repoRoot,
  identity: process.env.IDENTITY,
  draftSourceDir: process.env.DRAFT_SOURCE_DIR || '',
  resultPath: process.env.RESULT_FILE || '',
  auditPath: process.env.AUDIT_PATH || '',
  reason,
});
process.stdout.write(draftRel);
STAGE_EOF
        )"

        branch="agent/${ISSUE_NUMBER}-npm-recipe-draft-$(sanitize_ref "${identity}")"
        echo "[post-validate] Opening kitchen review draft PR for ${identity} on branch ${branch}"

        (
            cd -- "${REPO_ROOT}"
            ensure_git_identity
            git checkout -B "${branch}"
            git add -- "${draft_rel}"
            git commit -m "npm-recipe: draft ${identity} (needs_human)" -m "Assisted-by: Claude"
            git remote set-url origin "https://x-access-token:${PUSH_TOKEN}@github.com/${KITCHEN_REPO_FULL_NAME}.git"
            if ! git push -u origin -- "${branch}"; then
                git push -u origin --force-with-lease -- "${branch}"
            fi
            GH_TOKEN="${PUSH_TOKEN}" gh pr create \
                --repo "${KITCHEN_REPO_FULL_NAME}" \
                --head "${branch}" \
                --base "${TARGET_BRANCH}" \
                --title "npm-recipe: draft ${identity} (needs_human)" \
                --body "Review-only draft for \`${identity}\` (fixes #${ISSUE_NUMBER}).

This PR is **not** for \`calungaproject/npm-registry\`. It stages agent output under \`recipes/drafts/\` for human review after a \`needs_human\` outcome.

$(cat -- "${comment_body_file}")"
        )
        echo "[post-validate] Kitchen review draft PR opened for ${identity}"
        ;;

    input_error)
        require_env KITCHEN_REPO_FULL_NAME "comment on the issue"
        require_env ISSUE_NUMBER           "comment on the issue"
        require_env PUSH_TOKEN             "comment on the issue"
        echo "[post-validate] input_error outcome for ${identity:-<unknown>}: posting an issue comment, no PR"
        GH_TOKEN="${PUSH_TOKEN}" gh issue comment "${ISSUE_NUMBER}" \
            --repo "${KITCHEN_REPO_FULL_NAME}" \
            --body-file "${comment_body_file}"
        echo "[post-validate] Issue comment posted; no recipe bundle to publish"
        ;;

    *)
        echo "[post-validate] unexpected outcome status '${status}'; refusing to act" >&2
        exit 1
        ;;
esac
