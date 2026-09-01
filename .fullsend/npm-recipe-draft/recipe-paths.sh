#!/usr/bin/env bash
# Shared recipe path defaults for npm-recipe-draft.
#
# Agent (sandbox): write under RECIPE_PACKAGES_DIR (target-repo mount).
# Runner (validation_loop + post-recipe-validate): fullsend SafeDownload exposes
# the extracted tree as TARGET_REPO_DIR during validation and REPO_DIR during
# post-script — both should resolve to the same path when set together.
#
# Keep SANDBOX_RECIPE_PACKAGES_DIR in sync with env.sandbox.RECIPE_PACKAGES_DIR in
# ../harness/npm-recipe-draft.yaml.

SANDBOX_RECIPE_PACKAGES_DIR="/sandbox/workspace/target-repo/packages"
RECIPE_PACKAGES_DIR="${RECIPE_PACKAGES_DIR:-${SANDBOX_RECIPE_PACKAGES_DIR}}"

# Canonical extracted target-repo root on the runner (matches post-recipe-validate.sh).
runner_repo_root() {
  local repo_dir="" target_dir="" resolved=""

  if [[ -n "${REPO_DIR:-}" ]]; then
    if [[ ! -d "${REPO_DIR}" ]]; then
      echo "[recipe-paths] REPO_DIR is set but not a directory: ${REPO_DIR}" >&2
      return 1
    fi
    repo_dir="$(cd "${REPO_DIR}" && pwd -P)"
  fi
  if [[ -n "${TARGET_REPO_DIR:-}" ]]; then
    if [[ ! -d "${TARGET_REPO_DIR}" ]]; then
      echo "[recipe-paths] TARGET_REPO_DIR is set but not a directory: ${TARGET_REPO_DIR}" >&2
      return 1
    fi
    target_dir="$(cd "${TARGET_REPO_DIR}" && pwd -P)"
  fi

  if [[ -n "${repo_dir}" && -n "${target_dir}" ]]; then
    if [[ "${repo_dir}" != "${target_dir}" ]]; then
      echo "[recipe-paths] REPO_DIR (${repo_dir}) and TARGET_REPO_DIR (${target_dir}) must refer to the same extracted target-repo tree" >&2
      return 1
    fi
    resolved="${repo_dir}"
  elif [[ -n "${repo_dir}" ]]; then
    resolved="${repo_dir}"
  elif [[ -n "${target_dir}" ]]; then
    resolved="${target_dir}"
  elif [[ -d "target-repo" ]]; then
    resolved="$(cd target-repo && pwd -P)"
  else
    echo "[recipe-paths] no runner target-repo root found (set REPO_DIR or TARGET_REPO_DIR)" >&2
    return 1
  fi

  printf '%s' "${resolved}"
}

# Resolve packages/<name>/<version> base on the runner.
runner_recipe_packages_dir() {
  local root=""
  root="$(runner_repo_root)" || return 1
  printf '%s/packages' "${root}"
}
