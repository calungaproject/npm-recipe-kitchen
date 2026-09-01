import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const RECIPE_PATHS = new URL('../.fullsend/npm-recipe-draft/recipe-paths.sh', import.meta.url).pathname;

function runHelper(env, fn) {
  const out = execFileSync('bash', ['-c', `source "${RECIPE_PATHS}" && ${fn}`], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return out.trim();
}

function runHelperFails(env, fn) {
  assert.throws(
    () => runHelper(env, fn),
    (err) => err.status !== 0,
  );
}

let work;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'nrk-paths-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

describe('runner_repo_root', () => {
  it('prefers REPO_DIR when only it is set', () => {
    const repo = join(work, 'repo-a');
    mkdirSync(repo);
    assert.equal(runHelper({ REPO_DIR: repo }, 'runner_repo_root'), realpathSync(repo));
  });

  it('uses TARGET_REPO_DIR when only it is set', () => {
    const repo = join(work, 'repo-b');
    mkdirSync(repo);
    assert.equal(runHelper({ TARGET_REPO_DIR: repo }, 'runner_repo_root'), realpathSync(repo));
  });

  it('accepts when REPO_DIR and TARGET_REPO_DIR are the same tree', () => {
    const repo = join(work, 'repo-c');
    mkdirSync(repo);
    assert.equal(
      runHelper({ REPO_DIR: repo, TARGET_REPO_DIR: repo }, 'runner_repo_root'),
      realpathSync(repo),
    );
  });

  it('fails when REPO_DIR and TARGET_REPO_DIR differ', () => {
    const repoA = join(work, 'repo-d');
    const repoB = join(work, 'repo-e');
    mkdirSync(repoA);
    mkdirSync(repoB);
    runHelperFails({ REPO_DIR: repoA, TARGET_REPO_DIR: repoB }, 'runner_repo_root');
  });

  it('ignores stale TARGET_REPO_DIR when REPO_DIR points at the extracted tree', () => {
    const repo = join(work, 'repo-g');
    mkdirSync(repo);
    assert.equal(
      runHelper({ REPO_DIR: repo, TARGET_REPO_DIR: 'target-repo' }, 'runner_repo_root'),
      realpathSync(repo),
    );
  });

  it('falls back to /tmp/<run-basename> when REPO_DIR is unset', () => {
    const runName = 'fs-npm-test-run';
    const runDir = join(work, runName);
    const downloadDir = join('/tmp', runName);
    mkdirSync(runDir);
    mkdirSync(downloadDir);
    const out = execFileSync(
      'bash',
      ['-c', `source "${RECIPE_PATHS}" && runner_repo_root`],
      { cwd: runDir, env: { ...process.env, TARGET_REPO_DIR: 'target-repo' }, encoding: 'utf-8' },
    );
    assert.equal(out.trim(), realpathSync(downloadDir));
    rmSync(downloadDir, { recursive: true, force: true });
  });
});

describe('runner_recipe_packages_dir', () => {
  it('resolves packages under the canonical runner repo root', () => {
    const repo = join(work, 'repo-f');
    mkdirSync(join(repo, 'packages', 'semver', '7.7.2'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'semver', '7.7.2', 'manifest.json'), '{}');
    assert.equal(
      runHelper({ TARGET_REPO_DIR: repo }, 'runner_recipe_packages_dir'),
      join(realpathSync(repo), 'packages'),
    );
  });
});
