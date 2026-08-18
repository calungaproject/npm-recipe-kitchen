import { validate } from './validate.mjs';
import { TEMPLATES } from './renderer.mjs';
import { SAFE_REL_PATH_RE } from './templates/tier-a-npm-pack-no-build-v1.mjs';

const HEX40_RE = /^[0-9a-f]{40}$/;
const NAME_VERSION_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+([-+][-a-zA-Z0-9.+]+)?$/;
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SHELL_META_RE = /[$`\\;|&><(){}\[\]!#~]/;

// Parameters whose values are interpolated into the generated build/smoke
// shell scripts as relative paths inside the packed tarball. They must be
// constrained to a strict allowlist so untrusted model output cannot inject
// commands (e.g. a newline followed by `curl ... | sh`) into the scripts the
// build pipeline executes.
const SHELL_PATH_PARAMS = ['main_entry', 'cli_bin_path'];

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

  if (expectedFacts) {
    if (result.package !== expectedFacts.identity) {
      errors.push({
        check: 'identity-match',
        path: '/package',
        message: `package identity "${result.package}" does not match expected "${expectedFacts.identity}"`,
      });
    }
  }

  if (result.status === 'drafted') {
    validateDraftedResult(result, expectedFacts, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateDraftedResult(result, expectedFacts, errors) {
  if (!TEMPLATES.has(result.template_id)) {
    errors.push({
      check: 'template-allowlist',
      path: '/template_id',
      message: `template_id "${result.template_id}" is not in the renderer allowlist: ${[...TEMPLATES.keys()].join(', ')}`,
    });
  }

  if (expectedFacts?.source?.commit_sha && result.parameters?.source_ref) {
    const emittedRef = result.parameters.source_ref.value;
    if (emittedRef !== expectedFacts.source.commit_sha) {
      errors.push({
        check: 'source-sha-match',
        path: '/parameters/source_ref',
        message: `source_ref "${emittedRef}" does not match expected SHA "${expectedFacts.source.commit_sha}"`,
      });
    }
  }

  if (result.parameters?.source_ref) {
    const ref = result.parameters.source_ref.value;
    if (typeof ref !== 'string' || !HEX40_RE.test(ref)) {
      errors.push({
        check: 'source-ref-format',
        path: '/parameters/source_ref',
        message: `source_ref must be a 40-character lowercase hex SHA, got "${ref}"`,
      });
    }
  }

  if (!result.evidence || result.evidence.length === 0) {
    errors.push({
      check: 'evidence-present',
      path: '/evidence',
      message: 'drafted result must include at least one evidence item',
    });
  }

  if (result.parameters) {
    for (const [key, param] of Object.entries(result.parameters)) {
      if (typeof param.value === 'string') {
        if (param.value.includes('\0')) {
          errors.push({
            check: 'nul-char',
            path: `/parameters/${key}/value`,
            message: 'parameter value contains NUL character',
          });
        }
        if (/\.\./.test(param.value) && (key === 'package_name' || key === 'cli_bin_path' || key === 'main_entry')) {
          errors.push({
            check: 'path-traversal',
            path: `/parameters/${key}/value`,
            message: 'parameter value contains path traversal pattern',
          });
        }
      }
    }

    if (result.parameters.package_name) {
      const name = result.parameters.package_name.value;
      if (typeof name === 'string' && !NPM_NAME_RE.test(name)) {
        errors.push({
          check: 'package-name-format',
          path: '/parameters/package_name',
          message: `package_name "${name}" is not a valid npm package name`,
        });
      }
      if (typeof name === 'string' && SHELL_META_RE.test(name)) {
        errors.push({
          check: 'shell-metachar',
          path: '/parameters/package_name',
          message: 'package_name contains shell metacharacters',
        });
      }
    }

    if (result.parameters.source_url) {
      const url = result.parameters.source_url.value;
      if (typeof url === 'string' && !url.startsWith('https://')) {
        errors.push({
          check: 'source-url-scheme',
          path: '/parameters/source_url',
          message: 'source_url must use https://',
        });
      }
    }

    // Shell-interpolated path parameters get a strict allowlist regardless of
    // whether facts were supplied. This runs even in the deterministic
    // post-step (which calls validateRecipeResult without expectedFacts), so
    // it is the primary defense against command injection into the generated
    // build/smoke scripts.
    for (const key of SHELL_PATH_PARAMS) {
      const param = result.parameters[key];
      if (!param || typeof param.value !== 'string') continue;
      const value = param.value;
      if (!SAFE_REL_PATH_RE.test(value)) {
        errors.push({
          check: 'unsafe-shell-path',
          path: `/parameters/${key}/value`,
          message: `${key} "${value}" must be a relative path of [A-Za-z0-9._-] segments with no whitespace, shell metacharacters, or newlines`,
        });
      }
    }

    // When facts are available, cross-check the path parameters against the
    // deterministic upstream facts the same way source_ref is checked against
    // the known commit SHA. Untrusted model output must not diverge from what
    // we independently derived.
    if (expectedFacts?.upstream) {
      for (const key of SHELL_PATH_PARAMS) {
        const param = result.parameters[key];
        const expected = expectedFacts.upstream[key];
        if (param && typeof param.value === 'string' && expected !== undefined && param.value !== expected) {
          errors.push({
            check: `${key}-fact-match`,
            path: `/parameters/${key}/value`,
            message: `${key} "${param.value}" does not match expected upstream fact "${expected}"`,
          });
        }
      }
    }
  }

  if (typeof result.confidence === 'number' && result.confidence < 0.5) {
    errors.push({
      check: 'low-confidence',
      path: '/confidence',
      message: `confidence ${result.confidence} is below the minimum threshold of 0.5 for drafted results`,
    });
  }
}

export function validateNeedsHumanResult(result) {
  const schemaResult = validate('recipe-result', result);
  if (!schemaResult.valid) {
    return { valid: false, errors: schemaResult.errors };
  }
  if (result.status !== 'needs_human') {
    return { valid: false, errors: [{ check: 'status', path: '/status', message: 'expected needs_human status' }] };
  }
  return { valid: true, errors: [] };
}
