import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { renderDraftBundle, BundleError } from '../scripts/lib/draft-bundle.mjs';

function loadJSON(rel) {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'));
}

const DRAFTED = loadJSON('fixtures/contracts/recipe-result/valid-drafted-tier-a.json');
const NEEDS_HUMAN = loadJSON('fixtures/contracts/recipe-result/valid-needs-human.json');
const UNKNOWN_TEMPLATE = loadJSON('fixtures/contracts/recipe-result/invalid-unknown-template.json');

const SNAPSHOT = {
  schema_version: 1,
  repository: 'calungaproject/npm-registry',
  commit_sha: '017ebd5a3c5fef6d595f7c852fd584a7d5fae255',
  recipes: [{ identity: 'express@4.22.2', path: 'packages/express/4.22.2', state: 'recipe_present' }],
};

const NOW = '2026-08-14T00:00:00Z';

describe('renderDraftBundle', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'kitchen-root-'));
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('drafted: writes rendered files, hashes, and an unapplied apply.patch', () => {
    const res = renderDraftBundle({ recipeResult: DRAFTED, registrySnapshot: SNAPSHOT, repoRoot, now: NOW });
    assert.equal(res.status, 'drafted');

    const dir = res.output_dir;
    for (const f of ['manifest.json', 'build.entrypoint.sh', 'verify.smoke.sh', 'evidence.md']) {
      assert.ok(existsSync(join(dir, 'packages/semver/7.7.2', f)), `${f} present`);
    }
    assert.ok(existsSync(join(dir, 'apply.patch')));

    const bundle = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf-8'));
    assert.equal(bundle.status, 'drafted');
    assert.equal(bundle.target_repository, 'calungaproject/npm-registry');
    assert.equal(bundle.target_commit, SNAPSHOT.commit_sha);
    assert.equal(bundle.generated_at, NOW);
    assert.equal(bundle.template_id, 'tier-a-npm-pack-no-build-v1');
    assert.equal(bundle.already_present_in_registry_snapshot, false);
    assert.match(bundle.notes.join(' '), /have not been built, promoted, applied, or merged/i);

    // Recorded hashes must match the files actually written.
    for (const entry of bundle.files) {
      const content = readFileSync(join(dir, entry.path));
      assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256, `${entry.path} hash`);
    }
  });

  it('drafted: the apply.patch applies cleanly and targets packages/<name>/<version>/', () => {
    const res = renderDraftBundle({ recipeResult: DRAFTED, registrySnapshot: SNAPSHOT, repoRoot, now: NOW });
    const patchPath = join(res.output_dir, 'apply.patch');
    const patch = readFileSync(patchPath, 'utf-8');
    assert.match(patch, /^diff --git a\/packages\/semver\/7\.7\.2\/manifest\.json/m);
    assert.match(patch, /^\+\+\+ b\/packages\/semver\/7\.7\.2\/build\.entrypoint\.sh$/m);

    const target = mkdtempSync(join(tmpdir(), 'apply-target-'));
    try {
      execFileSync('git', ['-C', target, 'init', '-q']);
      // --check must succeed (exit 0); throws on failure.
      execFileSync('git', ['-C', target, 'apply', '--check', patchPath]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('drafted: byte-for-byte stable across repeated runs with a fixed clock', () => {
    const run = () => {
      const root = mkdtempSync(join(tmpdir(), 'stable-'));
      renderDraftBundle({ recipeResult: DRAFTED, registrySnapshot: SNAPSHOT, repoRoot: root, now: NOW });
      const base = join(root, 'demo/output/draft-bundle/semver/7.7.2');
      const files = ['bundle.json', 'apply.patch', 'packages/semver/7.7.2/manifest.json', 'packages/semver/7.7.2/evidence.md'];
      const out = {};
      for (const f of files) out[f] = createHash('sha256').update(readFileSync(join(base, f))).digest('hex');
      rmSync(root, { recursive: true, force: true });
      return out;
    };
    assert.deepEqual(run(), run());
  });

  it('needs_human: produces an evidence bundle with no patch and no recipe files', () => {
    const res = renderDraftBundle({ recipeResult: NEEDS_HUMAN, registrySnapshot: SNAPSHOT, repoRoot, now: NOW });
    assert.equal(res.status, 'needs_human');
    assert.equal(res.patch, null);
    assert.deepEqual(res.files, []);

    const bundle = JSON.parse(readFileSync(join(res.output_dir, 'bundle.json'), 'utf-8'));
    assert.equal(bundle.status, 'needs_human');
    assert.equal(bundle.apply_patch, null);
    assert.match(bundle.reason, /native compilation/i);
    assert.equal(bundle.escalation_target, 'native-builds-team');
    assert.ok(!existsSync(join(res.output_dir, 'apply.patch')), 'no patch file');
    assert.ok(!existsSync(join(res.output_dir, 'packages')), 'no invented recipe files');
  });

  it('rejects an unsupported template_id (untrusted model output)', () => {
    assert.throws(
      () => renderDraftBundle({ recipeResult: UNKNOWN_TEMPLATE, registrySnapshot: SNAPSHOT, repoRoot, now: NOW }),
      (e) => e instanceof BundleError && /validation/.test(e.message),
    );
  });

  it('rejects a path-traversal attempt in the package identity', () => {
    const malicious = JSON.parse(JSON.stringify(DRAFTED));
    malicious.parameters.package_name.value = '../../etc';
    assert.throws(
      () => renderDraftBundle({ recipeResult: malicious, registrySnapshot: SNAPSHOT, repoRoot, now: NOW }),
      (e) => e instanceof BundleError,
    );
    // Nothing should have been written outside the bundle base for a rejected result.
    assert.ok(!existsSync(join(repoRoot, 'etc')));
  });

  it('requires an injected clock for stable output', () => {
    assert.throws(
      () => renderDraftBundle({ recipeResult: DRAFTED, registrySnapshot: SNAPSHOT, repoRoot }),
      (e) => e instanceof BundleError && /now/.test(e.message),
    );
  });

  it('flags when the same identity is already recipe_present in the registry', () => {
    const snap = { ...SNAPSHOT, recipes: [{ identity: 'semver@7.7.2', path: 'packages/semver/7.7.2', state: 'recipe_present' }] };
    const res = renderDraftBundle({ recipeResult: DRAFTED, registrySnapshot: snap, repoRoot, now: NOW });
    const bundle = JSON.parse(readFileSync(join(res.output_dir, 'bundle.json'), 'utf-8'));
    assert.equal(bundle.already_present_in_registry_snapshot, true);
  });
});
