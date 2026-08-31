import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { recipeRelDir } from '../../scripts/lib/recipe-bundle.mjs';

const BUILD_ENTRYPOINT = `#!/usr/bin/env bash
set -euo pipefail

: "\${MANIFEST_PATH:?MANIFEST_PATH required}"
: "\${OUT_DIR:?OUT_DIR required}"
: "\${WORK_DIR:?WORK_DIR required}"

VERSION="$(jq -r .version "\${MANIFEST_PATH}")"
SOURCE_URL="$(jq -r .source.url "\${MANIFEST_PATH}")"
SOURCE_REF="$(jq -r .source.ref "\${MANIFEST_PATH}")"
MAIN_TGZ_REL="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "\${MANIFEST_PATH}")"
main_tgz="\${OUT_DIR}/\${MAIN_TGZ_REL#out/}"

SRC="\${WORK_DIR}/src"
rm -rf "\${SRC}"
mkdir -p "\${OUT_DIR}" "$(dirname "\${main_tgz}")"

git clone --depth 1 --branch "\${SOURCE_REF}" "\${SOURCE_URL}" "\${SRC}"
cd "\${SRC}"
rm -f "\${main_tgz}"
packed="$(npm pack --quiet)"
mv "\${packed}" "\${main_tgz}"
`;

const VERIFY_SMOKE = `#!/usr/bin/env bash
set -euo pipefail

: "\${MANIFEST_PATH:?MANIFEST_PATH required}"
: "\${OUT_DIR:?OUT_DIR required}"

MAIN_TGZ="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "\${MANIFEST_PATH}")"
MAIN_PATH="\${OUT_DIR}/\${MAIN_TGZ#out/}"
[[ -f "\${MAIN_PATH}" ]] || exit 1
tar -xOf "\${MAIN_PATH}" package/package.json >/dev/null
`;

/**
 * Write a minimal Tier A recipe bundle for post-validation tests.
 * @param {string} renderRoot
 * @param {object} facts  collector-shaped fact bundle
 */
export function writeMinimalTierARecipe(renderRoot, facts) {
  const rel = recipeRelDir(facts.package_name, facts.package_version);
  const dir = join(renderRoot, rel);
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name: facts.package_name,
    version: facts.package_version,
    description: `${facts.package_name} test recipe`,
    native_tier: 'A',
    source: {
      url: facts.source.git_url,
      ref: facts.source.tag ?? facts.source.commit_sha,
      ref_type: facts.source.tag ? 'tag' : 'commit',
    },
    upstream_npm: { version: facts.package_version },
    entrypoint: 'build.entrypoint.sh',
    smoke: 'verify.smoke.sh',
    outputs: [{
      id: 'main',
      type: 'npm-package',
      path: `out/${facts.package_name}-${facts.package_version}.tgz`,
      pulp_name: facts.package_name,
    }],
  };

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, 'build.entrypoint.sh'), BUILD_ENTRYPOINT);
  writeFileSync(join(dir, 'verify.smoke.sh'), VERIFY_SMOKE);
  chmodSync(join(dir, 'build.entrypoint.sh'), 0o755);
  chmodSync(join(dir, 'verify.smoke.sh'), 0o755);
  return dir;
}

export function draftResultFromFacts(facts, over = {}) {
  return {
    schema_version: 2,
    package: facts.identity,
    status: 'drafted',
    native_tier: over.native_tier ?? facts.native_tier ?? 'A',
    evidence: over.evidence ?? [{ kind: 'test', detail: 'fixture recipe bundle' }],
    confidence: over.confidence ?? 0.9,
    could_not_verify: over.could_not_verify ?? (facts.could_not_verify ?? []),
    ...over,
  };
}
