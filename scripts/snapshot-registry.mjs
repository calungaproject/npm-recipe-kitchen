import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildRegistrySnapshot } from './lib/registry-snapshot.mjs';

// Read-only: snapshots recipe presence in an exact npm-registry checkout without changing it.
//
//   node scripts/snapshot-registry.mjs \
//     --registry-dir ../npm-registry-pinned \
//     --registry-ref <FULL_40_CHAR_SHA> \
//     [--repository calungaproject/npm-registry] \
//     [--out demo/output/registry-snapshot.json]

const { values } = parseArgs({
  options: {
    'registry-dir': { type: 'string' },
    'registry-ref': { type: 'string' },
    repository: { type: 'string' },
    out: { type: 'string' },
  },
});

if (!values['registry-dir'] || !values['registry-ref']) {
  console.error('Usage: snapshot-registry.mjs --registry-dir <dir> --registry-ref <full-sha> [--repository owner/repo] [--out <path>]');
  process.exit(2);
}

let snapshot;
try {
  snapshot = buildRegistrySnapshot({
    registryDir: values['registry-dir'],
    registryRef: values['registry-ref'],
    repository: values.repository,
  });
} catch (err) {
  console.error(`snapshot-registry: ${err.message}`);
  process.exit(1);
}

const serialized = JSON.stringify(snapshot, null, 2) + '\n';

if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, serialized);
  console.error(
    `Wrote registry snapshot for ${snapshot.repository} @ ${snapshot.commit_sha} ` +
      `(${snapshot.recipes.length} recipe_present) -> ${values.out}`,
  );
} else {
  process.stdout.write(serialized);
}
