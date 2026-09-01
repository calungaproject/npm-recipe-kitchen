#!/usr/bin/env bash
# Pre-script: deterministic priority shortlist for npm-priority-queue (Agent 1).
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${script_dir}/../.." && pwd)"

INPUT_FILE="/tmp/fullsend-npm-priority-queue/priority-input.json"
mkdir -p "$(dirname -- "${INPUT_FILE}")"

if [[ ! -d "${REPO_ROOT}/node_modules/ajv" ]]; then
  echo "[pre-priority] Installing validator dependencies in ${REPO_ROOT}"
  (cd -- "${REPO_ROOT}" && npm ci --ignore-scripts --no-audit --no-fund --omit=dev)
fi

# workflow_dispatch top_n may be embedded in the parent event payload JSON.
if [[ -z "${PRIORITY_QUEUE_TOP_N:-}" && -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
  PRIORITY_QUEUE_TOP_N="$(jq -r '.inputs.top_n // empty' "${GITHUB_EVENT_PATH}" 2>/dev/null || true)"
  export PRIORITY_QUEUE_TOP_N
fi
if [[ -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
  export PRIORITY_QUEUE_DRY_RUN="$(jq -r '.inputs.dry_run // "false"' "${GITHUB_EVENT_PATH}" 2>/dev/null || echo false)"
fi

if ! command -v oras >/dev/null 2>&1; then
  echo "[pre-priority] Installing oras for closure-index pull"
  ORAS_VERSION="1.2.2"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64|amd64) oras_arch="amd64" ;;
    aarch64|arm64) oras_arch="arm64" ;;
    *) echo "[pre-priority] unsupported arch for oras bootstrap: ${arch}" >&2; exit 1 ;;
  esac
  tmp_oras="$(mktemp -d)"
  curl -fsSL \
    "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_${oras_arch}.tar.gz" \
    | tar -xz -C "${tmp_oras}" oras
  export PATH="${tmp_oras}:${PATH}"
fi

PRIORITY_INPUT_FILE="${INPUT_FILE}" \
  node "${REPO_ROOT}/scripts/lib/collect-priority-cli.mjs"

echo "[pre-priority] done"
