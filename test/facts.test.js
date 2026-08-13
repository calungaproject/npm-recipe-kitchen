import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFacts, validateFacts } from '../scripts/lib/facts.mjs';

describe('getFacts', () => {
  it('returns facts for semver@7.7.2', () => {
    const facts = getFacts('semver@7.7.2');
    assert.strictEqual(facts.identity, 'semver@7.7.2');
    assert.strictEqual(facts.package_name, 'semver');
    assert.strictEqual(facts.package_version, '7.7.2');
  });

  it('returns immutable commit SHA, not tag', () => {
    const facts = getFacts('semver@7.7.2');
    assert.strictEqual(facts.source.commit_sha, '281055e7716ef0415a8826972471331989ede58c');
    assert.strictEqual(facts.source.commit_sha.length, 40);
    assert.match(facts.source.commit_sha, /^[0-9a-f]{40}$/);
  });

  it('retains tag as human-readable evidence', () => {
    const facts = getFacts('semver@7.7.2');
    assert.strictEqual(facts.source.tag, 'v7.7.2');
    assert.strictEqual(facts.source.tag_matches_version, true);
  });

  it('reports upstream build and pack evidence', () => {
    const facts = getFacts('semver@7.7.2');
    assert.strictEqual(facts.upstream.has_build_step, false);
    assert.strictEqual(facts.upstream.pack_command, 'npm pack --ignore-scripts');
    assert.strictEqual(facts.upstream.has_cli, true);
    assert.strictEqual(facts.upstream.cli_bin_path, 'bin/semver.js');
  });

  it('reports provenance state and could_not_verify', () => {
    const facts = getFacts('semver@7.7.2');
    assert.strictEqual(facts.provenance.slsa_attestation_present, true);
    assert.strictEqual(facts.provenance.attestation_verified, false);
    assert.ok(facts.could_not_verify.length > 0);
  });

  it('returns a deep clone (mutation-safe)', () => {
    const a = getFacts('semver@7.7.2');
    const b = getFacts('semver@7.7.2');
    a.source.commit_sha = 'tampered';
    assert.notStrictEqual(b.source.commit_sha, 'tampered');
  });

  it('rejects an invalid identity format', () => {
    assert.throws(() => getFacts('not valid'), /Invalid package identity/);
  });

  it('rejects an unknown package identity', () => {
    assert.throws(() => getFacts('unknown@1.0.0'), /No pre-computed facts/);
  });

  it('rejects empty identity', () => {
    assert.throws(() => getFacts(''), /Invalid package identity/);
  });
});

describe('validateFacts', () => {
  it('accepts valid semver@7.7.2 facts', () => {
    const facts = getFacts('semver@7.7.2');
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('rejects null', () => {
    const result = validateFacts(null);
    assert.strictEqual(result.valid, false);
  });

  it('rejects missing commit SHA', () => {
    const facts = getFacts('semver@7.7.2');
    facts.source.commit_sha = 'short';
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path === '/source/commit_sha'));
  });

  it('rejects invalid native_tier', () => {
    const facts = getFacts('semver@7.7.2');
    facts.native_tier = 'Z';
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
  });

  it('rejects missing could_not_verify', () => {
    const facts = getFacts('semver@7.7.2');
    facts.could_not_verify = 'not an array';
    const result = validateFacts(facts);
    assert.strictEqual(result.valid, false);
  });
});
