import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractExternalCommands, validateShellCommandsForNpmBuilder } from '../scripts/lib/validate-shell-commands.mjs';
import { loadNpmBuilderInventory } from '../scripts/lib/npm-builder-inventory.mjs';

describe('npm-builder inventory (from Containerfile)', () => {
  it('loads allowed commands from pinned snapshot', () => {
    const { commands } = loadNpmBuilderInventory();
    assert.ok(commands.has('npm'));
    assert.ok(commands.has('node'));
    assert.ok(commands.has('make'));
  });
});

describe('validateShellCommandsForNpmBuilder', () => {
  it('allows typical factory commands', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
git clone --depth 1 "${'${SOURCE_URL}'}" src
cd src
npm install --ignore-scripts
npm run build
node scripts/pack.js
`;
    assert.deepEqual(validateShellCommandsForNpmBuilder(script, 'build.entrypoint.sh'), []);
  });

  it('flags commands missing from npm-builder', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
pnpm install
deno task build
`;
    const errors = validateShellCommandsForNpmBuilder(script, 'build.entrypoint.sh');
    assert.equal(errors.length, 2);
    assert.ok(errors.some((e) => e.message.includes('pnpm')));
    assert.ok(errors.some((e) => e.message.includes('deno')));
  });

  it('extracts commands across pipes and chains', () => {
    const names = extractExternalCommands('set -e; npm test && node -e "1" | jq .');
    assert.ok(names.includes('npm'));
    assert.ok(names.includes('node'));
    assert.ok(names.includes('jq'));
    assert.ok(!names.includes('-r'));
  });

  it('ignores jq filters inside quoted strings', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
MAIN="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "\${MANIFEST_PATH}")"
npm pack --quiet
`;
    assert.deepEqual(validateShellCommandsForNpmBuilder(script, 'build.entrypoint.sh'), []);
  });
});
