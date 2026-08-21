// Fact-bundle helpers: the single mapping from a trusted fact bundle to the
// authoritative recipe parameters.
//
// A fact bundle is produced by the on-demand collector
// (scripts/lib/compute-facts.mjs). deriveAuthoritative() collapses it onto a
// single set of authoritative accessors so the validator (recipe-validator.mjs)
// and the renderer (post-validate.mjs) never trust model-echoed values for
// identity, source, build, CLI, or entrypoint facts.
//
// Distinction preserved throughout:
//   - raw observations       -> registry.* / upstream.* / source.*
//   - verification state      -> registry.*_status, source.resolution_method
//   - policy classification   -> classification.*
//   - unresolved questions    -> could_not_verify
// deriveAuthoritative() collapses the raw+verified sections into the exact
// fields the template needs, and nothing else is authoritative.

import { TEMPLATE_ID as TIER_A_TEMPLATE_ID } from './templates/tier-a-npm-pack-no-build-v1.mjs';

export const FACT_BUNDLE_SCHEMA_VERSION = 1;

const NATIVE_TIER_TEMPLATE = new Map([
  ['A', TIER_A_TEMPLATE_ID],
]);

// The bounded, model-supplied fields. Everything else in a drafted result is
// reconstructed from the trusted bundle and the model is not authoritative for
// it. `description` is judgment-oriented prose; `evidence`/`confidence` are the
// model's own observations. All are still bounded/sanitised by the renderer and
// schema.
export const MODEL_SUPPLIED_PARAMS = new Set(['description']);

function basenameNoExt(p) {
  if (typeof p !== 'string') return null;
  const base = p.split('/').pop();
  return base ? base.replace(/\.[cm]?js$/, '') : null;
}

/**
 * Collapse a fact bundle into the exact authoritative fields a recipe result
 * must bind. Returns `null` when the bundle is not shaped like a fact bundle at
 * all.
 */
export function deriveAuthoritative(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const source = bundle.source || {};
  const upstream = bundle.upstream || {};
  const classification = bundle.classification || {};

  const templateId = classification.template_id
    ?? NATIVE_TIER_TEMPLATE.get(bundle.native_tier)
    ?? undefined;

  return {
    identity: bundle.identity,
    package_name: bundle.package_name,
    package_version: bundle.package_version,
    source_url: source.git_url,
    source_ref: source.commit_sha,
    source_tag: source.tag,
    // The upstream npm version is, by construction, the exact requested version;
    // carry the collector's explicit field, else fall back to the package version.
    upstream_npm_version: upstream.upstream_npm_version ?? bundle.package_version,
    has_cli: upstream.has_cli === true,
    // A missing CLI bin path is authoritative absence, not "unknown": normalise
    // to null so the validator can require the parameter to be absent.
    cli_bin_path: upstream.has_cli === true ? (upstream.cli_bin_path ?? null) : null,
    // The CLI command name may differ from the bin file's basename; carry it
    // explicitly rather than guessing. Falls back to the basename only when the
    // bundle did not record a distinct name.
    cli_bin_name: upstream.has_cli === true
      ? (upstream.cli_bin_name ?? basenameNoExt(upstream.cli_bin_path))
      : null,
    main_entry: upstream.main_entry,
    template_id: templateId,
    could_not_verify: Array.isArray(bundle.could_not_verify) ? bundle.could_not_verify : [],
  };
}

/**
 * Build the authoritative `parameters` object for a drafted recipe result
 * directly from the trusted bundle. The model contributes only the bounded
 * `description`; every identity/source/build/CLI/entrypoint value comes from the
 * bundle. This is what the renderer materialises, so a model that changed an
 * authoritative value cannot influence the rendered files.
 *
 * @param {object} bundle       trusted fact bundle
 * @param {object} [opts]
 * @param {string} [opts.description] model-supplied bounded description
 */
export function buildParametersFromFacts(bundle, opts = {}) {
  const a = deriveAuthoritative(bundle);
  if (!a) throw new Error('cannot build parameters: not a fact bundle');

  const description = typeof opts.description === 'string' && opts.description.length > 0
    ? opts.description
    : `${a.package_name} ${a.package_version}`;

  const params = {
    package_name: { type: 'string', value: a.package_name },
    package_version: { type: 'string', value: a.package_version },
    description: { type: 'string', value: description },
    source_url: { type: 'string', value: a.source_url },
    source_ref: { type: 'string', value: a.source_ref },
    source_tag: { type: 'string', value: a.source_tag },
    upstream_npm_version: { type: 'string', value: a.upstream_npm_version },
    has_cli: { type: 'boolean', value: a.has_cli },
    main_entry: { type: 'string', value: a.main_entry },
  };

  // cli_bin_path / cli_bin_name are present iff the package has a CLI. Their
  // absence for a non-CLI package is authoritative and enforced by the validator.
  if (a.has_cli && a.cli_bin_path) {
    params.cli_bin_path = { type: 'string', value: a.cli_bin_path };
    if (a.cli_bin_name) {
      params.cli_bin_name = { type: 'string', value: a.cli_bin_name };
    }
  }

  return params;
}
