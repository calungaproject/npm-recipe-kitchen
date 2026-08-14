import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  buildRegistrySnapshot,
  resolveRegistryHead,
  SnapshotError,
} from '../scripts/lib/registry-snapshot.mjs';

// Minimal draft-2020-12 manifest schema, standing in for the registry's docs/manifest.schema.json.
const MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['name', 'version', 'native_tier'],
  properties: {
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    native_tier: { type: 'string', enum: ['A', 'B', 'C'] },
  },
};

function makeManifest(name, version) {
  return JSON.stringify({ name, version, native_tier: 'A' }, null, 2) + '\n';
}

function hashTree(dir) {
  // Hash every tracked-looking file (skip .git) so we can prove the checkout is untouched.
  const hashes = {};
  const walk = (d, rel) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === '.git') continue;
      const full = join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else hashes[r] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir, '');
  return hashes;
}

describe('buildRegistrySnapshot', () => {
  let dir;
  let head;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'registry-fixture-'));
    const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });

    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'manifest.schema.json'), JSON.stringify(MANIFEST_SCHEMA, null, 2) + '\n');

    // Two packages, one scoped, to exercise sorting and @scope/<pkg> handling.
    mkdirSync(join(dir, 'packages', 'express', '4.22.2'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'express', '4.22.2', 'manifest.json'), makeManifest('express', '4.22.2'));
    mkdirSync(join(dir, 'packages', '@scope', 'thing', '1.0.0'), { recursive: true });
    writeFileSync(join(dir, 'packages', '@scope', 'thing', '1.0.0', 'manifest.json'), makeManifest('@scope/thing', '1.0.0'));

    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fixture']);
    head = resolveRegistryHead(dir);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('records recipe_present entries with canonical identities and sorted order', () => {
    const snap = buildRegistrySnapshot({ registryDir: dir, registryRef: head, repository: 'owner/repo' });
    assert.equal(snap.schema_version, 1);
    assert.equal(snap.repository, 'owner/repo');
    assert.equal(snap.commit_sha, head);
    assert.deepEqual(
      snap.recipes.map((r) => r.identity),
      ['@scope/thing@1.0.0', 'express@4.22.2'],
    );
    for (const r of snap.recipes) assert.equal(r.state, 'recipe_present');
    assert.equal(snap.recipes[1].path, 'packages/express/4.22.2');
  });

  it('never asserts catalog availability', () => {
    const snap = buildRegistrySnapshot({ registryDir: dir, registryRef: head });
    const asText = JSON.stringify(snap);
    assert.ok(!asText.includes('available'), 'snapshot must not contain the word "available"');
  });

  it('fails clearly when HEAD does not equal --registry-ref', () => {
    const wrong = 'f'.repeat(40);
    assert.throws(
      () => buildRegistrySnapshot({ registryDir: dir, registryRef: wrong }),
      (e) => e instanceof SnapshotError && /does not equal requested/.test(e.message),
    );
  });

  it('refuses a dirty checkout', () => {
    const scratch = join(dir, 'packages', 'express', '4.22.2', 'DIRTY.txt');
    writeFileSync(scratch, 'uncommitted\n');
    try {
      assert.throws(
        () => buildRegistrySnapshot({ registryDir: dir, registryRef: head }),
        (e) => e instanceof SnapshotError && /dirty/.test(e.message),
      );
    } finally {
      rmSync(scratch, { force: true });
    }
  });

  it('leaves the registry checkout byte-for-byte unchanged', () => {
    const before = hashTree(dir);
    buildRegistrySnapshot({ registryDir: dir, registryRef: head });
    const after = hashTree(dir);
    assert.deepEqual(after, before);
  });
});
