import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRecipeResult, validateNeedsHumanResult } from '../scripts/lib/recipe-validator.mjs';
import { semverFacts } from './helpers/fixture-facts.mjs';

function loadFixture(name) {
  const path = new URL(`fixtures/contracts/recipe-result/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const SEMVER_FACTS = semverFacts();

describe('validateRecipeResult', () => {
  it('accepts a valid drafted result with matching facts', () => {
    const result = validateRecipeResult(loadFixture('valid-drafted-tier-a'), SEMVER_FACTS);
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('accepts a valid drafted result without facts check', () => {
    const result = validateRecipeResult(loadFixture('valid-drafted-tier-a'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects an object missing schema_version', () => {
    const result = validateRecipeResult({ package: 'semver@7.7.2', status: 'drafted' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.check === 'schema'));
  });

  it('rejects when package identity does not match facts', () => {
    const fixture = loadFixture('valid-drafted-tier-a');
    fixture.package = 'other@1.0.0';
    const result = validateRecipeResult(fixture, SEMVER_FACTS);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.check === 'identity-match'));
  });

  it('rejects dropping trusted could_not_verify items', () => {
    const fixture = loadFixture('valid-drafted-tier-a');
    fixture.could_not_verify = [];
    const result = validateRecipeResult(fixture, SEMVER_FACTS);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.check === 'could-not-verify-omitted'));
  });

  it('rejects low confidence', () => {
    const fixture = loadFixture('valid-drafted-tier-a');
    fixture.confidence = 0.2;
    const result = validateRecipeResult(fixture);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.check === 'low-confidence'));
  });
});

describe('validateNeedsHumanResult', () => {
  it('accepts a valid needs_human result', () => {
    const result = validateNeedsHumanResult(loadFixture('valid-needs-human'));
    assert.strictEqual(result.valid, true);
  });

  it('rejects drafted status', () => {
    const result = validateNeedsHumanResult(loadFixture('valid-drafted-tier-a'));
    assert.strictEqual(result.valid, false);
  });
});
