import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

const REGISTRY_SHA = '017ebd5a3c5fef6d595f7c852fd584a7d5fae255';
const SEMVER_COMMIT = '281055e7716ef0415a8826972471331989ede58c';

function loadJSON(relativePath) {
  const path = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const provenance = loadJSON(`fixtures/registry-contract/${REGISTRY_SHA}/provenance.json`);
const registrySchema = loadJSON(`fixtures/registry-contract/${REGISTRY_SHA}/manifest.schema.json`);
const goldenManifest = loadJSON('fixtures/golden/semver/7.7.2/manifest.json');

describe('registry contract snapshot', () => {
  it('provenance records the correct repository and SHA', () => {
    assert.strictEqual(provenance.repository, 'calungaproject/npm-registry');
    assert.strictEqual(provenance.commit_sha, REGISTRY_SHA);
    assert.strictEqual(provenance.commit_sha.length, 40);
  });

  it('schema SHA-256 matches the snapshot file', () => {
    const schemaPath = new URL(`fixtures/registry-contract/${REGISTRY_SHA}/manifest.schema.json`, import.meta.url);
    const content = readFileSync(schemaPath);
    const actual = createHash('sha256').update(content).digest('hex');
    assert.strictEqual(actual, provenance.schema_sha256);
  });
});

describe('golden manifest against registry schema', () => {
  const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
  const validate = ajv.compile(registrySchema);

  it('validates against the pinned registry manifest schema', () => {
    const valid = validate(goldenManifest);
    assert.strictEqual(valid, true, JSON.stringify(validate.errors, null, 2));
  });

  it('uses the immutable commit SHA as source.ref', () => {
    assert.strictEqual(goldenManifest.source.ref, SEMVER_COMMIT);
    assert.strictEqual(goldenManifest.source.ref_type, 'commit');
  });

  it('directory layout matches packages/<name>/<version>/ convention', () => {
    const expectedDir = `packages/${goldenManifest.name}/${goldenManifest.version}`;
    assert.strictEqual(expectedDir, 'packages/semver/7.7.2');
  });

  it('has required fields matching lint-manifest expectations', () => {
    assert.ok(goldenManifest.name);
    assert.ok(goldenManifest.version);
    assert.ok(goldenManifest.native_tier);
    assert.ok(goldenManifest.entrypoint);
    assert.ok(goldenManifest.smoke);
    assert.ok(goldenManifest.source.url);
    assert.ok(goldenManifest.source.ref);
    assert.ok(Array.isArray(goldenManifest.outputs) && goldenManifest.outputs.length > 0);
  });

  it('native_tier is a valid value', () => {
    assert.ok(['A', 'B', 'C'].includes(goldenManifest.native_tier));
  });
});

describe('golden recipe file structure', () => {
  const goldenDir = new URL('fixtures/golden/semver/7.7.2/', import.meta.url);

  it('build entrypoint is executable', () => {
    assert.doesNotThrow(() =>
      accessSync(new URL('build.entrypoint.sh', goldenDir), constants.X_OK)
    );
  });

  it('smoke script is executable', () => {
    assert.doesNotThrow(() =>
      accessSync(new URL('verify.smoke.sh', goldenDir), constants.X_OK)
    );
  });

  it('entrypoint and smoke filenames match manifest', () => {
    assert.strictEqual(goldenManifest.entrypoint, 'build.entrypoint.sh');
    assert.strictEqual(goldenManifest.smoke, 'verify.smoke.sh');
  });

  it('evidence.md exists', () => {
    assert.doesNotThrow(() =>
      accessSync(new URL('evidence.md', goldenDir), constants.R_OK)
    );
  });
});
