import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggestCandidates, popularityRule, DEFAULT_RULES } from '../scripts/lib/suggest.mjs';
import { validate } from '../scripts/lib/validate.mjs';

function loadPopular() {
  const path = new URL('../fixtures/popular.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadCatalog(name) {
  const path = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function run() {
  return suggestCandidates({
    popular: loadPopular(),
    catalogJson: loadCatalog('catalog-before'),
  });
}

describe('suggestCandidates', () => {
  describe('popularity rule', () => {
    it('ranks by popularity score descending', () => {
      const { suggestions } = run();
      const order = suggestions.map(s => s.identity);
      assert.deepStrictEqual(order, [
        'lodash@4.17.21',
        'express@4.21.2',
        'semver@7.7.2',
        'commander@13.1.0',
        'chalk@5.4.1',
      ]);
    });

    it('assigns 1-based ranks in sorted order', () => {
      const { suggestions } = run();
      assert.deepStrictEqual(suggestions.map(s => s.rank), [1, 2, 3, 4, 5]);
      assert.strictEqual(suggestions[0].identity, 'lodash@4.17.21');
    });

    it('records the surfacing rule on each suggestion', () => {
      const { suggestions } = run();
      for (const s of suggestions) {
        assert.deepStrictEqual(s.rules, ['popularity']);
      }
    });

    it('breaks ties on identity ascending', () => {
      const popular = {
        source: 'test',
        captured_at: 'test',
        packages: {
          'bravo@1.0.0': { score: 100 },
          'alpha@1.0.0': { score: 100 },
        },
      };
      const { suggestions } = suggestCandidates({
        popular,
        catalogJson: { schema_version: 1, entries: {} },
      });
      assert.deepStrictEqual(suggestions.map(s => s.identity), [
        'alpha@1.0.0',
        'bravo@1.0.0',
      ]);
    });
  });

  describe('in_catalog', () => {
    it('is true only for packages available in the catalog', () => {
      const { suggestions } = run();
      const byId = Object.fromEntries(suggestions.map(s => [s.identity, s.in_catalog]));
      // commander@13.1.0 is available:true in catalog-before.json.
      assert.strictEqual(byId['commander@13.1.0'], true);
      // These are absent or available:false in catalog-before.json.
      assert.strictEqual(byId['semver@7.7.2'], false);
      assert.strictEqual(byId['chalk@5.4.1'], false);
      assert.strictEqual(byId['lodash@4.17.21'], false);
      assert.strictEqual(byId['express@4.21.2'], false);
    });

    it('distinguishes newly suggested from already-onboarded packages', () => {
      const { suggestions } = run();
      const fresh = suggestions.filter(s => !s.in_catalog).map(s => s.identity);
      const onboarded = suggestions.filter(s => s.in_catalog).map(s => s.identity);
      assert.ok(fresh.includes('lodash@4.17.21'), 'lodash is a new suggestion');
      assert.deepStrictEqual(onboarded, ['commander@13.1.0']);
    });
  });

  describe('determinism', () => {
    it('produces byte-for-byte identical output across two runs', () => {
      const first = run();
      const second = run();
      assert.deepStrictEqual(first, second);
      assert.strictEqual(
        JSON.stringify(first, null, 2),
        JSON.stringify(second, null, 2),
      );
    });
  });

  describe('pluggable rules', () => {
    it('exposes the popularity rule as the first default rule', () => {
      assert.strictEqual(DEFAULT_RULES[0], popularityRule);
      assert.strictEqual(popularityRule.name, 'popularity');
    });

    it('supports adding a second rule without changing the core', () => {
      const boostChalk = {
        name: 'chalk-boost',
        score(candidate) {
          return candidate.identity === 'chalk@5.4.1' ? 1000 : 0;
        },
      };
      const { suggestions } = suggestCandidates({
        popular: loadPopular(),
        catalogJson: loadCatalog('catalog-before'),
        rules: [popularityRule, boostChalk],
      });

      const chalk = suggestions.find(s => s.identity === 'chalk@5.4.1');
      assert.strictEqual(chalk.rank, 1, 'boosted chalk ranks first');
      assert.strictEqual(chalk.score, 1090, 'combined score sums both rules');
      assert.deepStrictEqual(chalk.rules, ['popularity', 'chalk-boost']);
    });

    it('respects per-rule weight in the combined score', () => {
      const weighted = { ...popularityRule, weight: 2 };
      const { suggestions } = suggestCandidates({
        popular: loadPopular(),
        catalogJson: loadCatalog('catalog-before'),
        rules: [weighted],
      });
      const lodash = suggestions.find(s => s.identity === 'lodash@4.17.21');
      assert.strictEqual(lodash.score, 1000);
    });
  });

  describe('schema', () => {
    it('produces an artifact that passes the suggestions schema', () => {
      const result = validate('suggestions', run());
      assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    });

    it('rejects a malformed artifact with an unknown field', () => {
      const artifact = run();
      artifact.suggestions[0].bogus = true;
      const result = validate('suggestions', artifact);
      assert.strictEqual(result.valid, false);
    });

    it('rejects a suggestion missing in_catalog', () => {
      const artifact = run();
      delete artifact.suggestions[0].in_catalog;
      const result = validate('suggestions', artifact);
      assert.strictEqual(result.valid, false);
    });

    it('rejects a malformed identity key', () => {
      const artifact = run();
      artifact.suggestions[0].identity = 'not a valid identity';
      const result = validate('suggestions', artifact);
      assert.strictEqual(result.valid, false);
    });
  });
});
