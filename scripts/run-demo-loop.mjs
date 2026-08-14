import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deriveProductionFacts } from './lib/lockfile.mjs';
import { deriveCompliance } from './lib/compliance.mjs';
import { createCatalog } from './lib/catalog.mjs';
import { scoreQueue, renderWhy } from './lib/queue.mjs';
import { promote } from './lib/promote.mjs';
import { validate } from './lib/validate.mjs';

const FIXED_PROMOTED_AT = '2026-08-14T00:00:00Z';
const CANDIDATE = 'semver@7.7.2';

const TIERS = {
  'semver@7.7.2': 'A',
  'chalk@5.4.1': 'B',
};

const { values } = parseArgs({
  options: {
    'output-dir': { type: 'string' },
  },
});

const outputDir = values['output-dir'] || 'demo/output';

const fixturesDir = new URL('../fixtures/', import.meta.url);
const consumersDir = new URL('consumers/', fixturesDir);

const catalogBefore = JSON.parse(readFileSync(new URL('catalog-before.json', fixturesDir), 'utf-8'));
const demandJson = JSON.parse(readFileSync(new URL('demand.json', fixturesDir), 'utf-8'));

const consumerNames = readdirSync(consumersDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const consumers = consumerNames.map(name => {
  const base = new URL(`${name}/`, consumersDir);
  const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf-8'));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', base), 'utf-8'));
  const facts = deriveProductionFacts(pkg, lock);
  return {
    name,
    consumer: `${pkg.name}@${pkg.version}`,
    directProduction: facts.directProduction,
    productionClosure: facts.productionClosure,
  };
});

mkdirSync(outputDir, { recursive: true });

function writeValidated(contractName, data, filename) {
  const result = validate(contractName, data);
  if (!result.valid) {
    console.error(`${filename} failed ${contractName} schema validation:`);
    for (const e of result.errors) {
      console.error(`  ${e.path}: ${e.message}`);
    }
    process.exit(1);
  }
  writeFileSync(`${outputDir}/${filename}`, JSON.stringify(data, null, 2) + '\n');
}

console.log('=== Before promotion ===\n');

for (const c of consumers) {
  const catalog = createCatalog(catalogBefore);
  const { report, level } = deriveCompliance({
    consumer: c.consumer,
    directProduction: c.directProduction,
    productionClosure: c.productionClosure,
    catalog,
  });
  writeValidated('compliance', report, `compliance-before-${c.name}.json`);
  console.log(`${c.consumer}: ${level} (gaps: ${report.closure_gaps.length})`);
}

const { queue: queueBefore, evidence: evidenceBefore } = scoreQueue({
  consumers,
  catalogJson: catalogBefore,
  demand: demandJson,
  tiers: TIERS,
});
writeValidated('queue', queueBefore, 'queue-before.json');

console.log(`\nQueue before (${queueBefore.entries.length} candidates):`);
for (const entry of queueBefore.entries) {
  const why = renderWhy(entry, evidenceBefore.get(entry.candidate));
  console.log(`  ${entry.candidate} — ${why}`);
}

console.log(`\n=== Promoting ${CANDIDATE} ===\n`);

const catalogAfter = promote({
  catalogJson: catalogBefore,
  candidate: CANDIDATE,
  promotedAt: FIXED_PROMOTED_AT,
});
writeValidated('catalog', catalogAfter, 'catalog-after.json');
console.log(`Promoted ${CANDIDATE} at ${FIXED_PROMOTED_AT}`);

console.log('\n=== After promotion ===\n');

for (const c of consumers) {
  const catalog = createCatalog(catalogAfter);
  const { report, level } = deriveCompliance({
    consumer: c.consumer,
    directProduction: c.directProduction,
    productionClosure: c.productionClosure,
    catalog,
  });
  writeValidated('compliance', report, `compliance-after-${c.name}.json`);
  console.log(`${c.consumer}: ${level} (gaps: ${report.closure_gaps.length})`);
}

const { queue: queueAfter, evidence: evidenceAfter } = scoreQueue({
  consumers,
  catalogJson: catalogAfter,
  demand: demandJson,
  tiers: TIERS,
});
writeValidated('queue', queueAfter, 'queue-after.json');

console.log(`\nQueue after (${queueAfter.entries.length} candidates):`);
for (const entry of queueAfter.entries) {
  const why = renderWhy(entry, evidenceAfter.get(entry.candidate));
  console.log(`  ${entry.candidate} — ${why}`);
}

console.log('\nAll artifacts written and validated.');
