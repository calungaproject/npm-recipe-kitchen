import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Ajv2020 from 'ajv/dist/2020.js';
import { render, RenderError, ALLOWED_BASE } from '../scripts/lib/renderer.mjs';

function loadFixture(name) {
  const path = new URL(`fixtures/contracts/recipe-result/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadGoldenManifest() {
  const path = new URL('fixtures/golden/semver/7.7.2/manifest.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function withTempRepo(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'renderer-test-'));
  const outputBase = join(tmp, ALLOWED_BASE);
  mkdirSync(outputBase, { recursive: true });
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('renderer', () => {
  describe('valid drafted result', () => {
    it('generates all four output files', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        assert.deepStrictEqual(result.files.sort(), [
          'build.entrypoint.sh',
          'evidence.md',
          'manifest.json',
          'verify.smoke.sh',
        ]);
        assert.strictEqual(result.template_id, 'tier-a-npm-pack-no-build-v1');
        assert.ok(result.output_dir.endsWith('semver/7.7.2'));
      });
    });

    it('generated manifest has required structural fields matching golden', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        const generated = JSON.parse(readFileSync(join(result.output_dir, 'manifest.json'), 'utf-8'));
        const golden = loadGoldenManifest();

        assert.strictEqual(generated.name, golden.name);
        assert.strictEqual(generated.version, golden.version);
        assert.strictEqual(generated.native_tier, golden.native_tier);
        assert.strictEqual(generated.source.ref, golden.source.ref);
        assert.strictEqual(generated.source.ref_type, golden.source.ref_type);
        assert.strictEqual(generated.source.url, golden.source.url);
        assert.strictEqual(generated.entrypoint, golden.entrypoint);
        assert.strictEqual(generated.smoke, golden.smoke);
        assert.strictEqual(generated.outputs.length, golden.outputs.length);
        assert.strictEqual(generated.outputs[0].type, golden.outputs[0].type);
        assert.strictEqual(generated.outputs[0].pulp_name, golden.outputs[0].pulp_name);
      });
    });

    it('build entrypoint contains SHA verification', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        const script = readFileSync(join(result.output_dir, 'build.entrypoint.sh'), 'utf-8');
        assert.ok(script.includes('git clone --no-checkout'));
        assert.ok(script.includes('git checkout'));
        assert.ok(script.includes('git rev-parse HEAD'));
        assert.ok(script.includes('npm pack'));
        assert.ok(script.includes('set -euo pipefail'));
        assert.ok(script.includes('MANIFEST_PATH'));
      });
    });

    it('verify smoke script validates tarball', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        const script = readFileSync(join(result.output_dir, 'verify.smoke.sh'), 'utf-8');
        assert.ok(script.includes('package/package.json'));
        assert.ok(script.includes('npm install'));
        assert.ok(script.includes('set -euo pipefail'));
      });
    });

    it('evidence.md contains package identity and source info', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        const evidence = readFileSync(join(result.output_dir, 'evidence.md'), 'utf-8');
        assert.ok(evidence.includes('semver@7.7.2'));
        assert.ok(evidence.includes('281055e7716ef0415a8826972471331989ede58c'));
        assert.ok(evidence.includes('Could not verify'));
      });
    });

    it('shell scripts are executable', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        accessSync(join(result.output_dir, 'build.entrypoint.sh'), fsConstants.X_OK);
        accessSync(join(result.output_dir, 'verify.smoke.sh'), fsConstants.X_OK);
      });
    });
  });

  describe('template_id rejection', () => {
    it('rejects unsupported template_id', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.template_id = 'source-build';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });

    it('rejects arbitrary template_id', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.template_id = 'custom-malicious-template';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });
  });

  describe('needs_human rejection', () => {
    it('rejects needs_human results', () => {
      withTempRepo((repoRoot) => {
        assert.throws(
          () => render(loadFixture('valid-needs-human'), repoRoot),
          RenderError,
        );
      });
    });
  });

  describe('path traversal', () => {
    it('rejects .. in package_name', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.package_name.value = '../../../etc/passwd';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });

    it('rejects .. in package_version', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.package_version.value = '1.0.0/../../etc';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });

    it('rejects absolute path in package_name', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.package_name.value = '/etc/passwd';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });
  });

  describe('symlink prevention', () => {
    it('rejects symlink in output path', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'renderer-symlink-'));
      try {
        const realTarget = join(tmp, 'real-output');
        mkdirSync(realTarget, { recursive: true });
        const fakeBase = join(tmp, ALLOWED_BASE);
        mkdirSync(join(fakeBase), { recursive: true });
        symlinkSync(realTarget, join(fakeBase, 'semver'));

        const fixture = loadFixture('valid-drafted-tier-a');
        assert.throws(() => render(fixture, tmp), RenderError);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('control character rejection', () => {
    it('rejects NUL in parameter value', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.description.value = 'hello\x00world';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });

    it('rejects control characters in parameter value', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.description.value = 'hello\x07world';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });
  });

  describe('unknown parameter rejection', () => {
    it('rejects parameters not in template spec', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.evil_command = { type: 'string', value: 'rm -rf /' };
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });
  });

  describe('oversized value rejection', () => {
    it('rejects description exceeding max length', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.description.value = 'x'.repeat(501);
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });

    it('rejects source_ref with wrong length', () => {
      withTempRepo((repoRoot) => {
        const fixture = loadFixture('valid-drafted-tier-a');
        fixture.parameters.source_ref.value = 'abc123';
        assert.throws(() => render(fixture, repoRoot), RenderError);
      });
    });
  });

  describe('structural comparison with golden recipe', () => {
    it('generated manifest validates against the same registry schema as golden', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        const generated = JSON.parse(readFileSync(join(result.output_dir, 'manifest.json'), 'utf-8'));
        const registrySchema = JSON.parse(readFileSync(
          new URL('fixtures/registry-contract/017ebd5a3c5fef6d595f7c852fd584a7d5fae255/manifest.schema.json', import.meta.url),
          'utf-8',
        ));
        const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
        const validate = ajv.compile(registrySchema);
        const valid = validate(generated);
        assert.strictEqual(valid, true, JSON.stringify(validate.errors, null, 2));
      });
    });

    it('build entrypoint does not contain unsupported commands', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        const script = readFileSync(join(result.output_dir, 'build.entrypoint.sh'), 'utf-8');
        const forbidden = ['npm publish', 'npm login', 'npm adduser', 'curl ', 'wget ', 'eval '];
        for (const cmd of forbidden) {
          assert.ok(!script.includes(cmd), `build script must not contain "${cmd}"`);
        }
      });
    });

    it('smoke script does not contain unsupported commands', () => {
      withTempRepo((repoRoot) => {
        const result = render(loadFixture('valid-drafted-tier-a'), repoRoot);
        const script = readFileSync(join(result.output_dir, 'verify.smoke.sh'), 'utf-8');
        const forbidden = ['npm publish', 'npm login', 'curl ', 'wget ', 'eval '];
        for (const cmd of forbidden) {
          assert.ok(!script.includes(cmd), `smoke script must not contain "${cmd}"`);
        }
      });
    });
  });
});
