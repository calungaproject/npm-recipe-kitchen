import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPostValidation } from '../scripts/lib/post-validate.mjs';
import { computeFacts, toAgentInput } from '../scripts/lib/compute-facts.mjs';
import { makeOptions } from './helpers/collector-fakes.mjs';
import { semverFacts } from './helpers/fixture-facts.mjs';
import { writeMinimalTierARecipe, draftResultFromFacts } from './helpers/recipe-bundle-fixture.mjs';

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

async function collectorBundle(identity = 'foo@1.2.3', adapters = {}) {
  const out = await computeFacts(identity, makeOptions({ adapters }));
  assert.equal(out.status, 'ok', `expected ok bundle, got ${JSON.stringify(out)}`);
  return out.bundle;
}

function run(inputPath, resultPath, renderRoot = work) {
  return runPostValidation({
    resultPath,
    inputPath,
    repoRoot: work,
    renderRoot,
    auditDir: join(work, 'audit'),
  });
}

describe('runPostValidation — drafted (agent-authored recipe bundle)', () => {
  it('accepts a valid recipe bundle end-to-end', async () => {
    const bundle = semverFacts();
    bundle.classification = { tier_a_eligible: true, native_tier: 'A' };
    const inputPath = writeInputFromOutcome('semver@7.7.2', { status: 'ok', bundle });
    writeMinimalTierARecipe(work, bundle);
    const resultPath = writeResult(draftResultFromFacts(bundle));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'drafted');
    assert.ok(res.rendered.files.includes('manifest.json'));
    const manifest = JSON.parse(readFileSync(join(res.rendered.output_dir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.name, 'semver');
    assert.ok(existsSync(res.audit_path));
  });

  it('still collects facts when binding.gyp is present (Tier C hint)', async () => {
    const bundle = await collectorBundle('foo@1.2.3', {
      sourceFiles: ['package.json', 'index.js', 'binding.gyp'],
    });
    assert.equal(bundle.classification.tier_a_eligible, false);
    assert.equal(bundle.classification.native_tier, 'C');
    writeMinimalTierARecipe(work, bundle);
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromFacts(bundle, { native_tier: 'A' }));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'drafted');
  });

  it('rejects when manifest name does not match trusted facts', async () => {
    const bundle = await collectorBundle();
    writeMinimalTierARecipe(work, bundle);
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const manifestPath = join(work, 'packages', 'foo', '1.2.3', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.name = 'bar';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const resultPath = writeResult(draftResultFromFacts(bundle));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'RECIPE_BUNDLE_REJECTED');
    assert.ok(res.errors.some(e => e.check === 'manifest-name-fact-match'));
  });

  it('rejects when recipe bundle directory is missing', async () => {
    const bundle = await collectorBundle();
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromFacts(bundle));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'RECIPE_BUNDLE_REJECTED');
  });

  it('rejects dropping a trusted could_not_verify observation', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { provenanceStatus: 'absent' } }));
    assert.equal(out.status, 'ok');
    assert.ok(out.bundle.could_not_verify.length > 0);
    writeMinimalTierARecipe(work, out.bundle);
    const inputPath = writeInputFromOutcome('foo@1.2.3', out);
    const resultPath = writeResult(draftResultFromFacts(out.bundle, { could_not_verify: [] }));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.check === 'could-not-verify-omitted'));
  });

  it('rejects drafted when facts.factory.blockers is non-empty', async () => {
    const bundle = await collectorBundle();
    bundle.factory = {
      blockers: ['pnpm-workspace'],
      blocker_details: ['root packageManager is pnpm'],
      install_command: 'npm install --include=dev --ignore-scripts',
      package_dir: 'packages/zod',
      node_env: 'production',
    };
    writeMinimalTierARecipe(work, bundle);
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromFacts(bundle));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'FACTORY_BLOCKER');
  });

  it('rejects build recipes that omit npm install --include=dev', async () => {
    const bundle = await collectorBundle();
    bundle.upstream = { ...(bundle.upstream ?? {}), has_build_step: true };
    bundle.factory = {
      blockers: [],
      install_command: 'npm install --include=dev --ignore-scripts',
      package_dir: '.',
      node_env: 'production',
    };
    writeMinimalTierARecipe(work, bundle);
    const entrypoint = join(work, 'packages', 'foo', '1.2.3', 'build.entrypoint.sh');
    writeFileSync(entrypoint, readFileSync(entrypoint, 'utf-8').replace(
      'npm pack --quiet',
      'npm install --ignore-scripts\nnpm run build\npacked="$(npm pack --quiet)"',
    ));
    const inputPath = writeInputFromOutcome('foo@1.2.3', { status: 'ok', bundle });
    const resultPath = writeResult(draftResultFromFacts(bundle));

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.check === 'factory-install-devdeps'));
  });
});

describe('runPostValidation — drafted is impossible without an exact valid bundle', () => {
  it('refuses to draft when facts are unavailable', async () => {
    const inputPath = writeInput({ identity: 'foo@1.2.3', facts_available: false, reason_code: 'PACKAGE_NOT_FOUND', reason: 'x' });
    const resultPath = writeResult({
      schema_version: 2,
      package: 'foo@1.2.3',
      status: 'drafted',
      native_tier: 'A',
      evidence: [{ kind: 'x', detail: 'y' }],
      confidence: 0.9,
      could_not_verify: [],
    });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'FACTS_UNAVAILABLE');
  });

  it('refuses to draft on an input_error', async () => {
    const inputPath = writeInput({ identity: 'bad', facts_available: false, input_error: true, reason_code: 'INVALID_IDENTITY', reason: 'x' });
    const resultPath = writeResult({
      schema_version: 2,
      package: 'foo@1.2.3',
      status: 'drafted',
      native_tier: 'A',
      evidence: [{ kind: 'x', detail: 'y' }],
      confidence: 0.9,
      could_not_verify: [],
    });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'FACTS_UNAVAILABLE');
  });

  it('refuses when the fact bundle file is missing entirely', () => {
    const resultPath = writeResult({ schema_version: 2, package: 'foo@1.2.3', status: 'needs_human', reason: 'x', escalation_target: 'team' });
    const res = run(join(work, 'does-not-exist.json'), resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'MISSING_FACT_BUNDLE');
  });
});

describe('runPostValidation — needs_human and input_error', () => {
  it('rejects needs_human when facts are unavailable', async () => {
    const inputPath = writeInput({ identity: 'foo@1.2.3', facts_available: false, reason_code: 'PACKAGE_NOT_FOUND', reason: 'x' });
    const resultPath = writeResult({
      schema_version: 2,
      package: 'foo@1.2.3',
      status: 'needs_human',
      reason: 'not found',
      escalation_target: 'team',
    });
    writeMinimalTierARecipe(work, semverFacts());

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'FACTS_UNAVAILABLE');
  });

  it('rejects needs_human without recipe files', async () => {
    const bundle = semverFacts();
    const inputPath = writeInputFromOutcome('semver@7.7.2', { status: 'ok', bundle });
    const resultPath = writeResult({
      schema_version: 2,
      package: 'semver@7.7.2',
      status: 'needs_human',
      reason: 'tier unclear',
      escalation_target: 'npm-tl-onboarding',
    });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'NEEDS_HUMAN_MISSING_RECIPE');
  });

  it('accepts needs_human with a validated best-effort bundle', async () => {
    const bundle = semverFacts();
    const inputPath = writeInputFromOutcome('semver@7.7.2', { status: 'ok', bundle });
    writeMinimalTierARecipe(work, bundle);
    const resultPath = writeResult({
      schema_version: 2,
      package: 'semver@7.7.2',
      status: 'needs_human',
      reason: 'tier unclear',
      escalation_target: 'npm-tl-onboarding',
    });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'needs_human');
    assert.equal(res.draft_source_dir, join(work, 'packages', 'semver', '7.7.2'));
    assert.ok(res.rendered?.output_dir);
  });

  it('rejects needs_human that re-targets a different identity', async () => {
    const bundle = semverFacts();
    const inputPath = writeInputFromOutcome('semver@7.7.2', { status: 'ok', bundle });
    const resultPath = writeResult({ schema_version: 2, package: 'other@2.0.0', status: 'needs_human', reason: 'x', escalation_target: 'team' });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.check === 'identity-match'));
  });

  it('rejects input_error payloads at post-validate when agent should not have run', () => {
    const inputPath = writeInput({ identity: 'bad', facts_available: false, input_error: true, reason_code: 'INVALID_IDENTITY', reason: 'bad identity' });
    const resultPath = writeResult({ schema_version: 2, package: 'placeholder@0.0.0', status: 'needs_human', reason: 'bad identity', escalation_target: 'triage' });

    const res = run(inputPath, resultPath);
    assert.equal(res.ok, false);
    assert.equal(res.reason_code, 'FACTS_UNAVAILABLE');
  });
});

describe('stageRecipeDraft', () => {
  it('copies agent output into recipes/drafts and writes REVIEW.md', async () => {
    const { stageRecipeDraft } = await import('../scripts/lib/stage-recipe-draft.mjs');
    const bundle = semverFacts();
    writeMinimalTierARecipe(work, bundle);
    const sourceDir = join(work, 'packages', 'semver', '7.7.2');
    const resultPath = writeResult({
      schema_version: 2,
      package: 'semver@7.7.2',
      status: 'needs_human',
      reason: 'needs review',
      escalation_target: 'npm-tl-onboarding',
    });

    const { draftDir, draftRel } = stageRecipeDraft({
      kitchenRoot: work,
      identity: 'semver@7.7.2',
      draftSourceDir: sourceDir,
      resultPath,
      reason: 'needs review',
    });

    assert.equal(draftRel, join('recipes', 'drafts', 'semver', '7.7.2'));
    assert.ok(existsSync(join(draftDir, 'manifest.json')));
    assert.ok(existsSync(join(draftDir, 'recipe-result.json')));
    assert.ok(existsSync(join(draftDir, 'REVIEW.md')));
    assert.match(readFileSync(join(draftDir, 'REVIEW.md'), 'utf-8'), /needs review/);
  });
});
