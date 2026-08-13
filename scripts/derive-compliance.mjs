import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deriveProductionFacts } from './lib/lockfile.mjs';
import { createCatalog } from './lib/catalog.mjs';
import { deriveCompliance } from './lib/compliance.mjs';
import { validate } from './lib/validate.mjs';

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    lockfile: { type: 'string' },
    catalog: { type: 'string' },
    output: { type: 'string' },
    now: { type: 'string' },
  },
});

if (!values.manifest || !values.lockfile || !values.catalog) {
  console.error('Usage: derive-compliance --manifest <path> --lockfile <path> --catalog <path> [--output <path>] [--now <iso>]');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(values.manifest, 'utf-8'));
const lockfile = JSON.parse(readFileSync(values.lockfile, 'utf-8'));
const catalogJson = JSON.parse(readFileSync(values.catalog, 'utf-8'));

const now = values.now ? new Date(values.now) : new Date();
void now;

const facts = deriveProductionFacts(manifest, lockfile);
const catalog = createCatalog(catalogJson);
const consumer = `${manifest.name}@${manifest.version}`;

const { report } = deriveCompliance({
  consumer,
  directProduction: facts.directProduction,
  productionClosure: facts.productionClosure,
  catalog,
  requiresTlPackages: manifest.requires_tl_packages,
});

const result = validate('compliance', report);
if (!result.valid) {
  console.error('Output failed schema validation:');
  for (const e of result.errors) {
    console.error(`  ${e.path}: ${e.message}`);
  }
  process.exit(1);
}

const output = JSON.stringify(report, null, 2) + '\n';

if (values.output) {
  if (existsSync(values.output)) {
    const existing = readFileSync(values.output, 'utf-8');
    if (existing === output) {
      process.exit(0);
    }
  }
  writeFileSync(values.output, output);
} else {
  process.stdout.write(output);
}
