import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderDraftBundle } from './lib/draft-bundle.mjs';

// Joins a validated Fullsend recipe result to a registry snapshot and writes a local handoff
// bundle (rendered files, hashes, and an unapplied apply.patch). Applies nothing; mutates no
// registry checkout. A fixed --now keeps repeated runs byte-for-byte stable.
//
//   node scripts/render-draft-bundle.mjs \
//     --recipe-result <path> \
//     --registry-snapshot demo/output/registry-snapshot.json \
//     [--out-dir demo/output/draft-bundle] \
//     [--now 2026-08-14T00:00:00Z]

const FIXED_NOW = '2026-08-14T00:00:00Z';

const { values } = parseArgs({
  options: {
    'recipe-result': { type: 'string' },
    'registry-snapshot': { type: 'string' },
    'out-dir': { type: 'string' },
    now: { type: 'string' },
  },
});

if (!values['recipe-result'] || !values['registry-snapshot']) {
  console.error('Usage: render-draft-bundle.mjs --recipe-result <path> --registry-snapshot <path> [--out-dir <dir>] [--now <iso>]');
  process.exit(2);
}

const recipeResult = JSON.parse(readFileSync(values['recipe-result'], 'utf-8'));
const registrySnapshot = JSON.parse(readFileSync(values['registry-snapshot'], 'utf-8'));
const repoRoot = process.cwd();

let result;
try {
  result = renderDraftBundle({
    recipeResult,
    registrySnapshot,
    repoRoot,
    now: values.now || FIXED_NOW,
    bundleBaseRel: values['out-dir'] || undefined,
  });
} catch (err) {
  console.error(`render-draft-bundle: ${err.message}`);
  process.exit(1);
}

const rel = (p) => (p ? resolve(p).replace(repoRoot + '/', '') : p);

if (result.status === 'needs_human') {
  console.log(`needs_human: wrote evidence bundle (no patch) -> ${rel(result.output_dir)}`);
} else {
  console.log(`drafted: wrote handoff bundle -> ${rel(result.output_dir)}`);
  console.log(`  files: ${result.files.join(', ')}`);
  console.log(`  patch: ${rel(result.patch)} (NOT applied)`);
  console.log(`  target: ${registrySnapshot.repository} @ ${registrySnapshot.commit_sha}`);
  if (result.already_present_in_registry_snapshot) {
    console.log('  note: an identical identity is already recipe_present in the registry snapshot');
  }
}
