#!/usr/bin/env bash
# Tier A factory build: semver from git source via npm pack (local checkout only).
# Writes only to OUT_DIR; must not publish.
set -euo pipefail

: "${MANIFEST_PATH:?MANIFEST_PATH required}"
: "${OUT_DIR:?OUT_DIR required}"
: "${WORK_DIR:?WORK_DIR required}"

VERSION="$(jq -r .version "${MANIFEST_PATH}")"
SOURCE_URL="$(jq -r .source.url "${MANIFEST_PATH}")"
SOURCE_REF="$(jq -r .source.ref "${MANIFEST_PATH}")"
MAIN_TGZ_REL="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "${MANIFEST_PATH}")"
main_tgz="${OUT_DIR}/${MAIN_TGZ_REL#out/}"

assert_tgz_has_member() {
    local tgz="$1" member="$2"
    tar -xOf "${tgz}" "${member}" >/dev/null 2>&1 || {
        echo "[build.entrypoint] ${tgz} missing ${member}" >&2
        echo "Tarball listing:" >&2
        tar tf "${tgz}" >&2 || file "${tgz}" >&2 || true
        exit 1
    }
}

SRC="${WORK_DIR}/semver-src"
rm -rf "${SRC}"
mkdir -p "${OUT_DIR}" "$(dirname "${main_tgz}")"

EXPECTED_SHA="281055e7716ef0415a8826972471331989ede58c"

echo "[build.entrypoint] Cloning ${SOURCE_URL} @ ${SOURCE_REF}"
git clone --no-checkout "${SOURCE_URL}" "${SRC}"

cd "${SRC}"
git checkout "${SOURCE_REF}"

actual_sha="$(git rev-parse HEAD)"
[[ "${actual_sha}" == "${EXPECTED_SHA}" ]] || {
    echo "Source commit ${actual_sha} != expected ${EXPECTED_SHA}" >&2
    exit 1
}

echo "[build.entrypoint] Packing from git checkout (npm pack)"
rm -f "${main_tgz}"
packed="$(npm pack --quiet --ignore-scripts)"
mv "${packed}" "${main_tgz}"

[[ -f "${main_tgz}" ]] || {
    echo "Expected tarball: ${main_tgz}" >&2
    exit 1
}

assert_tgz_has_member "${main_tgz}" package/package.json
assert_tgz_has_member "${main_tgz}" package/index.js
assert_tgz_has_member "${main_tgz}" package/bin/semver.js

packed_version="$(tar -xOf "${main_tgz}" package/package.json | jq -r .version)"
[[ "${packed_version}" == "${VERSION}" ]] || {
    echo "Packed version ${packed_version} != manifest ${VERSION}" >&2
    exit 1
}

echo "[build.entrypoint] Output: ${main_tgz}"
