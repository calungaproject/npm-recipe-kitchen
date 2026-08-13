import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveProductionFacts } from '../scripts/lib/lockfile.mjs';
import { scoreQueue, renderWhy } from '../scripts/lib/queue.mjs';
import { validate } from '../scripts/lib/validate.mjs';

function loadConsumer(name) {
  const base = new URL(`../fixtures/consumers/${name}/`, import.meta.url);
  return {
    pkg: JSON.parse(readFileSync(new URL('package.json', base), 'utf-8')),
    lock: JSON.parse(readFileSync(new URL('package-lock.json', base), 'utf-8')),
  };
}

function buildConsumer(name) {
  const { pkg, lock } = loadConsumer(name);
  const facts = deriveProductionFacts(pkg, lock);
  return {
    consumer: `${pkg.name}@${pkg.version}`,
    directProduction: facts.directProduction,
    productionClosure: facts.productionClosure,
  };
}

function loadCatalog(name) {
  const path = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadDemand() {
  const path = new URL('../fixtures/demand.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const TIERS = {
  'semver@7.7.2': 'A',
  'chalk@5.4.1': 'B',
};

function runBeforePromotion() {
  const consumers = ['app-a', 'app-b', 'app-c'].map(buildConsumer);
  const catalogJson = loadCatalog('catalog-before');
  const demand = loadDemand();
  return scoreQueue({ consumers, catalogJson, demand, tiers: TIERS });
}

describe('scoreQueue', () => {
  describe('before promotion', () => {
    it('semver@7.7.2 ranks first', () => {
      const { queue } = runBeforePromotion();
      assert.strictEqual(queue.entries[0].candidate, 'semver@7.7.2');
    });

    it('semver immediate_l3_unlocks are app-a and app-b', () => {
      const { queue } = runBeforePromotion();
      const semver = queue.entries[0];
      assert.deepStrictEqual(semver.immediate_l3_unlocks, [
        'app-a@1.0.0',
        'app-b@1.0.0',
      ]);
    });

    it('app-c is a gap reduction for semver but not an L3 unlock', () => {
      const { queue } = runBeforePromotion();
      const semver = queue.entries[0];
      assert.ok(
        !semver.immediate_l3_unlocks.includes('app-c@1.0.0'),
        'app-c must not appear in immediate_l3_unlocks',
      );
      assert.ok(
        'app-c@1.0.0' in semver.gap_reductions,
        'app-c must appear in gap_reductions',
      );
      assert.strictEqual(semver.gap_reductions['app-c@1.0.0'], 1);
    });

    it('chalk does not receive false unlock credit from unrelated consumers', () => {
      const { queue } = runBeforePromotion();
      const chalk = queue.entries.find(e => e.candidate === 'chalk@5.4.1');
      assert.ok(chalk, 'chalk@5.4.1 must be in the queue');
      assert.deepStrictEqual(chalk.immediate_l3_unlocks, []);
      assert.deepStrictEqual(chalk.affected_packages, ['app-c@1.0.0']);
      assert.ok(
        !chalk.affected_packages.includes('app-a@1.0.0'),
        'app-a is unrelated to chalk',
      );
      assert.ok(
        !chalk.affected_packages.includes('app-b@1.0.0'),
        'app-b is unrelated to chalk',
      );
    });

    it('output validates against queue schema', () => {
      const { queue } = runBeforePromotion();
      const result = validate('queue', queue);
      assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    });

    it('results are stable across repeated runs', () => {
      const first = runBeforePromotion();
      const second = runBeforePromotion();
      assert.deepStrictEqual(first.queue, second.queue);
    });

    it('emits structured before/after evidence per candidate', () => {
      const { evidence } = runBeforePromotion();
      const semverEvidence = evidence.get('semver@7.7.2');
      assert.ok(semverEvidence, 'evidence must exist for semver@7.7.2');
      assert.strictEqual(semverEvidence.length, 3);

      const appA = semverEvidence.find(d => d.consumer === 'app-a@1.0.0');
      assert.ok(appA);
      assert.strictEqual(appA.before.level, 'L1');
      assert.strictEqual(appA.before.gap_count, 1);
      assert.strictEqual(appA.after.level, 'L3');
      assert.strictEqual(appA.after.gap_count, 0);

      const appC = semverEvidence.find(d => d.consumer === 'app-c@1.0.0');
      assert.ok(appC);
      assert.strictEqual(appC.before.gap_count, 2);
      assert.strictEqual(appC.after.gap_count, 1);
      assert.notStrictEqual(appC.after.level, 'L3');
    });
  });

  describe('renderWhy', () => {
    it('renders why from structured fields for semver', () => {
      const { queue, evidence } = runBeforePromotion();
      const semver = queue.entries[0];
      const why = renderWhy(semver, evidence.get(semver.candidate));
      assert.ok(why.includes('Unlocks L3'), 'must mention L3 unlock');
      assert.ok(why.includes('app-a@1.0.0'), 'must mention app-a');
      assert.ok(why.includes('app-b@1.0.0'), 'must mention app-b');
      assert.ok(why.includes('app-c@1.0.0'), 'must mention app-c gap reduction');
      assert.ok(why.includes('Reduces gaps'), 'must mention gap reduction');
    });

    it('renders why without L3 unlock section for chalk', () => {
      const { queue, evidence } = runBeforePromotion();
      const chalk = queue.entries.find(e => e.candidate === 'chalk@5.4.1');
      const why = renderWhy(chalk, evidence.get(chalk.candidate));
      assert.ok(!why.includes('Unlocks L3'), 'chalk has no L3 unlocks');
      assert.ok(why.includes('Reduces gaps'), 'must mention gap reduction');
      assert.ok(why.includes('app-c@1.0.0'), 'must mention app-c');
    });
  });

  describe('sort order', () => {
    it('sorts by immediate_l3_unlocks descending first', () => {
      const { queue } = runBeforePromotion();
      const [first, second] = queue.entries;
      assert.ok(
        first.immediate_l3_unlocks.length >= second.immediate_l3_unlocks.length,
        'first entry must have more or equal L3 unlocks',
      );
    });

    it('breaks ties with gap_reductions, tier, demand, then name', () => {
      const consumers = [buildConsumer('app-c')];
      const catalogJson = loadCatalog('catalog-before');
      const demand = { packages: { 'semver@7.7.2': 100, 'chalk@5.4.1': 100 } };
      const tiers = { 'semver@7.7.2': 'A', 'chalk@5.4.1': 'A' };
      const { queue } = scoreQueue({ consumers, catalogJson, demand, tiers });

      assert.strictEqual(queue.entries.length, 2);
      assert.strictEqual(queue.entries[0].candidate, 'chalk@5.4.1');
      assert.strictEqual(queue.entries[1].candidate, 'semver@7.7.2');
    });
  });
});
