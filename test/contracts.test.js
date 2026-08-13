import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, CONTRACT_NAMES } from '../scripts/lib/validate.mjs';

function loadFixture(contract, name) {
  const path = new URL(`fixtures/contracts/${contract}/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('validate', () => {
  it('rejects an unknown contract name', () => {
    assert.throws(() => validate('nope', {}), /Unknown contract/);
  });

  it('exports the list of contract names', () => {
    assert.deepStrictEqual(CONTRACT_NAMES, [
      'catalog',
      'compliance',
      'queue',
      'recipe-result',
      'registry-snapshot',
    ]);
  });
});

describe('catalog', () => {
  it('accepts the valid fixture', () => {
    const result = validate('catalog', loadFixture('catalog', 'valid'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects an entry missing the available field', () => {
    const result = validate('catalog', loadFixture('catalog', 'invalid-missing-available'));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.params?.missingProperty === 'available'));
  });

  it('rejects unknown top-level fields', () => {
    const result = validate('catalog', {
      schema_version: 1,
      entries: {},
      extra: true,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message?.includes('additional properties')));
  });

  it('rejects unknown fields inside an entry', () => {
    const result = validate('catalog', {
      schema_version: 1,
      entries: { 'semver@7.7.2': { available: true, spurious: 1 } },
    });
    assert.strictEqual(result.valid, false);
  });

  it('rejects a malformed entry key', () => {
    const result = validate('catalog', {
      schema_version: 1,
      entries: { 'not a valid key': { available: true } },
    });
    assert.strictEqual(result.valid, false);
  });

  it('rejects schema_version other than 1', () => {
    const result = validate('catalog', {
      schema_version: 2,
      entries: {},
    });
    assert.strictEqual(result.valid, false);
  });

  it('rejects a bare trailing hyphen in a version suffix', () => {
    const result = validate('catalog', {
      schema_version: 1,
      entries: { 'pkg@1.0.0-': { available: true } },
    });
    assert.strictEqual(result.valid, false);
  });

  it('accepts scoped package keys', () => {
    const result = validate('catalog', {
      schema_version: 1,
      entries: { '@scope/pkg@1.0.0': { available: true } },
    });
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });
});

describe('compliance', () => {
  it('accepts the valid fixture', () => {
    const result = validate('compliance', loadFixture('compliance', 'valid'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects when a closure_gap is not in production_closure (semantic)', () => {
    const result = validate('compliance', loadFixture('compliance', 'invalid-gap-not-in-closure'));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message?.includes('production_closure')));
  });

  it('rejects when a direct_required entry is not in production_closure (semantic)', () => {
    const result = validate('compliance', {
      schema_version: 1,
      consumer: 'app@1.0.0',
      direct_required: ['missing@1.0.0'],
      production_closure: ['other@2.0.0'],
      closure_gaps: [],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.startsWith('/direct_required')));
  });

  it('rejects missing fields', () => {
    const result = validate('compliance', { schema_version: 1, consumer: 'app@1.0.0' });
    assert.strictEqual(result.valid, false);
  });

  it('rejects duplicate entries in arrays', () => {
    const result = validate('compliance', {
      schema_version: 1,
      consumer: 'app@1.0.0',
      direct_required: ['a@1.0.0', 'a@1.0.0'],
      production_closure: ['a@1.0.0'],
      closure_gaps: [],
    });
    assert.strictEqual(result.valid, false);
  });
});

describe('queue', () => {
  it('accepts the valid fixture', () => {
    const result = validate('queue', loadFixture('queue', 'valid'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects negative demand', () => {
    const result = validate('queue', loadFixture('queue', 'invalid-negative-demand'));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.includes('demand')));
  });

  it('rejects when immediate_l3_unlocks entry not in affected_packages (semantic)', () => {
    const result = validate('queue', {
      schema_version: 1,
      entries: [{
        candidate: 'pkg@1.0.0',
        immediate_l3_unlocks: ['ghost@1.0.0'],
        gap_reductions: {},
        affected_packages: ['other@1.0.0'],
        native_tier: 'B',
        demand: 0,
      }],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message?.includes('affected_packages')));
  });

  it('rejects when a gap_reductions key is not in affected_packages (semantic)', () => {
    const result = validate('queue', {
      schema_version: 1,
      entries: [{
        candidate: 'pkg@1.0.0',
        immediate_l3_unlocks: [],
        gap_reductions: { 'phantom@1.0.0': 2 },
        affected_packages: [],
        native_tier: 'A',
        demand: 1,
      }],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message?.includes('gap_reductions key')));
  });

  it('rejects unknown fields in queue entries', () => {
    const result = validate('queue', {
      schema_version: 1,
      entries: [{
        candidate: 'pkg@1.0.0',
        immediate_l3_unlocks: [],
        gap_reductions: {},
        affected_packages: [],
        native_tier: 'A',
        demand: 0,
        score: 42,
      }],
    });
    assert.strictEqual(result.valid, false);
  });
});

describe('recipe-result', () => {
  it('accepts a drafted result', () => {
    const result = validate('recipe-result', loadFixture('recipe-result', 'valid-drafted'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('accepts a needs_human result', () => {
    const result = validate('recipe-result', loadFixture('recipe-result', 'valid-needs-human'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects an unknown template_id', () => {
    const result = validate('recipe-result', loadFixture('recipe-result', 'invalid-unknown-template'));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.includes('template_id')));
  });

  it('rejects drafted with needs_human fields present', () => {
    const drafted = loadFixture('recipe-result', 'valid-drafted');
    drafted.reason = 'should not be here';
    const result = validate('recipe-result', drafted);
    assert.strictEqual(result.valid, false);
  });

  it('rejects needs_human with drafted fields present', () => {
    const human = loadFixture('recipe-result', 'valid-needs-human');
    human.template_id = 'source-build';
    const result = validate('recipe-result', human);
    assert.strictEqual(result.valid, false);
  });

  it('rejects a parameter whose value type mismatches its declared type (semantic)', () => {
    const doc = loadFixture('recipe-result', 'valid-drafted');
    doc.parameters.bad = { type: 'integer', value: 'not-a-number' };
    const result = validate('recipe-result', doc);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.includes('/parameters/bad/value')));
  });

  it('rejects confidence outside 0-1', () => {
    const doc = loadFixture('recipe-result', 'valid-drafted');
    doc.confidence = 1.5;
    const result = validate('recipe-result', doc);
    assert.strictEqual(result.valid, false);
  });

  it('rejects an unconstrained top-level field', () => {
    const doc = loadFixture('recipe-result', 'valid-drafted');
    doc.files = { '/etc/shadow': 'pwned' };
    const result = validate('recipe-result', doc);
    assert.strictEqual(result.valid, false);
  });

  it('rejects a reason that exceeds the bound', () => {
    const result = validate('recipe-result', {
      schema_version: 1,
      package: 'pkg@1.0.0',
      status: 'needs_human',
      reason: 'x'.repeat(501),
      escalation_target: 'team',
    });
    assert.strictEqual(result.valid, false);
  });
});

describe('registry-snapshot', () => {
  it('accepts the valid fixture', () => {
    const result = validate('registry-snapshot', loadFixture('registry-snapshot', 'valid'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects state "available" (must be "recipe_present")', () => {
    const result = validate('registry-snapshot', loadFixture('registry-snapshot', 'invalid-state-available'));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.includes('state')));
  });

  it('rejects a short commit SHA', () => {
    const result = validate('registry-snapshot', {
      schema_version: 1,
      repository: 'repo',
      commit_sha: 'abc123',
      recipes: [],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.includes('commit_sha')));
  });

  it('rejects unknown fields in recipe entries', () => {
    const result = validate('registry-snapshot', {
      schema_version: 1,
      repository: 'repo',
      commit_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      recipes: [{
        identity: 'pkg@1.0.0',
        path: 'recipes/pkg/1.0.0',
        state: 'recipe_present',
        available: true,
      }],
    });
    assert.strictEqual(result.valid, false);
  });

  it('rejects uppercase hex in commit SHA', () => {
    const result = validate('registry-snapshot', {
      schema_version: 1,
      repository: 'repo',
      commit_sha: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2',
      recipes: [],
    });
    assert.strictEqual(result.valid, false);
  });
});
