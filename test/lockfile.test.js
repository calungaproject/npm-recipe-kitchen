import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveProductionFacts } from '../scripts/lib/lockfile.mjs';

function loadConsumer(name) {
  const base = new URL(`../fixtures/consumers/${name}/`, import.meta.url);
  return {
    pkg: JSON.parse(readFileSync(new URL('package.json', base), 'utf-8')),
    lock: JSON.parse(readFileSync(new URL('package-lock.json', base), 'utf-8')),
  };
}

describe('deriveProductionFacts', () => {
  describe('checked-in fixtures', () => {
    it('app-a: transitive ms via debug', () => {
      const { pkg, lock } = loadConsumer('app-a');
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.directProduction, [
        'commander@13.1.0',
        'debug@4.4.1',
        'semver@7.7.2',
      ]);
      assert.deepStrictEqual(result.productionClosure, [
        'commander@13.1.0',
        'debug@4.4.1',
        'ms@2.1.3',
        'semver@7.7.2',
      ]);
    });

    it('app-b: flat closure, no transitive deps', () => {
      const { pkg, lock } = loadConsumer('app-b');
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.directProduction, [
        'ms@2.1.3',
        'semver@7.7.2',
      ]);
      assert.deepStrictEqual(result.productionClosure, [
        'ms@2.1.3',
        'semver@7.7.2',
      ]);
    });

    it('app-c: chalk v5 has zero runtime deps', () => {
      const { pkg, lock } = loadConsumer('app-c');
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.directProduction, [
        'chalk@5.4.1',
        'commander@13.1.0',
        'semver@7.7.2',
      ]);
      assert.deepStrictEqual(result.productionClosure, [
        'chalk@5.4.1',
        'commander@13.1.0',
        'semver@7.7.2',
      ]);
    });
  });

  describe('lockfile version support', () => {
    it('accepts lockfileVersion 2', () => {
      const pkg = { name: 'v2app', version: '1.0.0', dependencies: { example: '1.0.0' } };
      const lock = {
        lockfileVersion: 2,
        packages: {
          '': { name: 'v2app', version: '1.0.0', dependencies: { example: '1.0.0' } },
          'node_modules/example': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
          },
        },
      };
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.productionClosure, ['example@1.0.0']);
    });

    it('rejects lockfileVersion 1', () => {
      assert.throws(
        () => deriveProductionFacts({ name: 'x' }, { lockfileVersion: 1, dependencies: {} }),
        /Unsupported lockfileVersion 1/,
      );
    });

    it('rejects lockfileVersion 4', () => {
      assert.throws(
        () => deriveProductionFacts({ name: 'x' }, { lockfileVersion: 4, packages: {} }),
        /Unsupported lockfileVersion 4/,
      );
    });
  });

  describe('production dependency traversal', () => {
    it('includes root optionalDependencies as direct production', () => {
      const pkg = {
        name: 'opt-app', version: '1.0.0',
        dependencies: { required: '1.0.0' },
        optionalDependencies: { 'opt-pkg': '2.0.0' },
      };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'opt-app', version: '1.0.0' },
          'node_modules/required': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/required/-/required-1.0.0.tgz',
          },
          'node_modules/opt-pkg': {
            version: '2.0.0',
            resolved: 'https://registry.npmjs.org/opt-pkg/-/opt-pkg-2.0.0.tgz',
          },
        },
      };
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.directProduction, ['opt-pkg@2.0.0', 'required@1.0.0']);
      assert.deepStrictEqual(result.productionClosure, ['opt-pkg@2.0.0', 'required@1.0.0']);
    });

    it('excludes dev-only packages unreachable from production edges', () => {
      const pkg = {
        name: 'mixed', version: '1.0.0',
        dependencies: { prod: '1.0.0' },
        devDependencies: { 'dev-only': '3.0.0' },
      };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'mixed', version: '1.0.0' },
          'node_modules/prod': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/prod/-/prod-1.0.0.tgz',
          },
          'node_modules/dev-only': {
            version: '3.0.0',
            resolved: 'https://registry.npmjs.org/dev-only/-/dev-only-3.0.0.tgz',
            dev: true,
          },
        },
      };
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.productionClosure, ['prod@1.0.0']);
      assert.ok(!result.productionClosure.includes('dev-only@3.0.0'));
    });

    it('resolves scoped package identities', () => {
      const pkg = {
        name: 'scoped-app', version: '1.0.0',
        dependencies: { '@scope/pkg': '1.2.3' },
      };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'scoped-app', version: '1.0.0' },
          'node_modules/@scope/pkg': {
            version: '1.2.3',
            resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz',
          },
        },
      };
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.directProduction, ['@scope/pkg@1.2.3']);
      assert.deepStrictEqual(result.productionClosure, ['@scope/pkg@1.2.3']);
    });

    it('traverses nested node_modules resolution', () => {
      const pkg = {
        name: 'nested-app', version: '1.0.0',
        dependencies: { a: '1.0.0', b: '2.0.0' },
      };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'nested-app', version: '1.0.0' },
          'node_modules/a': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
            dependencies: { shared: '^1.0.0' },
          },
          'node_modules/b': {
            version: '2.0.0',
            resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz',
            dependencies: { shared: '^2.0.0' },
          },
          'node_modules/shared': {
            version: '1.5.0',
            resolved: 'https://registry.npmjs.org/shared/-/shared-1.5.0.tgz',
          },
          'node_modules/b/node_modules/shared': {
            version: '2.1.0',
            resolved: 'https://registry.npmjs.org/shared/-/shared-2.1.0.tgz',
          },
        },
      };
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.productionClosure, [
        'a@1.0.0',
        'b@2.0.0',
        'shared@1.5.0',
        'shared@2.1.0',
      ]);
    });

    it('returns stable sorted output regardless of dependency declaration order', () => {
      const pkg = {
        name: 'order-app', version: '1.0.0',
        dependencies: { z: '1.0.0', a: '1.0.0', m: '1.0.0' },
      };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'order-app', version: '1.0.0' },
          'node_modules/z': { version: '1.0.0', resolved: 'https://registry.npmjs.org/z/-/z-1.0.0.tgz' },
          'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
          'node_modules/m': { version: '1.0.0', resolved: 'https://registry.npmjs.org/m/-/m-1.0.0.tgz' },
        },
      };
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.directProduction, ['a@1.0.0', 'm@1.0.0', 'z@1.0.0']);
    });
  });

  describe('unsupported cases', () => {
    it('rejects workspaces', () => {
      const pkg = { name: 'ws', version: '1.0.0', workspaces: ['packages/*'] };
      const lock = {
        lockfileVersion: 3,
        packages: { '': { name: 'ws', version: '1.0.0' } },
      };
      assert.throws(
        () => deriveProductionFacts(pkg, lock),
        /Workspaces are not supported/,
      );
    });

    it('rejects git dependencies', () => {
      const pkg = { name: 'g', version: '1.0.0', dependencies: { 'git-pkg': '1.0.0' } };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'g', version: '1.0.0' },
          'node_modules/git-pkg': {
            version: '1.0.0',
            resolved: 'git+https://github.com/user/repo.git#abc123def456',
          },
        },
      };
      assert.throws(
        () => deriveProductionFacts(pkg, lock),
        /git dependency/,
      );
    });

    it('rejects file: dependencies', () => {
      const pkg = { name: 'f', version: '1.0.0', dependencies: { local: '1.0.0' } };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'f', version: '1.0.0' },
          'node_modules/local': {
            version: '1.0.0',
            resolved: 'file:../local-pkg',
          },
        },
      };
      assert.throws(
        () => deriveProductionFacts(pkg, lock),
        /file: dependency/,
      );
    });

    it('rejects link entries', () => {
      const pkg = { name: 'lnk', version: '1.0.0', dependencies: { linked: '1.0.0' } };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'lnk', version: '1.0.0' },
          'node_modules/linked': {
            version: '1.0.0',
            resolved: 'file:../linked',
            link: true,
          },
        },
      };
      assert.throws(
        () => deriveProductionFacts(pkg, lock),
        /link entry/,
      );
    });

    it('rejects reachable peerDependencies', () => {
      const pkg = { name: 'p', version: '1.0.0', dependencies: { 'has-peer': '1.0.0' } };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'p', version: '1.0.0' },
          'node_modules/has-peer': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/has-peer/-/has-peer-1.0.0.tgz',
            peerDependencies: { react: '>=18' },
          },
        },
      };
      assert.throws(
        () => deriveProductionFacts(pkg, lock),
        /peerDependencies.*not implemented/,
      );
    });

    it('rejects missing package version', () => {
      const pkg = { name: 'mv', version: '1.0.0', dependencies: { broken: '1.0.0' } };
      const lock = {
        lockfileVersion: 3,
        packages: {
          '': { name: 'mv', version: '1.0.0' },
          'node_modules/broken': {
            resolved: 'https://registry.npmjs.org/broken/-/broken-1.0.0.tgz',
          },
        },
      };
      assert.throws(
        () => deriveProductionFacts(pkg, lock),
        /Missing resolved package version/,
      );
    });

    it('rejects unresolvable required dependency', () => {
      const pkg = { name: 'ur', version: '1.0.0', dependencies: { ghost: '1.0.0' } };
      const lock = {
        lockfileVersion: 3,
        packages: { '': { name: 'ur', version: '1.0.0' } },
      };
      assert.throws(
        () => deriveProductionFacts(pkg, lock),
        /Cannot resolve root dependency "ghost"/,
      );
    });

    it('skips unresolvable optional dependency without throwing', () => {
      const pkg = {
        name: 'opt', version: '1.0.0',
        optionalDependencies: { 'platform-specific': '1.0.0' },
      };
      const lock = {
        lockfileVersion: 3,
        packages: { '': { name: 'opt', version: '1.0.0' } },
      };
      const result = deriveProductionFacts(pkg, lock);
      assert.deepStrictEqual(result.directProduction, []);
      assert.deepStrictEqual(result.productionClosure, []);
    });
  });
});
