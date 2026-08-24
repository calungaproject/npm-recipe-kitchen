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

// Hand the outcome to the bash post-actions. `output_dir` is the absolute
// rendered bundle path (recipes/output/fullsend/<pkg>/<version>) — the ONLY
// path a drafted PR git-adds. Empty for needs_human/input_error (nothing
// renders). The reason text goes to the separate body file.
writeFileSync(statusFile, JSON.stringify({
  status: outcome.status,
  identity: outcome.identity ?? '',
  output_dir: outcome.rendered?.output_dir ?? '',
}) + '\n', 'utf-8');
writeFileSync(commentBodyFile, (outcome.message ?? '') + '\n', 'utf-8');
VALIDATE_EOF

echo "[post-validate] Passed"

# ---------------------------------------------------------------------------
# Post-actions: publish the validated outcome.
#
# fullsend's `run` step doesn't commit/push/open PRs — it hands us the sandbox
# working tree in REPO_DIR. A custom post_script fully replaces stock
# post-code.sh, so unless we act here no PR is ever opened.
#
#   drafted                   -> branch, add ONLY the rendered bundle, commit,
#                                push, open a PR against $TARGET_BRANCH.
#   needs_human / input_error -> render nothing; post the reason as an issue
#                                comment. No branch/commit/push/PR.
#
# We run via the leaner harness-run job (role `coder`, /fs-onboard trigger), not
# the stock `code` job, so ISSUE_NUMBER, TARGET_BRANCH, and the git committer
# identity aren't exported — we derive them below. Required env vars are guarded;
# a miss exits non-zero rather than open an empty PR.
# ---------------------------------------------------------------------------

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

status="$(json_field status)"
identity="$(json_field identity)"
output_dir="$(json_field output_dir)"

# Resolve the publish context, preferring stock env names then harness-run
# sources: ISSUE_NUMBER from STATUS_NUMBER or the issue URL's trailing segment;
# TARGET_BRANCH defaults to main (work_item events carry no base branch).
REPO_FULL_NAME="${REPO_FULL_NAME:-${STATUS_REPO:-}}"
ISSUE_NUMBER="${ISSUE_NUMBER:-${STATUS_NUMBER:-}}"
if [[ -z "${ISSUE_NUMBER}" && -n "${GITHUB_ISSUE_URL:-}" ]]; then
    ISSUE_NUMBER="${GITHUB_ISSUE_URL##*/}"
fi
TARGET_BRANCH="${TARGET_BRANCH:-main}"

case "${status}" in
    drafted)
        require_env PUSH_TOKEN     "push the recipe bundle"
        require_env REPO_FULL_NAME "push the recipe bundle"
        require_env ISSUE_NUMBER   "open the recipe PR"
        require_env TARGET_BRANCH  "open the recipe PR"
        if [[ -z "${identity}" || -z "${output_dir}" ]]; then
            echo "[post-validate] drafted outcome is missing identity/output_dir; refusing to open a PR" >&2
            exit 1
        fi
        if [[ ! -d "${output_dir}" ]]; then
            echo "[post-validate] rendered bundle dir ${output_dir} is absent; refusing to open a PR" >&2
            exit 1
        fi

        branch="agent/${ISSUE_NUMBER}-npm-recipe-$(sanitize_ref "${identity}")"
        echo "[post-validate] Opening recipe PR for ${identity} on branch ${branch}"

        (
            cd -- "${RENDER_ROOT}"
            ensure_git_identity
            git checkout -B "${branch}"
            # Stage ONLY the rendered bundle so unrelated target-repo working-tree
            # state never leaks into the registry PR diff. The kitchen-side audit
            # artifact lives under REPO_ROOT (gitignored) and is not in this tree.
            git add -- "${output_dir}"
            git commit -m "npm-recipe: onboard ${identity}" -m "Assisted-by: Claude"
            git remote set-url origin "https://x-access-token:${PUSH_TOKEN}@github.com/${REPO_FULL_NAME}.git"
            if ! git push -u origin -- "${branch}"; then
                git push -u origin --force-with-lease -- "${branch}"
            fi
            GH_TOKEN="${PUSH_TOKEN}" gh pr create \
                --repo "${REPO_FULL_NAME}" \
                --head "${branch}" \
                --base "${TARGET_BRANCH}" \
                --title "npm-recipe: onboard ${identity}" \
                --body "Automated npm recipe onboarding for \`${identity}\` (fixes #${ISSUE_NUMBER}).

Rendered from trusted deterministic facts by the npm-recipe-draft gate."
        )
        echo "[post-validate] Recipe PR opened for ${identity}"
        ;;

    needs_human|input_error)
        # No bundle renders for these outcomes, so there is nothing to push. Post
        # the reason back to the triggering issue instead.
        require_env REPO_FULL_NAME "comment on the issue"
        require_env ISSUE_NUMBER   "comment on the issue"
        require_env PUSH_TOKEN     "comment on the issue"
        echo "[post-validate] ${status} outcome for ${identity:-<unknown>}: posting an issue comment, no PR"
        GH_TOKEN="${PUSH_TOKEN}" gh issue comment "${ISSUE_NUMBER}" \
            --repo "${REPO_FULL_NAME}" \
            --body-file "${comment_body_file}"
        echo "[post-validate] Issue comment posted; no recipe bundle to publish"
        ;;

    *)
        echo "[post-validate] unexpected outcome status '${status}'; refusing to act" >&2
        exit 1
        ;;
esac
