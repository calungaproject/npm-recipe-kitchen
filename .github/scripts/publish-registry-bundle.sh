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
git add -- "${bundle_rel}"
git commit -m "npm-recipe: onboard ${identity}" -m "Assisted-by: Claude"
push_url="https://x-access-token:${REGISTRY_PUSH_TOKEN}@github.com/${trusted_push_repo}.git"
if ! git push "${push_url}" "HEAD:${branch}"; then
  git push --force-with-lease "${push_url}" "HEAD:${branch}"
fi
GH_TOKEN="${REGISTRY_PUSH_TOKEN}" gh pr create \
  --repo "${expected_registry_repo}" \
  --head "${pr_head}" \
  --base "${target_branch}" \
  --title "npm-recipe: onboard ${identity}" \
  --body "Automated npm recipe onboarding for \`${identity}\` (fixes #${issue_number}).

Rendered from trusted deterministic facts by the npm-recipe-draft gate."
