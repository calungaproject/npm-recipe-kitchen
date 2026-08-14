import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';

import { validate } from './validate.mjs';

// Reads recipe facts from an exact, read-only checkout of npm-registry.
// This module never writes to, fetches into, or otherwise mutates the registry checkout.

export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function git(registryDir, args) {
  // Read-only git plumbing against the supplied checkout only. No network.
  return execFileSync('git', ['-C', registryDir, ...args], { encoding: 'utf-8' }).trim();
}

export function resolveRegistryHead(registryDir) {
  try {
    return git(registryDir, ['rev-parse', 'HEAD']);
  } catch {
    throw new SnapshotError(`not a git checkout: ${registryDir}`);
  }
}

export function assertCleanCheckout(registryDir) {
  const status = git(registryDir, ['status', '--porcelain']);
  if (status !== '') {
    throw new SnapshotError(
      `registry checkout is dirty; refusing so uncommitted state cannot masquerade as the recorded SHA:\n${status}`,
    );
  }
}

export function deriveRepository(registryDir) {
  let url;
  try {
    url = git(registryDir, ['remote', 'get-url', 'origin']);
  } catch {
    return null;
  }
  // https://github.com/OWNER/REPO(.git) or git@github.com:OWNER/REPO(.git)
  const m = url.match(/[/:]([^/:]+\/[^/:]+?)(?:\.git)?$/);
  return m ? m[1] : url;
}

// Lists npm package directories under packages/, handling one level of @scope.
function listPackageDirs(packagesDir) {
  const out = [];
  const entries = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name.startsWith('@')) {
      const scopeDir = join(packagesDir, entry.name);
      const scoped = readdirSync(scopeDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const sub of scoped) {
        out.push({ name: `${entry.name}/${sub.name}`, dir: join(scopeDir, sub.name) });
      }
    } else {
      out.push({ name: entry.name, dir: join(packagesDir, entry.name) });
    }
  }
  return out;
}

function loadManifestValidator(registryDir) {
  // Validate manifests using the registry's OWN checked-out schema (draft 2020-12).
  const schemaPath = join(registryDir, 'docs', 'manifest.schema.json');
  if (!existsSync(schemaPath)) {
    throw new SnapshotError(`registry manifest schema not found at ${schemaPath}`);
  }
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
  return ajv.compile(schema);
}

/**
 * Build a validated registry-snapshot document from a read-only checkout.
 *
 * Options:
 *   - registryDir  (required): path to the local npm-registry checkout
 *   - registryRef  (required): the full 40-char commit SHA the caller believes is checked out
 *   - repository   (optional): "owner/repo"; derived from origin when omitted
 */
export function buildRegistrySnapshot({ registryDir, registryRef, repository }) {
  if (!registryDir) throw new SnapshotError('registryDir is required');

  assertCleanCheckout(registryDir);

  const head = resolveRegistryHead(registryDir);
  if (registryRef && head !== registryRef) {
    throw new SnapshotError(
      `registry HEAD ${head} does not equal requested --registry-ref ${registryRef}`,
    );
  }

  const packagesDir = join(registryDir, 'packages');
  if (!existsSync(packagesDir)) {
    throw new SnapshotError(`no packages/ directory in registry checkout: ${registryDir}`);
  }

  const validateManifest = loadManifestValidator(registryDir);

  const recipes = [];
  for (const pkg of listPackageDirs(packagesDir)) {
    const versions = readdirSync(pkg.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const version of versions) {
      const manifestPath = join(pkg.dir, version, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (!validateManifest(manifest)) {
        throw new SnapshotError(
          `manifest ${manifestPath} fails the registry schema: ` +
            JSON.stringify(validateManifest.errors),
        );
      }
      recipes.push({
        identity: `${pkg.name}@${version}`,
        path: `packages/${pkg.name}/${version}`,
        state: 'recipe_present',
      });
    }
  }

  recipes.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

  const snapshot = {
    schema_version: 1,
    repository: repository || deriveRepository(registryDir) || 'unknown',
    commit_sha: head,
    recipes,
  };

  const result = validate('registry-snapshot', snapshot);
  if (!result.valid) {
    throw new SnapshotError(
      `built snapshot fails registry-snapshot contract: ` + JSON.stringify(result.errors),
    );
  }

  return snapshot;
}
