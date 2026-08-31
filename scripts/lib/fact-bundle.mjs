// Fact-bundle helpers: trusted observations and manifest binding for validation.

import { FACT_BUNDLE_SCHEMA_VERSION } from './fact-bundle-constants.mjs';

export { FACT_BUNDLE_SCHEMA_VERSION };

/**
 * Collapse a fact bundle into manifest fields the post-step binds.
 */
export function deriveManifestBinding(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const source = bundle.source || {};
  const refs = [];
  if (typeof source.commit_sha === 'string' && source.commit_sha.length > 0) refs.push(source.commit_sha);
  if (typeof source.tag === 'string' && source.tag.length > 0) refs.push(source.tag);

  return {
    identity: bundle.identity,
    package_name: bundle.package_name,
    package_version: bundle.package_version,
    source_url: source.git_url,
    source_ref_options: refs,
    could_not_verify: Array.isArray(bundle.could_not_verify) ? bundle.could_not_verify : [],
    suggested_native_tier: bundle.classification?.native_tier ?? bundle.native_tier ?? null,
  };
}

/**
 * @deprecated Legacy template renderer binding. Prefer deriveManifestBinding.
 */
export function deriveAuthoritative(bundle) {
  const binding = deriveManifestBinding(bundle);
  if (!binding) return null;
  const upstream = bundle.upstream || {};
  return {
    ...binding,
    source_ref: bundle.source?.commit_sha,
    source_tag: bundle.source?.tag,
    upstream_npm_version: upstream.upstream_npm_version ?? bundle.package_version,
    has_cli: upstream.has_cli === true,
    cli_bin_path: upstream.has_cli === true ? (upstream.cli_bin_path ?? null) : null,
    cli_bin_name: upstream.has_cli === true ? (upstream.cli_bin_name ?? null) : null,
    main_entry: upstream.main_entry,
    template_id: bundle.classification?.template_id ?? null,
  };
}

export const MODEL_SUPPLIED_PARAMS = new Set(['description']);

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
  if (a.has_cli && a.cli_bin_path) {
    params.cli_bin_path = { type: 'string', value: a.cli_bin_path };
    if (a.cli_bin_name) {
      params.cli_bin_name = { type: 'string', value: a.cli_bin_name };
    }
  }
  return params;
}
