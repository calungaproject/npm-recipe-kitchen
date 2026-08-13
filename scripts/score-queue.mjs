import { parseArgs } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { deriveProductionFacts } from './lib/lockfile.mjs';
import { scoreQueue, renderWhy } from './lib/queue.mjs';
import { validate } from './lib/validate.mjs';

const { values } = parseArgs({
  options: {
    'consumers-dir': { type: 'string' },
    catalog: { type: 'string' },
    demand: { type: 'string' },
    tiers: { type: 'string' },
    now: { type: 'string' },
  },
});

if (!values['consumers-dir'] || !values.catalog) {
  console.error(
    'Usage: score-queue --consumers-dir <dir> --catalog <path> ' +
    '[--demand <path>] [--tiers <json>] [--now <iso>]',
  );
  process.exit(1);
}

const now = values.now ? new Date(values.now) : new Date();
void now;

const catalogJson = JSON.parse(readFileSync(values.catalog, 'utf-8'));

const demandJson = values.demand
  ? JSON.parse(readFileSync(values.demand, 'utf-8'))
  : { packages: {} };

const tiers = values.tiers ? JSON.parse(values.tiers) : {};

const consumersDir = values['consumers-dir'];
const consumerNames = readdirSync(consumersDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const consumers = consumerNames.map(name => {
  const base = `${consumersDir}/${name}/`;
  const pkg = JSON.parse(readFileSync(`${base}package.json`, 'utf-8'));
  const lock = JSON.parse(readFileSync(`${base}package-lock.json`, 'utf-8'));
  const facts = deriveProductionFacts(pkg, lock);
  return {
    consumer: `${pkg.name}@${pkg.version}`,
    directProduction: facts.directProduction,
    productionClosure: facts.productionClosure,
  };
});

const { queue, evidence } = scoreQueue({ consumers, catalogJson, demand: demandJson, tiers });

const result = validate('queue', queue);
if (!result.valid) {
  console.error('Output failed schema validation:');
  for (const e of result.errors) {
    console.error(`  ${e.path}: ${e.message}`);
  }
  process.exit(1);
}

for (const entry of queue.entries) {
  const details = evidence.get(entry.candidate);
  const why = renderWhy(entry, details);
  console.log(`${entry.candidate}`);
  console.log(`  L3 unlocks: [${entry.immediate_l3_unlocks.join(', ')}]`);
  console.log(`  gap reductions: ${JSON.stringify(entry.gap_reductions)}`);
  console.log(`  affected: [${entry.affected_packages.join(', ')}]`);
  console.log(`  tier: ${entry.native_tier}  demand: ${entry.demand}`);
  console.log(`  why: ${why}`);
  console.log();
}

process.stdout.write(JSON.stringify(queue, null, 2) + '\n');
