import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isSensitiveChildEnvKey,
  resolvePackageDir,
} from '../scripts/lib/adapters/npm-adapters.mjs';

describe('npm-adapters env hygiene', () => {
  it('preserves npm_config_* keys while stripping runner credentials', () => {
    assert.equal(isSensitiveChildEnvKey('npm_config_ignore_scripts'), false);
    assert.equal(isSensitiveChildEnvKey('npm_config_audit'), false);
    assert.equal(isSensitiveChildEnvKey('GITHUB_TOKEN'), true);
    assert.equal(isSensitiveChildEnvKey('NPM_TOKEN'), true);
  });
});

describe('resolvePackageDir', () => {
  it('returns repo root when root package.json is publishable', () => {
    const root = mkdtempSync(join(tmpdir(), 'nrk-pkgdir-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0' }));
      assert.equal(resolvePackageDir(root, 'foo'), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a workspace member when the repo root is private', () => {
    const root = mkdtempSync(join(tmpdir(), 'nrk-pkgdir-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
      mkdirSync(join(root, 'packages', 'zod'), { recursive: true });
      writeFileSync(join(root, 'packages', 'zod', 'package.json'), JSON.stringify({
        name: 'zod',
        version: '4.5.4',
      }));
      assert.equal(resolvePackageDir(root, 'zod'), join(root, 'packages', 'zod'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
