import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  extractDnfInstallPackages,
  extractCopiedScriptCommands,
  parseNpmBuilderContainerfile,
} from '../scripts/lib/parse-npm-builder-containerfile.mjs';
import { loadNpmBuilderInventory } from '../scripts/lib/npm-builder-inventory.mjs';

const containerfile = join(
  dirname(fileURLToPath(import.meta.url)),
  '../registry-contract/npm-builder/Containerfile',
);

describe('parseNpmBuilderContainerfile', () => {
  const content = readFileSync(containerfile, 'utf-8');

  it('extracts dnf install packages from the vendored Containerfile', () => {
    const pkgs = extractDnfInstallPackages(content);
    assert.ok(pkgs.includes('nodejs'));
    assert.ok(pkgs.includes('npm'));
    assert.ok(pkgs.includes('golang'));
    assert.ok(!pkgs.includes('--setopt'));
  });

  it('extracts factory scripts copied to /usr/local/bin', () => {
    const scripts = extractCopiedScriptCommands(content);
    assert.ok(scripts.includes('build-npm-package'));
    assert.ok(scripts.includes('shasum'));
  });

  it('derives expected command names', () => {
    const { commands } = parseNpmBuilderContainerfile(content);
    for (const cmd of ['node', 'npm', 'git', 'go', 'jq', 'make', 'gcc', 'g++', 'cargo', 'rustc', 'syft']) {
      assert.ok(commands.has(cmd), `missing ${cmd}`);
    }
    assert.ok(!commands.has('pnpm'));
    assert.ok(!commands.has('deno'));
  });
});

describe('loadNpmBuilderInventory', () => {
  it('loads from pinned Containerfile snapshot', () => {
    const { commands, source } = loadNpmBuilderInventory();
    assert.ok(commands.has('npm'));
    assert.equal(source.repository, 'calungaproject/plumbing');
    assert.match(source.commit_sha ?? '', /^[0-9a-f]{40}$/);
  });
});
