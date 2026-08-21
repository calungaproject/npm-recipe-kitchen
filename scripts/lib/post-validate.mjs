// Runner-side post-inference validation and rendering.
//
// This is the Gate 0 enforcement point. It runs on the trusted runner after the
// sandboxed agent exits and is the module the post-script (post-recipe-validate.sh)
// invokes. It:
//
//   1. loads the EXACT fact bundle the pre-script produced for inference
//      (recipe-input.json), so validation and rendering use the same facts the
//      agent saw — never a silently recomputed set,
//   2. validates the bundle itself,
//   3. validates the agent's result AGAINST the bundle (identity/source/build/
//      CLI/entrypoint equality, template eligibility), and
//   4. for a drafted result, RE-DERIVES the authoritative parameters from the
//      bundle and renders those — the model is authoritative only for the
//      bounded description and its own evidence.
//
// A `drafted` outcome is therefore impossible when facts are unavailable, the
// bundle fails validation, the model changed/omitted an authoritative value, or
// the selected template differs from the bundle's eligibility template.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateRecipeResult, validateNeedsHumanResult } from './recipe-validator.mjs';
import { render, RenderError } from './renderer.mjs';
import { buildParametersFromFacts, deriveAuthoritative } from './fact-bundle.mjs';
import { validateFacts } from './facts.mjs';

/**
 * @typedef {Object} PostValidateOutcome
 * @property {boolean} ok
 * @property {string}  [status]        drafted | needs_human | input_error
 * @property {string}  [identity]      the bound package identity (name@version)
 * @property {string}  [reason_code]   stable code on rejection
 * @property {Array}   [errors]        validation errors on rejection
 * @property {object}  [rendered]      renderer result for drafted outcomes
 * @property {string}  [audit_path]    path to the persisted fact-bundle artifact
 * @property {string}  [message]
 */

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * @param {object} opts
 * @param {string} opts.resultPath  path to the agent's recipe-result.json
 * @param {string} opts.inputPath   path to the pre-script's recipe-input.json (fact bundle wrapper)
 * @param {string} opts.repoRoot    repo root used to LOCATE runner code and to
 *                                  place the kitchen-side audit artifact; this is
 *                                  the config checkout, which is NOT committed.
 * @param {string} [opts.renderRoot] repo root the recipe bundle is RENDERED into.
 *                                  In CI this must be the target-repo working tree
 *                                  that the post-script commits/pushes ($REPO_DIR),
 *                                  which is a different checkout from `repoRoot`.
 *                                  Defaults to `repoRoot` for local runs and tests
 *                                  where both are the same tree.
 * @param {string} [opts.auditDir]  where to persist the fact-bundle audit artifact
 * @returns {PostValidateOutcome}
 */
export function runPostValidation({ resultPath, inputPath, repoRoot, renderRoot, auditDir }) {
  // Render into the target-repo working tree when provided, else the config
  // checkout. The audit artifact always stays with `repoRoot` (kitchen-side,
  // gitignored) so it never enters the registry PR diff.
  const renderTarget = renderRoot ?? repoRoot;
  // The fact bundle is REQUIRED. Without it we cannot bind the result to the
  // facts inference was performed on, so we refuse rather than fall back to an
  // unbound (inert) validation.
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

  // Explicit input-error path: a missing / syntactically invalid requested
  // identity is a deterministic runner outcome. We never ask the model to
  // fabricate a schema-valid identity, and a drafted result is impossible here.
  if (inputError) {
    if (result.status === 'drafted') {
      return { ok: false, reason_code: 'DRAFT_ON_INPUT_ERROR', message: 'a drafted result is not permitted for an invalid/missing package identity' };
    }
    const audit_path = persistAudit({ auditDir, repoRoot, input, outcome: 'input_error' });
    return { ok: true, status: 'input_error', identity: input.identity, reason_code: input.reason_code, message: input.reason, audit_path };
  }

  if (result.status === 'drafted') {
    // A drafted result requires an available, valid fact bundle.
    if (!factsAvailable || !facts) {
      return { ok: false, reason_code: 'DRAFT_WITHOUT_FACTS', message: 'a drafted result is not permitted when facts are unavailable' };
    }
    const factCheck = validateFacts(facts);
    if (!factCheck.valid) {
      return { ok: false, reason_code: 'INVALID_FACT_BUNDLE', errors: factCheck.errors, message: 'fact bundle failed validation; refusing to draft' };
    }

    // Bind the model's result to the trusted bundle. Any divergence in an
    // authoritative field (identity/source/build/CLI/entrypoint) or template
    // eligibility is rejected here.
    const validation = validateRecipeResult(result, facts);
    if (!validation.valid) {
      return { ok: false, reason_code: 'RESULT_REJECTED', errors: validation.errors, message: 'recipe result rejected against trusted facts' };
    }

    // Render from AUTHORITATIVE parameters re-derived from the bundle. The model
    // contributes only the bounded description and its evidence.
    const authoritative = deriveAuthoritative(facts);
    const description = result.parameters?.description?.value;
    const authoritativeParams = buildParametersFromFacts(facts, { description });
    const renderResult = {
      ...result,
      template_id: authoritative.template_id,
      parameters: authoritativeParams,
      // could_not_verify is a trusted observation set, not model prose.
      could_not_verify: authoritative.could_not_verify,
    };

    let rendered;
    try {
      rendered = render(renderResult, renderTarget);
    } catch (err) {
      if (err instanceof RenderError) {
        return { ok: false, reason_code: 'RENDER_REJECTED', message: err.message };
      }
      throw err;
    }

    const audit_path = persistAudit({ auditDir, repoRoot, input, outcome: 'drafted', rendered });
    return { ok: true, status: 'drafted', identity: authoritative.identity, rendered, audit_path };
  }

  if (result.status === 'needs_human') {
    // A needs_human result must remain bound to the requested valid identity.
    const expectedIdentity = facts?.identity ?? input.identity;
    const validation = validateNeedsHumanResult(result, expectedIdentity);
    if (!validation.valid) {
      return { ok: false, reason_code: 'RESULT_REJECTED', errors: validation.errors, message: 'needs_human result rejected' };
    }
    const audit_path = persistAudit({ auditDir, repoRoot, input, outcome: 'needs_human' });
    return { ok: true, status: 'needs_human', identity: expectedIdentity, message: result.reason, audit_path };
  }

  return { ok: false, reason_code: 'UNKNOWN_STATUS', message: `unknown result.status ${JSON.stringify(result.status)}` };
}

/**
 * Persist the exact fact bundle used for inference/validation as a reviewable,
 * kitchen-side audit artifact. This is NOT part of the rendered recipe bundle
 * (which becomes the registry PR diff) — it is retained separately.
 */
function persistAudit({ auditDir, repoRoot, input, outcome, rendered }) {
  const facts = input.facts;
  const identity = facts?.identity ?? input.identity ?? 'unknown';
  const safeName = (facts?.package_name ?? 'unknown').replace(/[^A-Za-z0-9._@/-]/g, '_');
  const safeVersion = (facts?.package_version ?? '0.0.0').replace(/[^A-Za-z0-9._-]/g, '_');

  const dir = auditDir ?? join(repoRoot, 'recipes', 'audit', safeName, safeVersion);
  mkdirSync(dir, { recursive: true });

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
    rendered: rendered ? { output_dir: rendered.output_dir, files: rendered.files, template_id: rendered.template_id } : null,
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
    native_tier: classification.native_tier ?? facts.native_tier ?? null,
    template_id: classification.template_id ?? null,
  };
}
