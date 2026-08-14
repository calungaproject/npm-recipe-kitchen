import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { promote, PromotionError } from '../scripts/lib/promote.mjs';
import { validate } from '../scripts/lib/validate.mjs';

function loadCatalog(name) {
  const path = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const PROMOTED_AT = '2026-08-14T00:00:00Z';

describe('promote', () => {
  describe('preconditions', () => {
    it('rejects a candidate not tracked in the catalog', () => {
      const catalogJson = loadCatalog('catalog-before');
      assert.throws(
        () => promote({ catalogJson, candidate: 'unknown@1.0.0', promotedAt: PROMOTED_AT }),
        (err) => {
          assert.ok(err instanceof PromotionError);
          assert.strictEqual(err.reason, 'not_tracked');
          return true;
        },
      );
    });

    it('rejects a candidate that is already available', () => {
      const catalogJson = loadCatalog('catalog-before');
      assert.throws(
        () => promote({ catalogJson, candidate: 'commander@13.1.0', promotedAt: PROMOTED_AT }),
        (err) => {
          assert.ok(err instanceof PromotionError);
          assert.strictEqual(err.reason, 'already_available');
          return true;
        },
      );
    });

    it('rejects an invalid candidate format', () => {
      const catalogJson = loadCatalog('catalog-before');
      assert.throws(
        () => promote({ catalogJson, candidate: 'not valid', promotedAt: PROMOTED_AT }),
        (err) => {
          assert.ok(err instanceof PromotionError);
          assert.strictEqual(err.reason, 'invalid_format');
          return true;
        },
      );
    });

    it('repeated promotion fails on second attempt', () => {
      const catalogJson = loadCatalog('catalog-before');
      const after = promote({ catalogJson, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT });
      assert.throws(
        () => promote({ catalogJson: after, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT }),
        (err) => {
          assert.ok(err instanceof PromotionError);
          assert.strictEqual(err.reason, 'already_available');
          return true;
        },
      );
    });
  });

  describe('successful promotion', () => {
    it('marks the candidate as available', () => {
      const catalogJson = loadCatalog('catalog-before');
      const after = promote({ catalogJson, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT });
      assert.strictEqual(after.entries['semver@7.7.2'].available, true);
    });

    it('records source as poc_mock_promotion', () => {
      const catalogJson = loadCatalog('catalog-before');
      const after = promote({ catalogJson, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT });
      assert.strictEqual(after.entries['semver@7.7.2'].source, 'poc_mock_promotion');
    });

    it('records the injected promoted_at timestamp', () => {
      const catalogJson = loadCatalog('catalog-before');
      const after = promote({ catalogJson, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT });
      assert.strictEqual(after.entries['semver@7.7.2'].promoted_at, PROMOTED_AT);
    });

    it('preserves other catalog entries unchanged', () => {
      const catalogJson = loadCatalog('catalog-before');
      const after = promote({ catalogJson, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT });
      assert.deepStrictEqual(after.entries['commander@13.1.0'], catalogJson.entries['commander@13.1.0']);
      assert.deepStrictEqual(after.entries['debug@4.4.1'], catalogJson.entries['debug@4.4.1']);
      assert.deepStrictEqual(after.entries['ms@2.1.3'], catalogJson.entries['ms@2.1.3']);
      assert.deepStrictEqual(after.entries['chalk@5.4.1'], catalogJson.entries['chalk@5.4.1']);
    });

    it('output validates against catalog schema', () => {
      const catalogJson = loadCatalog('catalog-before');
      const after = promote({ catalogJson, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT });
      const result = validate('catalog', after);
      assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    });

    it('does not mutate the input catalog', () => {
      const catalogJson = loadCatalog('catalog-before');
      const before = JSON.parse(JSON.stringify(catalogJson));
      promote({ catalogJson, candidate: 'semver@7.7.2', promotedAt: PROMOTED_AT });
      assert.deepStrictEqual(catalogJson, before);
    });
  });

  describe('CLI (promote-poc-package.mjs)', () => {
    const cli = new URL('../scripts/promote-poc-package.mjs', import.meta.url).pathname;
    const catalogPath = new URL('../fixtures/catalog-before.json', import.meta.url).pathname;

    it('promotes and produces valid catalog JSON', () => {
      const result = execFileSync('node', [
        cli,
        '--candidate', 'semver@7.7.2',
        '--catalog', catalogPath,
        '--promoted-at', PROMOTED_AT,
      ], { encoding: 'utf-8' });
      const parsed = JSON.parse(result);
      assert.strictEqual(parsed.entries['semver@7.7.2'].available, true);
      assert.strictEqual(parsed.entries['semver@7.7.2'].promoted_at, PROMOTED_AT);
      const v = validate('catalog', parsed);
      assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
    });

    it('exits non-zero for an already-available candidate', () => {
      assert.throws(() => {
        execFileSync('node', [
          cli,
          '--candidate', 'commander@13.1.0',
          '--catalog', catalogPath,
          '--promoted-at', PROMOTED_AT,
        ], { encoding: 'utf-8' });
      });
    });
  });
});
