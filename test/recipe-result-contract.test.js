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

  it('validates only the recipe-result contract', () => {
    assert.deepStrictEqual(CONTRACT_NAMES, ['recipe-result']);
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

  it('rejects an invalid native_tier', () => {
    const result = validate('recipe-result', loadFixture('recipe-result', 'invalid-unknown-template'));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.includes('native_tier')));
  });

  it('rejects drafted with needs_human fields present', () => {
    const drafted = loadFixture('recipe-result', 'valid-drafted');
    drafted.reason = 'should not be here';
    const result = validate('recipe-result', drafted);
    assert.strictEqual(result.valid, false);
  });

  it('rejects needs_human with drafted fields present', () => {
    const human = loadFixture('recipe-result', 'valid-needs-human');
    human.native_tier = 'A';
    const result = validate('recipe-result', human);
    assert.strictEqual(result.valid, false);
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
      schema_version: 2,
      package: 'pkg@1.0.0',
      status: 'needs_human',
      reason: 'x'.repeat(2001),
      escalation_target: 'team',
    });
    assert.strictEqual(result.valid, false);
  });
});

describe('recipe-result schema copies', () => {
  it('keeps the fullsend harness schema in sync with schemas/recipe-result.schema.json', () => {
    const root = readFileSync(new URL('../schemas/recipe-result.schema.json', import.meta.url), 'utf-8');
    const harness = readFileSync(
      new URL('../.fullsend/npm-recipe-draft/schemas/recipe-result.schema.json', import.meta.url),
      'utf-8',
    );
    assert.strictEqual(harness, root);
  });
});
