// Validate agent-authored npm-registry recipe directories (manifest + scripts).
//
// The post-validation gate checks files the model wrote under
// packages/<name>/<version>/ — it does not render from templates.

import { readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, relative, normalize } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import { deriveManifestBinding } from './fact-bundle.mjs';

export const RECIPE_PACKAGES_BASE = 'packages';
export const RECIPE_DRAFTS_BASE = 'recipes/drafts';
export const REQUIRED_RECIPE_FILES = ['manifest.json', 'build.entrypoint.sh', 'verify.smoke.sh'];
export const ALLOWED_EXTRA_FILES = new Set(['tl-install.js', 'evidence.md']);

const NPM_PUBLISH_RE = /\bnpm\s+publish\b/;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

let manifestValidator;
function getManifestValidator() {
  if (manifestValidator) return manifestValidator;
  const schemaPath = new URL(
    '../../test/fixtures/registry-contract/017ebd5a3c5fef6d595f7c852fd584a7d5fae255/manifest.schema.json',
    import.meta.url,
  );
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
  manifestValidator = ajv.compile(schema);
  return manifestValidator;
}

/**
 * Relative recipe path under the target repo root.
 * @param {string} packageName
 * @param {string} packageVersion
 */
export function recipeRelDir(packageName, packageVersion) {
  return join(RECIPE_PACKAGES_BASE, packageName, packageVersion);
}

export function recipeDraftRelDir(packageName, packageVersion) {
  return join(RECIPE_DRAFTS_BASE, packageName, packageVersion);
}

export function resolveRecipeDraftDir(kitchenRoot, packageName, packageVersion) {
  return join(kitchenRoot, RECIPE_DRAFTS_BASE, packageName, packageVersion);
}

export function resolveRecipeDir(renderRoot, packageName, packageVersion) {
  return join(renderRoot, RECIPE_PACKAGES_BASE, packageName, packageVersion);
}

function parseIdentity(identity) {
  const at = identity.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: identity.slice(0, at), version: identity.slice(at + 1) };
}

function validatePathInsideBase(absPath, absBase, errors, label) {
  const normPath = resolve(absPath);
  const normBase = resolve(absBase);
  if (normPath !== normBase && !normPath.startsWith(normBase + '/')) {
    errors.push({
      check: 'path-escape',
      path: label,
      message: `${label} escapes allowed base ${normBase}`,
    });
  }
}

/**
 * @param {object} opts
 * @param {string} opts.recipeDir   absolute path to packages/<name>/<version>
 * @param {string} opts.renderRoot  repo root containing packages/
 * @param {object} [opts.facts]     trusted fact bundle
 * @returns {{ valid: boolean, errors: Array, manifest?: object, files?: string[] }}
 */
export function validateRecipeBundle({ recipeDir, renderRoot, facts }) {
  const errors = [];
  const absRecipe = resolve(recipeDir);
  const absBase = resolve(renderRoot, RECIPE_PACKAGES_BASE);
  validatePathInsideBase(absRecipe, absBase, errors, '/recipeDir');

  if (!existsSync(absRecipe)) {
    errors.push({ check: 'recipe-dir-missing', path: '/recipeDir', message: `recipe directory not found: ${absRecipe}` });
    return { valid: false, errors };
  }

  let entries;
  try {
    entries = readdirSync(absRecipe);
  } catch (err) {
    errors.push({ check: 'recipe-dir-unreadable', path: '/recipeDir', message: err.message });
    return { valid: false, errors };
  }

  for (const name of REQUIRED_RECIPE_FILES) {
    const p = join(absRecipe, name);
    if (!existsSync(p)) {
      errors.push({ check: 'required-file-missing', path: `/files/${name}`, message: `missing required file ${name}` });
    }
  }

  for (const name of entries) {
    if (REQUIRED_RECIPE_FILES.includes(name) || ALLOWED_EXTRA_FILES.has(name)) continue;
    errors.push({
      check: 'unexpected-file',
      path: `/files/${name}`,
      message: `unexpected file in recipe directory: ${name}`,
    });
  }

  const manifestPath = join(absRecipe, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { valid: errors.length === 0, errors };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    errors.push({ check: 'manifest-json', path: '/manifest.json', message: `invalid JSON: ${err.message}` });
    return { valid: false, errors };
  }

  const validateManifest = getManifestValidator();
  if (!validateManifest(manifest)) {
    for (const e of validateManifest.errors ?? []) {
      errors.push({
        check: 'manifest-schema',
        path: `/manifest.json${e.instancePath}`,
        message: e.message,
      });
    }
  }

  validateManifestSemantics(manifest, errors);
  validateShellScript(join(absRecipe, 'build.entrypoint.sh'), 'build.entrypoint.sh', errors);
  validateShellScript(join(absRecipe, 'verify.smoke.sh'), 'verify.smoke.sh', errors);

  if (facts) {
    bindManifestToFacts(manifest, facts, errors);
  }

  const files = entries.filter(e => {
    const p = join(absRecipe, e);
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  });

  return { valid: errors.length === 0, errors, manifest, files };
}

function validateManifestSemantics(manifest, errors) {
  const tier = manifest.native_tier;
  const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : [];
  const mainOutputs = outputs.filter(o => o.type === 'npm-package');
  const platformOutputs = outputs.filter(o => o.type === 'tl-platform-package');

  if (mainOutputs.length !== 1) {
    errors.push({
      check: 'outputs-main-count',
      path: '/manifest.json/outputs',
      message: 'exactly one npm-package output is required',
    });
  }

  if (tier === 'A') {
    if (platformOutputs.length > 0) {
      errors.push({
        check: 'tier-a-no-platform',
        path: '/manifest.json/native_tier',
        message: 'Tier A manifest must not declare tl-platform-package outputs',
      });
    }
    if (manifest.optional_dependencies_published?.length) {
      errors.push({
        check: 'tier-a-no-optionals',
        path: '/manifest.json/optional_dependencies_published',
        message: 'Tier A manifest must not declare optional_dependencies_published',
      });
    }
  }

  if (tier === 'B' || tier === 'C') {
    if (platformOutputs.length !== 1) {
      errors.push({
        check: 'tier-bc-platform-count',
        path: '/manifest.json/outputs',
        message: 'Tier B/C manifest must declare exactly one tl-platform-package output',
      });
    }
    const opt = manifest.optional_dependencies_published;
    if (!Array.isArray(opt) || opt.length !== 1) {
      errors.push({
        check: 'tier-bc-optionals',
        path: '/manifest.json/optional_dependencies_published',
        message: 'Tier B/C manifest must declare exactly one optional_dependencies_published entry',
      });
    }
    const platform = platformOutputs[0];
    if (platform && typeof platform.pulp_name === 'string' && !platform.pulp_name.startsWith('@calunga/')) {
      errors.push({
        check: 'platform-pulp-name',
        path: '/manifest.json/outputs',
        message: 'tl-platform-package pulp_name must be under @calunga/',
      });
    }
  }

  if (manifest.entrypoint !== 'build.entrypoint.sh' || manifest.smoke !== 'verify.smoke.sh') {
    errors.push({
      check: 'entrypoint-smoke-names',
      path: '/manifest.json',
      message: 'entrypoint must be build.entrypoint.sh and smoke must be verify.smoke.sh',
    });
  }

  for (const out of outputs) {
    if (typeof out.path === 'string' && !out.path.startsWith('out/')) {
      errors.push({
        check: 'output-path-prefix',
        path: '/manifest.json/outputs',
        message: `output path must start with out/: ${out.path}`,
      });
    }
  }
}

function validateShellScript(path, label, errors) {
  if (!existsSync(path)) return;
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    errors.push({ check: 'shell-read', path: `/${label}`, message: err.message });
    return;
  }
  if (!content.startsWith('#!')) {
    errors.push({ check: 'shell-shebang', path: `/${label}`, message: `${label} must start with a shebang` });
  }
  if (!/\bset\s+-[a-z]*e/.test(content)) {
    errors.push({ check: 'shell-set-e', path: `/${label}`, message: `${label} must use set -e (or set -euo pipefail)` });
  }
  if (NPM_PUBLISH_RE.test(content)) {
    errors.push({ check: 'shell-no-publish', path: `/${label}`, message: `${label} must not call npm publish` });
  }
  if (CONTROL_CHAR_RE.test(content.replace(/[\n\r\t]/g, ''))) {
    errors.push({ check: 'shell-control-chars', path: `/${label}`, message: `${label} contains unexpected control characters` });
  }
}

function bindManifestToFacts(manifest, facts, errors) {
  const binding = deriveManifestBinding(facts);
  if (!binding) return;

  if (manifest.name !== binding.package_name) {
    errors.push({
      check: 'manifest-name-fact-match',
      path: '/manifest.json/name',
      message: `manifest name "${manifest.name}" does not match trusted fact "${binding.package_name}"`,
    });
  }
  if (manifest.version !== binding.package_version) {
    errors.push({
      check: 'manifest-version-fact-match',
      path: '/manifest.json/version',
      message: `manifest version "${manifest.version}" does not match trusted fact "${binding.package_version}"`,
    });
  }
  if (manifest.source?.url !== binding.source_url) {
    errors.push({
      check: 'manifest-source-url-fact-match',
      path: '/manifest.json/source/url',
      message: `manifest source.url does not match trusted fact "${binding.source_url}"`,
    });
  }
  const ref = manifest.source?.ref;
  if (typeof ref === 'string' && binding.source_ref_options.length > 0) {
    if (!binding.source_ref_options.includes(ref)) {
      errors.push({
        check: 'manifest-source-ref-fact-match',
        path: '/manifest.json/source/ref',
        message: `manifest source.ref "${ref}" must match trusted tag or commit (${binding.source_ref_options.join(' or ')})`,
      });
    }
  }
}

/**
 * Resolve the recipe directory for a drafted result from package identity.
 * @param {string} renderRoot
 * @param {string} identity  name@version
 */
export function recipeDirForIdentity(renderRoot, identity) {
  const parsed = parseIdentity(identity);
  if (!parsed) return null;
  return resolveRecipeDir(renderRoot, parsed.name, parsed.version);
}

export function relativeRecipeDir(identity) {
  const parsed = parseIdentity(identity);
  if (!parsed) return null;
  return recipeRelDir(parsed.name, parsed.version);
}
