import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFacts } from '../scripts/lib/facts.mjs';
import { semverFacts } from './helpers/fixture-facts.mjs';

describe('validateFacts', () => {
  it('accepts a valid fact bundle', () => {
    const result = validateFacts(semverFacts());
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects null', () => {
    const result = validateFacts(null);
    assert.strictEqual(result.valid, false);
  });

  it('rejects a missing/short commit SHA', () => {
    const facts = semverFacts();
    facts.source.commit_sha = 'short';
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path === '/source/commit_sha'));
  });

  it('rejects a missing git URL', () => {
    const facts = semverFacts();
    delete facts.source.git_url;
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path === '/source/git_url'));
  });

  it('rejects an invalid identity', () => {
    const facts = semverFacts();
    facts.identity = 'not valid';
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path === '/identity'));
  });

  it('rejects an invalid native_tier', () => {
    const facts = semverFacts();
    facts.native_tier = 'Z';
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
  });

  it('rejects a non-array could_not_verify', () => {
    const facts = semverFacts();
    facts.could_not_verify = 'not an array';
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
  });
});
