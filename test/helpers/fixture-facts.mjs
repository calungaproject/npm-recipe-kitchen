// Static fact-bundle fixtures for tests that need a valid, fully-populated set of
// facts to feed the validator, the renderer, and the authoritative-field
// derivation — without standing up the network-backed collector.
//
// These are plain, deep-clonable objects shaped like a collector fact bundle
// (identity/source/upstream/provenance/could_not_verify/native_tier). Tests that
// exercise the collector path itself use test/helpers/collector-fakes.mjs
// instead; these are only for rendering/validation coverage.

export const SEMVER_FACTS = {
  package_name: 'semver',
  package_version: '7.7.2',
  identity: 'semver@7.7.2',
  source: {
    git_url: 'https://github.com/npm/node-semver.git',
    commit_sha: '281055e7716ef0415a8826972471331989ede58c',
    tag: 'v7.7.2',
    tag_matches_version: true,
    resolution_method: 'tag_only',
  },
  upstream: {
    has_build_step: false,
    build_evidence: 'No build, prepare, prepack, or prepublishOnly script in package.json',
    pack_command: 'npm pack --ignore-scripts',
    has_cli: true,
    cli_bin_name: 'semver',
    cli_bin_path: 'bin/semver.js',
    main_entry: 'index.js',
    runtime: 'CommonJS',
    dependencies_count: 0,
    lifecycle_scripts: false,
  },
  provenance: {
    slsa_attestation_present: true,
    attestation_verified: false,
  },
  could_not_verify: [
    'SLSA attestation signature chain not independently verified',
  ],
  native_tier: 'A',
  classification: {
    tier_a_eligible: true,
    native_tier: 'A',
    template_id: 'tier-a-npm-pack-no-build-v1',
    reasons: [],
  },
  registry_contract_sha: '017ebd5a3c5fef6d595f7c852fd584a7d5fae255',
};

export const CHALK_FACTS = {
  package_name: 'chalk',
  package_version: '5.3.0',
  identity: 'chalk@5.3.0',
  source: {
    git_url: 'https://github.com/chalk/chalk.git',
    commit_sha: '72c742d4716b1f94bb24bbda86d96fbb247ca646',
    tag: 'v5.3.0',
    tag_matches_version: true,
    resolution_method: 'tag_only',
  },
  upstream: {
    has_build_step: false,
    build_evidence: 'No build, prepare, prepack, or prepublishOnly script in package.json',
    pack_command: 'npm pack --ignore-scripts',
    has_cli: false,
    main_entry: 'source/index.js',
    runtime: 'ESM',
    dependencies_count: 0,
    lifecycle_scripts: false,
  },
  provenance: {
    slsa_attestation_present: false,
    attestation_verified: false,
  },
  could_not_verify: [
    'No SLSA provenance attestation found for this package version',
  ],
  native_tier: 'A',
  registry_contract_sha: '67c20a7ebef70e7f3970a01f90fa210cb6860385',
};

/** Deep clone so a test cannot mutate the shared fixture for another test. */
export function semverFacts() {
  return structuredClone(SEMVER_FACTS);
}

export function chalkFacts() {
  return structuredClone(CHALK_FACTS);
}
