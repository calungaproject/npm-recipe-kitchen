import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPostValidation } from '../scripts/lib/post-validate.mjs';
import { computeFacts, toAgentInput } from '../scripts/lib/compute-facts.mjs';
import { buildParametersFromFacts, deriveAuthoritative } from '../scripts/lib/fact-bundle.mjs';
import { KNOWN_FACTS } from '../scripts/lib/facts.mjs';
import { makeOptions } from './helpers/collector-fakes.mjs';

// ---------------------------------------------------------------------------
// Harness: everything drives the REAL runPostValidation entrypoint (the module
// post-recipe-validate.sh invokes), reading the exact recipe-input.json the
// pre-path would have written and rendering into a throwaway repo root.
// ---------------------------------------------------------------------------

let work;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'nrk-post-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function writeInputFromOutcome(identity, outcome) {
  const input = toAgentInput(identity, outcome);
  const inputPath = join(work, 'recipe-input.json');
  writeFileSync(inputPath, JSON.stringify(input, null, 2) + '\n', 'utf-8');
  return inputPath;
}

function writeInput(obj) {
  const inputPath = join(work, 'recipe-input.json');
  writeFileSync(inputPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  return inputPath;
}

function writeResult(obj) {
  const resultPath = join(work, 'recipe-result.json');
  writeFileSync(resultPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  return resultPath;
}

/**
 * Build a well-formed model `drafted` result that MATCHES a bundle. Tests then
 * tamper with a single field to prove the post-path re-binds to trusted facts.
 * The model is authoritative only for `description`; every other parameter here
 * is what an honest model would have echoed from the trusted bundle.
 */
function draftResultFromBundle(bundle, over = {}) {
  const a = deriveAuthoritative(bundle);
  const parameters = buildParametersFromFacts(bundle, { description: 'a package' });
  return {
    schema_version: 1,
    package: a.identity,
    status: 'drafted',
    template_id: over.template_id ?? a.template_id,
    parameters: over.parameters ?? parameters,
    evidence: over.evidence ?? [{ kind: 'source-inspection', detail: 'inspected' }],
    confidence: over.confidence ?? 0.9,
    could_not_verify: over.could_not_verify ?? a.could_not_verify,
  };
}

async function collectorBundle(identity = 'foo@1.2.3', adapters = {}) {
  const out = await computeFacts(identity, makeOptions({ adapters }));
  assert.equal(out.status, 'ok', `expected ok bundle, got ${JSON.stringify(out)}`);
  return out.bundle;
}

function run(inputPath, resultPath) {
  return runPostValidation({
    resultPath,
    inputPath,
    repoRoot: work,
    auditDir: join(work, 'audit'),
  });
}

// ---------------------------------------------------------------------------

describe('runPostValidation — drafted (happy paths render from trusted facts)', () => {
  it('renders a manual-override (KNOWN_FACTS) package end-to-end', async () => {
    const out = await computeFacts('semver@7.7.2', { overrides: KNOWN_FACTS, adapters: {} });
    const inputPath = writeInputFromOutcome('semver@7.7.2', out);
    const resultPath = writeResult(draftResultFromBundle(out.bundle));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'drafted');
    assert.deepEqual(res.rendered.files.sort(), ['build.entrypoint.sh', 'evidence.md', 'manifest.json', 'verify.smoke.sh']);
    // Rendered manifest carries the trusted source SHA, not a model-supplied one.
    const manifest = JSON.parse(readFileSync(join(res.rendered.output_dir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.source.ref, '281055e7716ef0415a8826972471331989ede58c');
    assert.ok(existsSync(res.audit_path));
  });

  it('renders a collector-produced bundle end-to-end', async () => {
    const bundle = await collectorBundle();
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromBundle(bundle));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'drafted');
    assert.equal(res.rendered.template_id, 'tier-a-npm-pack-no-build-v1');
  });

  it('ignores a model-supplied source_ref and renders the trusted one', async () => {
    // Prove the renderer uses authoritative params, not model echoes: the model
    // still emits a MATCHING ref (so validation passes) but we assert the
    // rendered artifact is bound to the bundle regardless.
    const bundle = await collectorBundle();
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromBundle(bundle));
    const res = run(inputPath, resultPath);
    const manifest = JSON.parse(readFileSync(join(res.rendered.output_dir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.source.ref, bundle.source.commit_sha);
  });
});

describe('runPostValidation — a tampered authoritative field is always rejected', () => {
  const mutations = [
    ['package_name', p => { p.package_name.value = 'bar'; }, 'package_name-fact-match'],
    ['package_version', p => { p.package_version.value = '9.9.9'; }, 'package_version-fact-match'],
    ['source_url', p => { p.source_url.value = 'https://github.com/evil/repo.git'; }, 'source_url-fact-match'],
    ['source_ref', p => { p.source_ref.value = 'a'.repeat(40); }, 'source-sha-match'],
    ['source_tag', p => { p.source_tag.value = 'v9.9.9'; }, 'source_tag-fact-match'],
    ['main_entry', p => { p.main_entry.value = 'other.js'; }, 'main_entry-fact-match'],
    ['upstream_npm_version', p => { p.upstream_npm_version.value = '9.9.9'; }, 'upstream_npm_version-fact-match'],
    ['has_cli', p => { p.has_cli.value = true; }, 'has_cli-fact-match'],
  ];

  for (const [label, mutate, expectedCheck] of mutations) {
    it(`rejects a changed ${label}`, async () => {
      const bundle = await collectorBundle();
      const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
      const result = draftResultFromBundle(bundle);
      mutate(result.parameters);
      const resultPath = writeResult(result);

      const res = run(inputPath, resultPath);
      assert.equal(res.ok, false, JSON.stringify(res));
      assert.equal(res.reason_code, 'RESULT_REJECTED');
      assert.ok(res.errors.some(e => e.check === expectedCheck), `expected ${expectedCheck}, got ${JSON.stringify(res.errors)}`);
    });
  }

  it('rejects an added cli_bin_path when the trusted facts report no CLI', async () => {
    const bundle = await collectorBundle();
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const result = draftResultFromBundle(bundle);
    result.parameters.cli_bin_path = { type: 'string', value: 'bin/x.js' };
    const resultPath = writeResult(result);

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.check === 'cli_bin_path-should-be-absent'));
  });

  it('rejects a changed cli_bin_path for a CLI package', async () => {
    const bundle = await collectorBundle('foo@1.2.3', {
      packedPackageJson: { name: 'foo', version: '1.2.3', main: 'index.js', bin: { mytool: 'bin/run.js' } },
      packedFiles: ['package.json', 'index.js', 'bin/run.js'],
    });
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const result = draftResultFromBundle(bundle);
    result.parameters.cli_bin_path.value = 'bin/evil.js';
    const resultPath = writeResult(result);

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.check === 'cli_bin_path-fact-match'));
  });

  it('rejects dropping a trusted could_not_verify observation', async () => {
    // Default policy rejects tag_only, so build a bundle that carries a trusted
    // could_not_verify caveat under an explicit allowTagOnly policy.
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { provenanceStatus: 'absent' }, policy: { allowTagOnly: true } }));
    assert.equal(out.status, 'ok');
    assert.ok(out.bundle.could_not_verify.length > 0);
    const inputPath = writeInputFromOutcome('foo@1.2.3', out);
    const result = draftResultFromBundle(out.bundle, { could_not_verify: [] });
    const resultPath = writeResult(result);

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.check === 'could-not-verify-omitted'));
  });
});

describe('runPostValidation — template binding', () => {
  it('rejects a template_id different from the bundle eligibility template', async () => {
    const bundle = await collectorBundle();
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const result = draftResultFromBundle(bundle, { template_id: 'source-build' });
    const resultPath = writeResult(result);

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'RESULT_REJECTED');
    assert.ok(res.errors.some(e => e.check === 'template-eligibility-mismatch'));
  });
});

describe('runPostValidation — drafted is impossible without an exact valid bundle', () => {
  it('refuses to draft when facts are unavailable', async () => {
    const inputPath = writeInput({ identity: 'foo@1.2.3', facts_available: false, reason_code: 'PACKAGE_NOT_FOUND', reason: 'x' });
    const resultPath = writeResult({ schema_version: 1, package: 'foo@1.2.3', status: 'drafted', template_id: 'tier-a-npm-pack-no-build-v1', parameters: {}, evidence: [{ kind: 'x', detail: 'y' }], confidence: 0.9, could_not_verify: [] });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'DRAFT_WITHOUT_FACTS');
  });

  it('refuses to draft on an input_error (never asks the model to fabricate identity)', async () => {
    const inputPath = writeInput({ identity: 'bad', facts_available: false, input_error: true, reason_code: 'INVALID_IDENTITY', reason: 'x' });
    const resultPath = writeResult({ schema_version: 1, package: 'foo@1.2.3', status: 'drafted', template_id: 'tier-a-npm-pack-no-build-v1', parameters: {}, evidence: [{ kind: 'x', detail: 'y' }], confidence: 0.9, could_not_verify: [] });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'DRAFT_ON_INPUT_ERROR');
  });

  it('refuses when the fact bundle file is missing entirely', () => {
    const resultPath = writeResult({ schema_version: 1, package: 'foo@1.2.3', status: 'needs_human', reason: 'x', escalation_target: 'team' });
    const res = run(join(work, 'does-not-exist.json'), resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'MISSING_FACT_BUNDLE');
  });

  it('refuses when the bundle fails validation', async () => {
    const bundle = await collectorBundle();
    bundle.source.commit_sha = 'short'; // corrupt an authoritative field
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromBundle(bundle));
    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'INVALID_FACT_BUNDLE');
  });
});

describe('runPostValidation — needs_human and input_error (no render, bound identity)', () => {
  it('accepts a needs_human result for an unknown package and renders nothing', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { getPackument: async () => null } }));
    assert.equal(out.status, 'needs_human');
    const inputPath = writeInputFromOutcome('foo@1.2.3', out);
    const resultPath = writeResult({ schema_version: 1, package: 'foo@1.2.3', status: 'needs_human', reason: 'not found', escalation_target: 'team' });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'needs_human');
    assert.equal(res.rendered, undefined);
    assert.ok(!existsSync(join(work, 'demo', 'output', 'fullsend')), 'needs_human must not render recipe files');
  });

  it('rejects a needs_human result that re-targets a different identity', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { getPackument: async () => null } }));
    const inputPath = writeInputFromOutcome('foo@1.2.3', out);
    const resultPath = writeResult({ schema_version: 1, package: 'other@2.0.0', status: 'needs_human', reason: 'x', escalation_target: 'team' });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'RESULT_REJECTED');
    assert.ok(res.errors.some(e => e.check === 'identity-match'));
  });

  it('accepts a needs_human result for an input_error identity', () => {
    const inputPath = writeInput({ identity: 'bad', facts_available: false, input_error: true, reason_code: 'INVALID_IDENTITY', reason: 'bad identity' });
    const resultPath = writeResult({ schema_version: 1, package: 'placeholder@0.0.0', status: 'needs_human', reason: 'bad identity', escalation_target: 'triage' });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'input_error');
    assert.equal(res.reason_code, 'INVALID_IDENTITY');
  });
});

describe('runPostValidation — audit artifact', () => {
  it('persists the exact fact bundle as a kitchen-side audit artifact', async () => {
    const bundle = await collectorBundle();
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromBundle(bundle));

    const res = run(inputPath, resultPath);
    assert.ok(res.audit_path && existsSync(res.audit_path));
    const artifact = JSON.parse(readFileSync(res.audit_path, 'utf-8'));
    assert.equal(artifact.outcome, 'drafted');
    assert.equal(artifact.identity, 'foo@1.2.3');
    // The audit artifact retains the WHOLE trusted bundle, byte-for-byte.
    assert.deepEqual(artifact.fact_bundle, bundle);
    assert.equal(artifact.fact_bundle.source.commit_sha, bundle.source.commit_sha);
  });

  it('rejects an unknown result.status', async () => {
    const bundle = await collectorBundle();
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult({ schema_version: 1, package: 'foo@1.2.3', status: 'needs_human', reason: 'x', escalation_target: 't' });
    // Corrupt status AFTER schema-shaping by writing a raw object with a bad status.
    writeFileSync(resultPath, JSON.stringify({ schema_version: 1, package: 'foo@1.2.3', status: 'weird' }) + '\n');
    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    // schema rejects 'weird' first when drafted-branch not taken; the module maps
    // an unhandled status to UNKNOWN_STATUS.
    assert.ok(['UNKNOWN_STATUS', 'RESULT_REJECTED'].includes(res.reason_code));
  });
});
