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

  it('ignores bash helper functions defined in the script', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail

path_under_out() {
  local rel="$1"
  echo "\${OUT_DIR}/\${rel#out/}"
}

tgz_has_member() {
  tar -tOf "$1" "$2" >/dev/null 2>&1
}

MAIN_PATH="$(path_under_out "\${MAIN_TGZ}")"
tgz_has_member "\${MAIN_PATH}" package/package.json
`;
    assert.deepEqual(validateShellCommandsForNpmBuilder(script, 'verify.smoke.sh'), []);
  });

  it('ignores jq filters inside quoted strings', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
MAIN="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "\${MANIFEST_PATH}")"
npm pack --quiet
`;
    assert.deepEqual(validateShellCommandsForNpmBuilder(script, 'build.entrypoint.sh'), []);
  });

  it('ignores inline JavaScript in heredocs and multiline node -e', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
node <<'NODE'
const { z } = require('zod');
const schema = z.object({ name: z.string() });
try {
  schema.parse({ name: 'async' });
  console.log('ok');
} catch (e) {
  console.error(e);
  process.exit(1);
}
NODE
node -e "
const x = 1;
console.log(x);
"
tar tf "\${MAIN_PATH}"
`;
    assert.deepEqual(validateShellCommandsForNpmBuilder(script, 'verify.smoke.sh'), []);
  });

  it('flags file(1) which is not in npm-builder', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
dump_tgz_listing() {
  tar tf "\$1" >&2 || file "\$1" >&2 || true
}
dump_tgz_listing /tmp/foo.tgz
`;
    const errors = validateShellCommandsForNpmBuilder(script, 'verify.smoke.sh');
    assert.ok(errors.some((e) => e.message.includes('command "file"')));
  });

  it('ignores git trailer lines like Assisted-by', () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
Assisted-by: Claude
npm pack --quiet
`;
    assert.deepEqual(validateShellCommandsForNpmBuilder(script, 'build.entrypoint.sh'), []);
  });
});
