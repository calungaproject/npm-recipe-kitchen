import { validate } from './validate.mjs';
import { deriveManifestBinding } from './fact-bundle.mjs';

export function validateRecipeResult(result, expectedFacts) {
  const errors = [];

  const schemaResult = validate('recipe-result', result);
  if (!schemaResult.valid) {
    return {
      valid: false,
      errors: schemaResult.errors.map(e => ({
        check: 'schema',
        ...e,
      })),
    };
  }

  const binding = expectedFacts ? deriveManifestBinding(expectedFacts) : null;

  if (binding) {
    if (result.package !== binding.identity) {
      errors.push({
        check: 'identity-match',
        path: '/package',
        message: `package identity "${result.package}" does not match expected "${binding.identity}"`,
      });
    }
  }

  if (result.status === 'drafted') {
    validateDraftedResult(result, binding, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateDraftedResult(result, binding, errors) {
  if (!result.evidence || result.evidence.length === 0) {
    errors.push({
      check: 'evidence-present',
      path: '/evidence',
      message: 'drafted result must include at least one evidence item',
    });
  }

  if (typeof result.confidence === 'number' && result.confidence < 0.5) {
    errors.push({
      check: 'low-confidence',
      path: '/confidence',
      message: `confidence ${result.confidence} is below the minimum threshold of 0.5 for drafted results`,
    });
  }

  if (binding) {
    bindCouldNotVerify(result, binding, errors);
    if (binding.suggested_native_tier && result.native_tier !== binding.suggested_native_tier) {
      // Advisory only — record mismatch but do not reject. Human review catches bad tiers.
      // No error pushed.
    }
  }
}

function bindCouldNotVerify(result, binding, errors) {
  const emitted = new Set(Array.isArray(result.could_not_verify) ? result.could_not_verify : []);
  for (const item of binding.could_not_verify) {
    if (!emitted.has(item)) {
      errors.push({
        check: 'could-not-verify-omitted',
        path: '/could_not_verify',
        message: `trusted observation omitted from could_not_verify: "${item}"`,
      });
    }
  }
}

export function validateNeedsHumanResult(result, expectedIdentity) {
  const schemaResult = validate('recipe-result', result);
  if (!schemaResult.valid) {
    return { valid: false, errors: schemaResult.errors };
  }
  if (result.status !== 'needs_human') {
    return { valid: false, errors: [{ check: 'status', path: '/status', message: 'expected needs_human status' }] };
  }
  if (expectedIdentity !== undefined && expectedIdentity !== null && result.package !== expectedIdentity) {
    return {
      valid: false,
      errors: [{
        check: 'identity-match',
        path: '/package',
        message: `needs_human package "${result.package}" does not match requested identity "${expectedIdentity}"`,
      }],
    };
  }
  return { valid: true, errors: [] };
}
