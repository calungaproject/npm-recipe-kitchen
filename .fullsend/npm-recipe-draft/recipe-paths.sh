#!/usr/bin/env bash
# Shared recipe path defaults for npm-recipe-draft.
#
# Agent (sandbox): write under RECIPE_PACKAGES_DIR (target-repo mount).
# Runner (validation_loop + post-recipe-validate): fullsend SafeDownload exposes
# the extracted tree as TARGET_REPO_DIR during validation and REPO_DIR during
# post-script. The workflow also exports TARGET_REPO_DIR=target-repo (relative);
# ignore that when it is not a directory on the runner.
#
# Keep SANDBOX_RECIPE_PACKAGES_DIR in sync with env.sandbox.RECIPE_PACKAGES_DIR in
# ../harness/npm-recipe-draft.yaml.

SANDBOX_RECIPE_PACKAGES_DIR="/sandbox/workspace/target-repo/packages"
RECIPE_PACKAGES_DIR="${RECIPE_PACKAGES_DIR:-${SANDBOX_RECIPE_PACKAGES_DIR}}"

_resolve_dir() {
  local candidate="$1"
  if [[ -n "${candidate}" && -d "${candidate}" ]]; then
    (cd "${candidate}" && pwd -P)
  fi
}

# fullsend names the SafeDownload dir /tmp/<sandboxName> where sandboxName matches
# the run directory basename (output/fs-npm-…).
_fullsend_download_dir() {
  local run_name=""
  run_name="$(basename "$(pwd)")"
  if [[ -n "${run_name}" && -d "/tmp/${run_name}" ]]; then
    _resolve_dir "/tmp/${run_name}"
  fi
}

# Canonical extracted target-repo root on the runner (matches post-recipe-validate.sh).
runner_repo_root() {
  local repo_dir="" target_dir="" download_dir="" resolved=""

  repo_dir="$(_resolve_dir "${REPO_DIR:-}")"
  target_dir="$(_resolve_dir "${TARGET_REPO_DIR:-}")"
  download_dir="$(_fullsend_download_dir)"

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
  elif [[ -n "${download_dir}" ]]; then
    resolved="${download_dir}"
  else
    local relative=""
    relative="$(_resolve_dir "target-repo")"
    if [[ -n "${relative}" ]]; then
      resolved="${relative}"
    else
      echo "[recipe-paths] no runner target-repo root found (REPO_DIR, TARGET_REPO_DIR, or /tmp/$(basename "$(pwd)") )" >&2
      return 1
    fi
  fi

  printf '%s' "${resolved}"
}

# Resolve packages/<name>/<version> base on the runner.
runner_recipe_packages_dir() {
  local root=""
  root="$(runner_repo_root)" || return 1
  printf '%s/packages' "${root}"
}
