import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseList,
  parseScalarAll,
  checkRoleConsistency,
  validateRoles,
} from '../scripts/lib/validate-roles.mjs';

describe('parseList', () => {
  it('parses an inline empty list', () => {
    assert.deepStrictEqual(parseList('roles: []', 'roles'), []);
  });

  it('parses a block sequence', () => {
    assert.deepStrictEqual(parseList('roles:\n    - coder\n    - review\n', 'roles'), [
      'coder',
      'review',
    ]);
  });

  it('parses an inline flow list', () => {
    assert.deepStrictEqual(parseList('roles: [coder, review]', 'roles'), ['coder', 'review']);
  });

  it('ignores trailing comments and blank lines', () => {
    assert.deepStrictEqual(parseList('roles:  # active roles\n    - coder\n\n', 'roles'), ['coder']);
  });

  it('returns null when the key is absent', () => {
    assert.strictEqual(parseList('other: 1', 'roles'), null);
  });

  it('stops the block sequence at the next top-level key', () => {
    assert.deepStrictEqual(parseList('roles:\n    - coder\nagents:\n    - name: x\n', 'roles'), [
      'coder',
    ]);
  });
});

describe('parseScalarAll', () => {
  it('collects scalars at any indentation', () => {
    const doc = 'agents:\n    - name: a\n      source: harness/a.yaml\n    - name: b\n      source: harness/b.yaml\n';
    assert.deepStrictEqual(parseScalarAll(doc, 'source'), ['harness/a.yaml', 'harness/b.yaml']);
  });
});

describe('checkRoleConsistency', () => {
  const harnesses = { 'harness/x.yaml': 'agent: x\nrole: coder\n' };
  const read = (source) => {
    if (!(source in harnesses)) throw new Error('ENOENT');
    return harnesses[source];
  };

  it('flags a harness role missing from config roles', () => {
    const config = 'roles: []\nagents:\n    - name: x\n      source: harness/x.yaml\n';
    const errors = checkRoleConsistency(config, read);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /role "coder"/);
    assert.match(errors[0], /not declared/);
  });

  it('passes when the role is declared', () => {
    const config = 'roles:\n    - coder\nagents:\n    - name: x\n      source: harness/x.yaml\n';
    assert.deepStrictEqual(checkRoleConsistency(config, read), []);
  });

  it('reports a harness that cannot be read', () => {
    const config = 'roles:\n    - coder\nagents:\n    - name: y\n      source: harness/missing.yaml\n';
    const errors = checkRoleConsistency(config, read);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /could not be read/);
  });
});

describe('repository configuration', () => {
  it('declares every harness role', () => {
    assert.deepStrictEqual(validateRoles(), []);
  });
});
