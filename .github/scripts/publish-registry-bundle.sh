#!/usr/bin/env bash
# Publish a drafted npm-registry bundle from a fullsend harness artifact.
#
# Artifact contract (fullsend composite action v0.37.0):
#   - uploads actions artifact named fullsend-npm-recipe-draft from ${GITHUB_WORKSPACE}/output
#   - post-recipe-validate.sh writes output/registry-publish-request.json and
#     output/registry-bundle/ when DEFER_REGISTRY_PUBLISH=true and REGISTRY_PUSH_TOKEN
#     is absent from the harness env.
#
# Push targets come from trusted workflow configuration (vars), not the artifact.
set -euo pipefail

request_file="${1:-registry-publish-request.json}"
bundle_archive="${2:-registry-bundle}"

if [[ ! -f "${request_file}" ]]; then
  echo "::notice::No ${request_file}; nothing to publish"
  exit 0
fi

if [[ -z "${REGISTRY_PUSH_TOKEN:-}" ]]; then
  echo "::error::REGISTRY_PUSH_TOKEN secret is not set on this repository" >&2
  exit 1
fi

expected_registry_repo="${EXPECTED_REGISTRY_REPO:-calungaproject/npm-registry}"
trusted_push_repo="${REGISTRY_PUSH_REPO_FULL_NAME:-${expected_registry_repo}}"

identity="$(jq -r '.identity' "${request_file}")"
bundle_rel="$(jq -r '.bundle_rel' "${request_file}")"
issue_number="$(jq -r '.issue_number' "${request_file}")"
artifact_registry_repo="$(jq -r '.registry_repo' "${request_file}")"
target_branch="$(jq -r '.target_branch' "${request_file}")"
branch="$(jq -r '.branch' "${request_file}")"

if [[ -z "${identity}" || "${identity}" == "null" ]]; then
  echo "::error::registry-publish-request.json is missing identity" >&2
  exit 1
fi
if [[ "${artifact_registry_repo}" != "${expected_registry_repo}" ]]; then
  echo "::error::artifact registry_repo ${artifact_registry_repo} does not match expected ${expected_registry_repo}" >&2
  exit 1
fi
if [[ -z "${bundle_archive}" || ! -d "${bundle_archive}" ]]; then
  echo "::error::bundle archive ${bundle_archive:-<empty>} is missing" >&2
  exit 1
fi

pr_head="${branch}"
if [[ "${trusted_push_repo}" != "${expected_registry_repo}" ]]; then
  pr_head="${trusted_push_repo%%/*}:${branch}"
fi

publish_dir="$(mktemp -d)"
trap 'rm -rf -- "${publish_dir}"' EXIT

git -c protocol.version=2 clone --depth 1 --branch "${target_branch}" \
  "https://github.com/${expected_registry_repo}.git" \
  "${publish_dir}"
cd -- "${publish_dir}"
git config user.email "fullsend-bot@users.noreply.github.com"
git config user.name "fullsend-bot"
git checkout -B "${branch}"
bundle_dest="${publish_dir}/${bundle_rel}"
mkdir -p "$(dirname -- "${bundle_dest}")"
cp -a -- "${GITHUB_WORKSPACE}/${bundle_archive}/." "${bundle_dest}/"
manifest_path="${bundle_dest}/manifest.json"
if [[ -f "${manifest_path}" ]]; then
  entrypoint="$(jq -r '.entrypoint // empty' "${manifest_path}")"
  smoke="$(jq -r '.smoke // empty' "${manifest_path}")"
  if [[ -n "${entrypoint}" && -f "${bundle_dest}/${entrypoint}" ]]; then
    chmod +x "${bundle_dest}/${entrypoint}"
  fi
  if [[ -n "${smoke}" && -f "${bundle_dest}/${smoke}" ]]; then
    chmod +x "${bundle_dest}/${smoke}"
  fi
fi
git add -- "${bundle_rel}"
git commit -m "npm-recipe: onboard ${identity}" -m "Assisted-by: Claude"
push_url="https://x-access-token:${REGISTRY_PUSH_TOKEN}@github.com/${trusted_push_repo}.git"
if ! git push "${push_url}" "HEAD:${branch}"; then
  git push --force-with-lease "${push_url}" "HEAD:${branch}"
fi

pr_title="npm-recipe: onboard ${identity}"
pr_body="$(cat <<EOF
Automated npm recipe onboarding for \`${identity}\` (fixes #${issue_number}).

Rendered from trusted deterministic facts by the npm-recipe-draft gate.
EOF
)"
pr_token="${REGISTRY_PR_TOKEN:-${REGISTRY_PUSH_TOKEN}}"
compare_url="$(jq -nr \
  --arg base "${expected_registry_repo}" \
  --arg target "${target_branch}" \
  --arg head "${pr_head}" \
  --arg title "${pr_title}" \
  --arg body "${pr_body}" \
  '"https://github.com/\($base)/compare/\($target)...\($head)?quick_pull=1&title=" + ($title|@uri) + "&body=" + ($body|@uri)')"

open_registry_pr() {
  GH_TOKEN="${pr_token}" gh pr create \
    --repo "${expected_registry_repo}" \
    --head "${pr_head}" \
    --base "${target_branch}" \
    --title "${pr_title}" \
    --body "${pr_body}"
}

if open_registry_pr; then
  exit 0
fi

echo "::error::gh pr create failed for ${expected_registry_repo} (head ${pr_head})" >&2
echo "::error::Token must be allowed to create pull requests on ${expected_registry_repo}." >&2
echo "::error::Use a classic PAT with public_repo, or a fine-grained PAT with Pull requests: Read and write on ${expected_registry_repo}." >&2
echo "::error::Optionally set REGISTRY_PR_TOKEN to a separate PAT with those scopes; REGISTRY_PUSH_TOKEN can stay push-scoped." >&2
echo "::error::Open manually: ${compare_url}" >&2

kitchen_token="${KITCHEN_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "${issue_number}" || -z "${KITCHEN_REPO_FULL_NAME:-}" || -z "${kitchen_token}" ]]; then
  echo "::error::Cannot post manual PR link on kitchen issue (need issue_number, KITCHEN_REPO_FULL_NAME, and kitchen token)" >&2
  exit 1
fi

comment_body="$(cat <<EOF
Registry branch \`${branch}\` was pushed to \`${trusted_push_repo}\`, but automated PR creation failed (PAT cannot \`createPullRequest\` on \`${expected_registry_repo}\`).

[Open the npm-registry PR manually](${compare_url})

To automate PR creation, use a **classic** PAT with \`public_repo\` scope, or a **fine-grained** PAT with **Pull requests: Read and write** on \`${expected_registry_repo}\` (set \`REGISTRY_PR_TOKEN\`, or reuse \`REGISTRY_PUSH_TOKEN\` for both push and PR).
EOF
)"
GH_TOKEN="${kitchen_token}" gh issue comment "${issue_number}" \
  --repo "${KITCHEN_REPO_FULL_NAME}" \
  --body "${comment_body}"
echo "::warning::Push succeeded; posted manual PR link on issue #${issue_number}"
exit 0
