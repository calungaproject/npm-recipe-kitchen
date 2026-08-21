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

# The EXACT fact bundle the pre-script produced for inference. Reading this same
# file (rather than recomputing facts) is what makes trusted-fact enforcement
# real: validation and rendering are bound to the facts the agent actually saw.
# This is the fixed runner path the pre-script wrote and host_files copied in.
INPUT_FILE="${RECIPE_INPUT_FILE_RUNNER:-/tmp/fullsend-npm-recipe-draft/recipe-input.json}"

# The recipe bundle must render into the checkout that CI actually commits and
# pushes: the sandbox working-tree fullsend downloads and exposes as REPO_DIR.
# REPO_ROOT (this config checkout) is never committed, so rendering there — the
# original bug — silently dropped the recipe files from the PR. Fail closed if
# REPO_DIR is absent rather than render into a tree nothing publishes.
RENDER_ROOT="${REPO_DIR:?REPO_DIR is not set; refusing to render the recipe bundle into an unpublished checkout}"

# The node block below writes its outcome to these two files so the post-actions
# section can decide what to publish. status_file holds only fields WE generate
# (status enum, validated identity, generated output path) — safe, machine
# readable. comment_body_file holds the human-readable reason text; routing it
# through a file means gh reads it via --body-file and it never has to survive
# shell requoting.
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
# fullsend's `run` step does NOT commit/push/open PRs — it downloads the sandbox
# working tree into REPO_DIR and hands it to this post-script. A custom
# post_script FULLY REPLACES stock post-code.sh, so unless we do it here NO PR is
# ever opened. Stock also assumes the AGENT committed in-sandbox; ours only
# writes recipe-result.json, so we add + commit the rendered bundle ourselves.
#
#   drafted                   -> branch, add ONLY the rendered bundle, commit,
#                                push, open a PR against $TARGET_BRANCH.
#   needs_human / input_error -> render nothing; post the reason as an issue
#                                comment. No branch/commit/push/PR.
#
# Every required env var is guarded and a miss exits non-zero: fail loudly rather
# than silently skip or open an empty PR. These creds come from the runner
# process env (run.go childScriptEnv), not from the harness file.
#
# IMPORTANT — our env is the leaner `harness-run` job, NOT the stock `code` job.
# A per-repo custom agent (role `coder`, trigger `/fs-onboard`) runs via
# fullsend's harness-dispatch/harness-run path, not the hardcoded `code` stage
# (there is no `/fs-onboard` route case; verified against fullsend v0.36.0
# reusable-dispatch.yml). That job exports only REPO_FULL_NAME + GITHUB_ISSUE_URL
# directly, plus STATUS_REPO/STATUS_NUMBER via the action, and sets NO
# ISSUE_NUMBER, NO TARGET_BRANCH, and NO git committer identity (those live only
# in the stock code/fix jobs). run.go childScriptEnv forwards the whole process
# env to us, so we derive the missing values below rather than fail on them.
# ---------------------------------------------------------------------------

json_field() {
    # Read a top-level string field from the status file. node is already a hard
    # requirement of this gate, so we lean on it rather than a shell JSON parser.
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
    # harness-run runs no "Resolve bot identity" step, so REPO_DIR has no
    # committer identity and `git commit` would fail with "Please tell me who you
    # are". Mirror the stock code job: resolve the minted bot's identity via the
    # GraphQL viewer using PUSH_TOKEN, falling back to a stable bot identity if
    # the lookup fails (e.g. a token that cannot query viewer). Set it locally in
    # the current repo (we are already cd'd into REPO_DIR).
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

# Resolve the publish context from the vars harness-run actually exports. Prefer
# the stock names (present if this ever runs in the code job), then fall back to
# the harness-run sources. REPO_FULL_NAME is set directly; ISSUE_NUMBER comes
# from STATUS_NUMBER (matrix.status_number = the work item's id) or, failing
# that, the trailing segment of the issue URL. work_item events carry no base
# branch anywhere, so TARGET_BRANCH defaults to main (mirroring the code job).
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
