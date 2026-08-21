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
  describe('valid results', () => {
    it('accepts a valid tier-a drafted result with matching facts', () => {
      const result = validateRecipeResult(loadFixture('valid-drafted-tier-a'), SEMVER_FACTS);
      assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    });

    it('accepts a valid drafted result without facts check', () => {
      const result = validateRecipeResult(loadFixture('valid-drafted-tier-a'));
      assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    });
  });

  describe('schema rejection', () => {
    it('rejects an object missing schema_version', () => {
      const result = validateRecipeResult({ package: 'semver@7.7.2', status: 'drafted' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'schema'));
    });
  });

  describe('identity mismatch', () => {
    it('rejects when package identity does not match facts', () => {
      const fixture = loadFixture('valid-drafted-tier-a');
      fixture.package = 'other@1.0.0';
      const result = validateRecipeResult(fixture, SEMVER_FACTS);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'identity-match'));
    });
  });

  describe('template_id allowlist', () => {
    it('rejects a template_id not in the renderer allowlist', () => {
      const fixture = loadFixture('valid-drafted');
      const result = validateRecipeResult(fixture, SEMVER_FACTS);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'template-allowlist'));
    });
  });

  describe('wrong source SHA', () => {
    it('rejects when source_ref does not match expected SHA', () => {
      const fixture = loadFixture('valid-drafted-tier-a');
      fixture.parameters.source_ref.value = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const result = validateRecipeResult(fixture, SEMVER_FACTS);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'source-sha-match'));
    });
  });

  describe('source_ref format', () => {
    it('rejects non-hex source_ref', () => {
      const fixture = loadFixture('valid-drafted-tier-a');
      fixture.parameters.source_ref.value = 'not-a-valid-sha-at-all-nope-nope-nope!!';
      const result = validateRecipeResult(fixture);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'source-ref-format'));
    });
  });

  describe('path traversal in parameters', () => {
    it('rejects .. in package_name', () => {
      const fixture = loadFixture('valid-drafted-tier-a');
      fixture.parameters.package_name.value = '..';
      const result = validateRecipeResult(fixture);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'path-traversal'));
    });

    it('rejects .. in cli_bin_path', () => {
      const fixture = loadFixture('valid-drafted-tier-a');
      fixture.parameters.cli_bin_path.value = '../../etc/passwd';
      const result = validateRecipeResult(fixture);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'path-traversal'));
    });
  });

  describe('source URL scheme', () => {
    it('rejects non-https source_url', () => {
      const fixture = loadFixture('valid-drafted-tier-a');
      fixture.parameters.source_url.value = 'http://evil.com/repo.git';
      const result = validateRecipeResult(fixture);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'source-url-scheme'));
    });
  });

  describe('low confidence', () => {
    it('rejects confidence below 0.5', () => {
      const fixture = loadFixture('valid-drafted-tier-a');
      fixture.confidence = 0.3;
      const result = validateRecipeResult(fixture);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.check === 'low-confidence'));
    });
  });
});

describe('validateNeedsHumanResult', () => {
  it('accepts a valid needs_human result', () => {
    const result = validateNeedsHumanResult(loadFixture('valid-needs-human'));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects a drafted result', () => {
    const result = validateNeedsHumanResult(loadFixture('valid-drafted-tier-a'));
    assert.strictEqual(result.valid, false);
  });
});
