// Runner-side post-inference validation.
//
// Validates recipe-result.json and, for drafted outcomes, the agent-authored
// recipe bundle under packages/<name>/<version>/.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { validateRecipeResult, validateNeedsHumanResult } from './recipe-validator.mjs';
import { validateRecipeBundle, recipeDirForIdentity } from './recipe-bundle.mjs';
import { validateFacts } from './facts.mjs';

/**
 * @typedef {Object} PostValidateOutcome
 * @property {boolean} ok
 * @property {string}  [status]
 * @property {string}  [identity]
 * @property {string}  [reason_code]
 * @property {Array}   [errors]
 * @property {object}  [rendered]
 * @property {string}  [audit_path]
 * @property {string}  [message]
 */

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * @param {object} opts
 * @param {string} opts.resultPath
 * @param {string} opts.inputPath
 * @param {string} opts.repoRoot
 * @param {string} [opts.renderRoot]
 * @param {string} [opts.auditDir]
 * @returns {PostValidateOutcome}
 */
export function runPostValidation({ resultPath, inputPath, repoRoot, renderRoot, auditDir }) {
  const renderTarget = renderRoot ?? repoRoot;

  let input;
  try {
    input = readJson(inputPath);
  } catch (err) {
    return { ok: false, reason_code: 'MISSING_FACT_BUNDLE', message: `fact bundle not readable at ${inputPath}: ${err.message}` };
  }

  let result;
  try {
    result = readJson(resultPath);
  } catch (err) {
    return { ok: false, reason_code: 'INVALID_RESULT_JSON', message: `${resultPath} is not valid JSON: ${err.message}` };
  }

  const factsAvailable = input.facts_available === true;
  const facts = input.facts;
  const inputError = input.input_error === true;

  if (inputError) {
    if (result.status === 'drafted') {
      return { ok: false, reason_code: 'DRAFT_ON_INPUT_ERROR', message: 'a drafted result is not permitted for an invalid/missing package identity' };
    }
    const audit_path = persistAudit({ auditDir, repoRoot, input, outcome: 'input_error' });
    return { ok: true, status: 'input_error', identity: input.identity, reason_code: input.reason_code, message: input.reason, audit_path };
  }

  if (result.status === 'drafted') {
    if (!factsAvailable || !facts) {
      return { ok: false, reason_code: 'DRAFT_WITHOUT_FACTS', message: 'a drafted result is not permitted when facts are unavailable' };
    }
    const factCheck = validateFacts(facts);
    if (!factCheck.valid) {
      return { ok: false, reason_code: 'INVALID_FACT_BUNDLE', errors: factCheck.errors, message: 'fact bundle failed validation; refusing to draft' };
    }

    const validation = validateRecipeResult(result, facts);
    if (!validation.valid) {
      return { ok: false, reason_code: 'RESULT_REJECTED', errors: validation.errors, message: 'recipe result rejected against trusted facts' };
    }

    const recipeDir = recipeDirForIdentity(renderTarget, result.package);
    if (!recipeDir) {
      return { ok: false, reason_code: 'INVALID_IDENTITY', message: `cannot resolve recipe directory for package identity ${result.package}` };
    }

    const bundleCheck = validateRecipeBundle({
      recipeDir,
      renderRoot: renderTarget,
      facts,
    });
    if (!bundleCheck.valid) {
      return {
        ok: false,
        reason_code: 'RECIPE_BUNDLE_REJECTED',
        errors: bundleCheck.errors,
        message: 'agent-authored recipe bundle failed validation',
      };
    }

    if (bundleCheck.manifest?.native_tier && result.native_tier !== bundleCheck.manifest.native_tier) {
      return {
        ok: false,
        reason_code: 'TIER_MISMATCH',
        message: `recipe-result native_tier "${result.native_tier}" does not match manifest native_tier "${bundleCheck.manifest.native_tier}"`,
      };
    }

    const rendered = {
      output_dir: recipeDir,
      files: bundleCheck.files ?? [],
      native_tier: result.native_tier,
    };

    const audit_path = persistAudit({ auditDir, repoRoot, input, outcome: 'drafted', rendered });
    return { ok: true, status: 'drafted', identity: result.package, rendered, audit_path };
  }

  if (result.status === 'needs_human') {
    const expectedIdentity = facts?.identity ?? input.identity;
    const validation = validateNeedsHumanResult(result, expectedIdentity);
    if (!validation.valid) {
      return { ok: false, reason_code: 'RESULT_REJECTED', errors: validation.errors, message: 'needs_human result rejected' };
    }
    const audit_path = persistAudit({ auditDir, repoRoot, input, outcome: 'needs_human' });
    let draft_source_dir = '';
    if (expectedIdentity) {
      const candidate = recipeDirForIdentity(renderTarget, expectedIdentity);
      if (candidate && existsSync(candidate)) {
        draft_source_dir = candidate;
      }
    }
    return {
      ok: true,
      status: 'needs_human',
      identity: expectedIdentity,
      message: result.reason,
      audit_path,
      draft_source_dir,
    };
  }

  return { ok: false, reason_code: 'UNKNOWN_STATUS', message: `unknown result.status ${JSON.stringify(result.status)}` };
}

function persistAudit({ auditDir, repoRoot, input, outcome, rendered }) {
  const facts = input.facts;
  const identity = facts?.identity ?? input.identity ?? 'unknown';
  const safeName = (facts?.package_name ?? 'unknown').replace(/[^A-Za-z0-9._@/-]/g, '_');
  const safeVersion = (facts?.package_version ?? '0.0.0').replace(/[^A-Za-z0-9._-]/g, '_');

  const dir = auditDir ?? join(repoRoot, 'recipes', 'audit', safeName, safeVersion);
  mkdirSync(dir, { recursive: true });

  const classification = facts?.classification ?? {};
  const artifact = {
    schema_version: 1,
    outcome,
    identity,
    generated_from: 'runner-side post-validation',
    facts_available: input.facts_available === true,
    reason_code: input.reason_code ?? null,
    reason: input.reason ?? null,
    verification_summary: facts ? summarizeFacts(facts) : null,
    fact_bundle: facts ?? null,
    rendered: rendered ? { output_dir: rendered.output_dir, files: rendered.files, native_tier: rendered.native_tier } : null,
  };

  const path = join(dir, 'fact-bundle.json');
  writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n', 'utf-8');
  return path;
}

function summarizeFacts(facts) {
  const registry = facts.registry ?? {};
  const source = facts.source ?? {};
  const classification = facts.classification ?? {};
  return {
    collector_version: facts.collector?.version ?? null,
    schema_version: facts.schema_version ?? null,
    identity: facts.identity ?? null,
    registry_url: registry.registry_url ?? null,
    tarball_url: registry.tarball_url ?? null,
    dist_integrity: registry.dist_integrity ?? null,
    registry_signature_status: registry.registry_signature_status ?? null,
    provenance_status: registry.provenance_status ?? null,
    source_url: source.git_url ?? null,
    source_commit_sha: source.commit_sha ?? null,
    source_resolution_method: source.resolution_method ?? null,
    registry_contract_sha: facts.registry_contract_sha ?? null,
    digests: facts.digests ?? null,
    could_not_verify: Array.isArray(facts.could_not_verify) ? facts.could_not_verify : [],
    classification_reasons: Array.isArray(classification.reasons) ? classification.reasons : [],
    tier_a_eligible: classification.tier_a_eligible ?? null,
    native_tier: classification.native_tier ?? facts.native_tier ?? null,
    template_id: classification.template_id ?? null,
  };
}
