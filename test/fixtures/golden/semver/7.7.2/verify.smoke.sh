#!/usr/bin/env bash
# Post-build smoke checks for semver Tier A output.
set -euo pipefail

: "${MANIFEST_PATH:?MANIFEST_PATH required}"
: "${OUT_DIR:?OUT_DIR required}"

VERSION="$(jq -r .version "${MANIFEST_PATH}")"
MAIN_TGZ="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "${MANIFEST_PATH}")"

path_under_out() {
    local rel="$1"
    echo "${OUT_DIR}/${rel#out/}"
}

MAIN_PATH="$(path_under_out "${MAIN_TGZ}")"

echo "[verify.smoke] OUT_DIR=${OUT_DIR}" >&2
echo "[verify.smoke] MAIN_PATH=${MAIN_PATH}" >&2

[[ -f "${MAIN_PATH}" ]] || {
    echo "Missing tarball: ${MAIN_PATH}" >&2
    exit 1
}

tgz_has_member() {
    local tgz="$1" member="$2"
    tar -xOf "${tgz}" "${member}" >/dev/null 2>&1
}

dump_tgz_listing() {
    local tgz="$1"
    echo "Tarball listing (${tgz}):" >&2
    tar tf "${tgz}" >&2 || file "${tgz}" >&2 || true
}

for member in package/package.json package/index.js package/bin/semver.js; do
    tgz_has_member "${MAIN_PATH}" "${member}" || {
        echo "Main tarball missing ${member}" >&2
        dump_tgz_listing "${MAIN_PATH}"
        exit 1
    }
done

packed_name="$(tar -xOf "${MAIN_PATH}" package/package.json | jq -r .name)"
packed_version="$(tar -xOf "${MAIN_PATH}" package/package.json | jq -r .version)"
[[ "${packed_name}" == "semver" ]] || {
    echo "Unexpected package name: ${packed_name}" >&2
    exit 1
}
[[ "${packed_version}" == "${VERSION}" ]] || {
    echo "Unexpected package version: ${packed_version}" >&2
    exit 1
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

npm install --ignore-scripts --no-audit --no-fund --prefix "${tmpdir}" "${MAIN_PATH}"

echo "[verify.smoke] Testing module API"
node -e 'const semver = require(process.argv[1]); if (!semver.satisfies("7.7.2", "^7.0.0")) process.exit(1); console.log(semver.valid("7.7.2"))' "${tmpdir}/node_modules/semver"

echo "[verify.smoke] Testing CLI"
"${tmpdir}/node_modules/.bin/semver" -r '^7.0.0' 6.0.0 7.7.2

echo "[verify.smoke] OK"
