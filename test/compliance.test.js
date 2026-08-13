import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deriveProductionFacts } from '../scripts/lib/lockfile.mjs';
import { createCatalog } from '../scripts/lib/catalog.mjs';
import { deriveCompliance, DeclarationMismatchError } from '../scripts/lib/compliance.mjs';
import { validate } from '../scripts/lib/validate.mjs';

function loadConsumer(name) {
  const base = new URL(`../fixtures/consumers/${name}/`, import.meta.url);
  return {
    pkg: JSON.parse(readFileSync(new URL('package.json', base), 'utf-8')),
    lock: JSON.parse(readFileSync(new URL('package-lock.json', base), 'utf-8')),
  };
}

function loadCatalog(name) {
  const path = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function complianceFor(appName, catalogName) {
  const { pkg, lock } = loadConsumer(appName);
  const facts = deriveProductionFacts(pkg, lock);
  const catalog = createCatalog(loadCatalog(catalogName));
  return deriveCompliance({
    consumer: `${pkg.name}@${pkg.version}`,
    directProduction: facts.directProduction,
    productionClosure: facts.productionClosure,
    catalog,
  });
}

describe('catalog adapter', () => {
  it('reports available entries', () => {
    const catalog = createCatalog(loadCatalog('catalog-before'));
    assert.strictEqual(catalog.isAvailable('commander@13.1.0'), true);
    assert.strictEqual(catalog.isAvailable('debug@4.4.1'), true);
    assert.strictEqual(catalog.isAvailable('ms@2.1.3'), true);
  });

  it('reports unavailable entries', () => {
    const catalog = createCatalog(loadCatalog('catalog-before'));
    assert.strictEqual(catalog.isAvailable('semver@7.7.2'), false);
    assert.strictEqual(catalog.isAvailable('chalk@5.4.1'), false);
  });

  it('reports unknown entries as unavailable', () => {
    const catalog = createCatalog(loadCatalog('catalog-before'));
    assert.strictEqual(catalog.isAvailable('unknown@0.0.0'), false);
  });
});

describe('deriveCompliance', () => {
  describe('before promotion (catalog-before)', () => {
    it('app-a: L1 with semver as sole gap', () => {
      const { report, level } = complianceFor('app-a', 'catalog-before');
      assert.strictEqual(level, 'L1');
      assert.deepStrictEqual(report.closure_gaps, ['semver@7.7.2']);
    });

    it('app-b: L1 with semver as sole gap', () => {
      const { report, level } = complianceFor('app-b', 'catalog-before');
      assert.strictEqual(level, 'L1');
      assert.deepStrictEqual(report.closure_gaps, ['semver@7.7.2']);
    });

    it('app-c: L1 with chalk and semver as gaps', () => {
      const { report, level } = complianceFor('app-c', 'catalog-before');
      assert.strictEqual(level, 'L1');
      assert.deepStrictEqual(report.closure_gaps, ['chalk@5.4.1', 'semver@7.7.2']);
    });
  });

  describe('after promotion (catalog-after)', () => {
    it('app-a: L3 with no gaps', () => {
      const { report, level } = complianceFor('app-a', 'catalog-after');
      assert.strictEqual(level, 'L3');
      assert.deepStrictEqual(report.closure_gaps, []);
    });

    it('app-b: L3 with no gaps', () => {
      const { report, level } = complianceFor('app-b', 'catalog-after');
      assert.strictEqual(level, 'L3');
      assert.deepStrictEqual(report.closure_gaps, []);
    });

    it('app-c: below L3 with chalk as sole gap', () => {
      const { report, level } = complianceFor('app-c', 'catalog-after');
      assert.notStrictEqual(level, 'L3');
      assert.deepStrictEqual(report.closure_gaps, ['chalk@5.4.1']);
    });
  });

  describe('direct_required vs production_closure', () => {
    it('app-a direct_required excludes transitive ms@2.1.3', () => {
      const { report } = complianceFor('app-a', 'catalog-before');
      assert.deepStrictEqual(report.direct_required, [
        'commander@13.1.0',
        'debug@4.4.1',
        'semver@7.7.2',
      ]);
      assert.deepStrictEqual(report.production_closure, [
        'commander@13.1.0',
        'debug@4.4.1',
        'ms@2.1.3',
        'semver@7.7.2',
      ]);
      assert.ok(
        report.production_closure.length > report.direct_required.length,
        'production_closure must be larger than direct_required for app-a',
      );
    });

    it('L2 when all directs available but transitive ms is not', () => {
      const { pkg, lock } = loadConsumer('app-a');
      const facts = deriveProductionFacts(pkg, lock);
      const catalog = createCatalog({
        schema_version: 1,
        entries: {
          'commander@13.1.0': { available: true },
          'debug@4.4.1': { available: true },
          'semver@7.7.2': { available: true },
          'ms@2.1.3': { available: false },
        },
      });

      const { report, level } = deriveCompliance({
        consumer: `${pkg.name}@${pkg.version}`,
        directProduction: facts.directProduction,
        productionClosure: facts.productionClosure,
        catalog,
      });

      assert.strictEqual(level, 'L2');
      assert.deepStrictEqual(report.closure_gaps, ['ms@2.1.3']);
      assert.ok(
        !report.direct_required.includes('ms@2.1.3'),
        'ms@2.1.3 is transitive, not direct',
      );
    });

    it('app-b direct_required equals production_closure (flat graph)', () => {
      const { report } = complianceFor('app-b', 'catalog-before');
      assert.deepStrictEqual(report.direct_required, report.production_closure);
    });
  });

  describe('declaration mismatch', () => {
    it('throws when requires_tl_packages differs from direct_required', () => {
      const catalog = createCatalog({
        schema_version: 1,
        entries: {
          'a@1.0.0': { available: true },
          'b@1.0.0': { available: true },
        },
      });

      let caught;
      try {
        deriveCompliance({
          consumer: 'app@1.0.0',
          directProduction: ['a@1.0.0', 'b@1.0.0'],
          productionClosure: ['a@1.0.0', 'b@1.0.0'],
          catalog,
          requiresTlPackages: ['b@1.0.0', 'c@1.0.0'],
        });
        assert.fail('Expected DeclarationMismatchError');
      } catch (e) {
        caught = e;
      }

      assert.ok(caught instanceof DeclarationMismatchError);
      assert.deepStrictEqual(caught.added, ['a@1.0.0']);
      assert.deepStrictEqual(caught.missing, ['c@1.0.0']);
    });

    it('succeeds when requires_tl_packages matches direct_required exactly', () => {
      const catalog = createCatalog({
        schema_version: 1,
        entries: {
          'a@1.0.0': { available: true },
          'b@1.0.0': { available: true },
        },
      });

      const { level } = deriveCompliance({
        consumer: 'app@1.0.0',
        directProduction: ['a@1.0.0', 'b@1.0.0'],
        productionClosure: ['a@1.0.0', 'b@1.0.0'],
        catalog,
        requiresTlPackages: ['a@1.0.0', 'b@1.0.0'],
      });

      assert.strictEqual(level, 'L3');
    });
  });

  describe('schema validation', () => {
    it('every fixture report validates against compliance.schema.json', () => {
      for (const app of ['app-a', 'app-b', 'app-c']) {
        for (const cat of ['catalog-before', 'catalog-after']) {
          const { report } = complianceFor(app, cat);
          const result = validate('compliance', report);
          assert.strictEqual(
            result.valid,
            true,
            `${app} / ${cat}: ${JSON.stringify(result.errors)}`,
          );
        }
      }
    });

    it('arrays are sorted', () => {
      for (const app of ['app-a', 'app-b', 'app-c']) {
        const { report } = complianceFor(app, 'catalog-before');
        assert.deepStrictEqual(report.direct_required, [...report.direct_required].sort());
        assert.deepStrictEqual(report.production_closure, [...report.production_closure].sort());
        assert.deepStrictEqual(report.closure_gaps, [...report.closure_gaps].sort());
      }
    });
  });

  describe('CLI (derive-compliance.mjs)', () => {
    const cli = new URL('../scripts/derive-compliance.mjs', import.meta.url).pathname;

    function runCli(app, catalog, extraArgs = []) {
      const base = new URL(`../fixtures/consumers/${app}/`, import.meta.url).pathname;
      const catalogPath = new URL(`../fixtures/${catalog}.json`, import.meta.url).pathname;
      const result = execFileSync('node', [
        cli,
        '--manifest', `${base}package.json`,
        '--lockfile', `${base}package-lock.json`,
        '--catalog', catalogPath,
        '--now', '2026-08-13T00:00:00Z',
        ...extraArgs,
      ], { encoding: 'utf-8' });
      return JSON.parse(result);
    }

    it('CLI output validates against compliance.schema.json', () => {
      const output = runCli('app-a', 'catalog-before');
      const result = validate('compliance', output);
      assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    });

    it('CLI produces correct compliance for app-a catalog-after', () => {
      const output = runCli('app-a', 'catalog-after');
      assert.deepStrictEqual(output.closure_gaps, []);
    });

    it('CLI produces correct compliance for app-c catalog-after', () => {
      const output = runCli('app-c', 'catalog-after');
      assert.deepStrictEqual(output.closure_gaps, ['chalk@5.4.1']);
    });
  });
});
