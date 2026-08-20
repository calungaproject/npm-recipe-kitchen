import { validate } from './validate.mjs';
import { TEMPLATES } from './renderer.mjs';
import { SAFE_REL_PATH_RE, SAFE_BIN_NAME_RE } from './templates/tier-a-npm-pack-no-build-v1.mjs';
import { deriveAuthoritative } from './fact-bundle.mjs';

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

// Authoritative string parameters bound field-by-field to the trusted fact
// bundle. The model is NOT authoritative for any of these — if its emitted value
// differs from the bundle it is rejected. Check names are kept stable
// (source_ref -> `source-sha-match`) so downstream tests/automation can key on
// reason codes rather than prose.
const AUTHORITATIVE_STRING_PARAMS = [
  { key: 'package_name', factField: 'package_name', check: 'package_name-fact-match' },
  { key: 'package_version', factField: 'package_version', check: 'package_version-fact-match' },
  { key: 'source_url', factField: 'source_url', check: 'source_url-fact-match' },
  { key: 'source_ref', factField: 'source_ref', check: 'source-sha-match' },
  { key: 'source_tag', factField: 'source_tag', check: 'source_tag-fact-match' },
  { key: 'upstream_npm_version', factField: 'upstream_npm_version', check: 'upstream_npm_version-fact-match' },
  { key: 'main_entry', factField: 'main_entry', check: 'main_entry-fact-match' },
];

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

  const authoritative = expectedFacts ? deriveAuthoritative(expectedFacts) : null;

  if (authoritative) {
    if (result.package !== authoritative.identity) {
      errors.push({
        check: 'identity-match',
        path: '/package',
        message: `package identity "${result.package}" does not match expected "${authoritative.identity}"`,
      });
    }
  }

  if (result.status === 'drafted') {
    validateDraftedResult(result, authoritative, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateDraftedResult(result, authoritative, errors) {
  if (!TEMPLATES.has(result.template_id)) {
    errors.push({
      check: 'template-allowlist',
      path: '/template_id',
      message: `template_id "${result.template_id}" is not in the renderer allowlist: ${[...TEMPLATES.keys()].join(', ')}`,
    });
  }

  // A drafted result must use the exact template for which the fact bundle
  // established eligibility. Selecting a different (even allowlisted) template
  // than the bundle's classification is rejected.
  if (authoritative && authoritative.template_id && result.template_id !== authoritative.template_id) {
    errors.push({
      check: 'template-eligibility-mismatch',
      path: '/template_id',
      message: `template_id "${result.template_id}" differs from the template the fact bundle established eligibility for ("${authoritative.template_id}")`,
    });
  }

  // ---- Standalone safety checks (run regardless of whether facts are supplied).
  // These are the primary defense in the deterministic post-step and do not
  // depend on the trusted bundle being present.

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
    // post-step (which historically called validateRecipeResult without
    // expectedFacts), so it is a primary defense against command injection into
    // the generated build/smoke scripts.
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

    // cli_bin_name is also interpolated into the generated smoke script, so it
    // gets its own strict single-segment allowlist regardless of facts.
    const binNameParam = result.parameters.cli_bin_name;
    if (binNameParam && typeof binNameParam.value === 'string' && !SAFE_BIN_NAME_RE.test(binNameParam.value)) {
      errors.push({
        check: 'unsafe-shell-path',
        path: '/parameters/cli_bin_name/value',
        message: `cli_bin_name "${binNameParam.value}" must be a single [A-Za-z0-9._-] segment with no whitespace, shell metacharacters, or newlines`,
      });
    }
  }

  if (typeof result.confidence === 'number' && result.confidence < 0.5) {
    errors.push({
      check: 'low-confidence',
      path: '/confidence',
      message: `confidence ${result.confidence} is below the minimum threshold of 0.5 for drafted results`,
    });
  }

  // ---- Authoritative fact binding (only when the trusted bundle is supplied).
  // Every identity/source/build/CLI/entrypoint field must equal the bundle.
  if (authoritative) {
    bindAuthoritativeFields(result, authoritative, errors);
  }
}

function bindAuthoritativeFields(result, a, errors) {
  const params = result.parameters || {};

  for (const { key, factField, check } of AUTHORITATIVE_STRING_PARAMS) {
    const expected = a[factField];
    const param = params[key];
    if (expected === undefined || expected === null) continue;
    if (!param || typeof param.value !== 'string') {
      errors.push({
        check,
        path: `/parameters/${key}`,
        message: `${key} is required and must equal the trusted fact "${expected}"`,
      });
      continue;
    }
    if (param.value !== expected) {
      errors.push({
        check,
        path: `/parameters/${key}/value`,
        message: `${key} "${param.value}" does not match expected trusted fact "${expected}"`,
      });
    }
  }

  // has_cli is a boolean identity fact.
  const hasCliParam = params.has_cli;
  if (!hasCliParam || typeof hasCliParam.value !== 'boolean') {
    errors.push({
      check: 'has_cli-fact-match',
      path: '/parameters/has_cli',
      message: `has_cli is required and must equal the trusted fact "${a.has_cli}"`,
    });
  } else if (hasCliParam.value !== a.has_cli) {
    errors.push({
      check: 'has_cli-fact-match',
      path: '/parameters/has_cli/value',
      message: `has_cli "${hasCliParam.value}" does not match expected trusted fact "${a.has_cli}"`,
    });
  }

  // cli_bin_path presence is authoritative: present-and-equal iff the package
  // has a CLI, absent otherwise. Required absence is enforced explicitly.
  const cliParam = params.cli_bin_path;
  if (a.has_cli && a.cli_bin_path) {
    if (!cliParam || typeof cliParam.value !== 'string') {
      errors.push({
        check: 'cli_bin_path-fact-match',
        path: '/parameters/cli_bin_path',
        message: `cli_bin_path is required and must equal the trusted fact "${a.cli_bin_path}"`,
      });
    } else if (cliParam.value !== a.cli_bin_path) {
      errors.push({
        check: 'cli_bin_path-fact-match',
        path: '/parameters/cli_bin_path/value',
        message: `cli_bin_path "${cliParam.value}" does not match expected trusted fact "${a.cli_bin_path}"`,
      });
    }
  } else if (cliParam !== undefined) {
    errors.push({
      check: 'cli_bin_path-should-be-absent',
      path: '/parameters/cli_bin_path',
      message: 'cli_bin_path must be absent when the trusted facts report no CLI',
    });
  }

  // cli_bin_name, when the model emits it, must equal the trusted command name
  // (which may differ from the bin file basename). It must be absent for a
  // non-CLI package.
  const binNameParam = params.cli_bin_name;
  if (a.has_cli && a.cli_bin_name) {
    if (binNameParam && typeof binNameParam.value === 'string' && binNameParam.value !== a.cli_bin_name) {
      errors.push({
        check: 'cli_bin_name-fact-match',
        path: '/parameters/cli_bin_name/value',
        message: `cli_bin_name "${binNameParam.value}" does not match expected trusted fact "${a.cli_bin_name}"`,
      });
    }
  } else if (binNameParam !== undefined) {
    errors.push({
      check: 'cli_bin_name-should-be-absent',
      path: '/parameters/cli_bin_name',
      message: 'cli_bin_name must be absent when the trusted facts report no CLI',
    });
  }

  // Trusted could_not_verify observations must survive into the result: the
  // model may add caveats but may not drop the ones the collector recorded.
  const emitted = new Set(Array.isArray(result.could_not_verify) ? result.could_not_verify : []);
  for (const item of a.could_not_verify) {
    if (!emitted.has(item)) {
      errors.push({
        check: 'could-not-verify-omitted',
        path: '/could_not_verify',
        message: `trusted observation omitted from could_not_verify: "${item}"`,
      });
    }
  }
}

/**
 * Validate a needs_human result. When `expectedIdentity` is supplied the result
 * must remain bound to the requested valid package identity — a needs_human
 * result may not silently re-target a different package.
 */
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

export { NAME_VERSION_RE };
