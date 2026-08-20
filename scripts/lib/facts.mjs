const KNOWN_FACTS = new Map([
  ['chalk@5.3.0', {
    package_name: 'chalk',
    package_version: '5.3.0',
    identity: 'chalk@5.3.0',
    source: {
      git_url: 'https://github.com/chalk/chalk.git',
      commit_sha: '72c742d4716b1f94bb24bbda86d96fbb247ca646',
      tag: 'v5.3.0',
      tag_matches_version: true,
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
  }],
  ['semver@7.7.2', {
    package_name: 'semver',
    package_version: '7.7.2',
    identity: 'semver@7.7.2',
    source: {
      git_url: 'https://github.com/npm/node-semver.git',
      commit_sha: '281055e7716ef0415a8826972471331989ede58c',
      tag: 'v7.7.2',
      tag_matches_version: true,
    },
    upstream: {
      has_build_step: false,
      build_evidence: 'No build, prepare, prepack, or prepublishOnly script in package.json',
      pack_command: 'npm pack --ignore-scripts',
      has_cli: true,
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
    registry_contract_sha: '017ebd5a3c5fef6d595f7c852fd584a7d5fae255',
  }],
]);

const NAME_VERSION_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+([-+][-a-zA-Z0-9.+]+)?$/;

export function getFacts(identity) {
  if (typeof identity !== 'string' || !NAME_VERSION_RE.test(identity)) {
    throw new Error(`Invalid package identity: ${identity}`);
  }
  const facts = KNOWN_FACTS.get(identity);
  if (!facts) {
    throw new Error(`No pre-computed facts for ${identity}. Only deterministic, pre-verified facts are supported.`);
  }
  return structuredClone(facts);
}

export function validateFacts(facts) {
  const errors = [];
  if (!facts || typeof facts !== 'object') {
    return { valid: false, errors: [{ path: '/', message: 'facts must be an object' }] };
  }
  if (!facts.identity || !NAME_VERSION_RE.test(facts.identity)) {
    errors.push({ path: '/identity', message: 'missing or invalid identity' });
  }
  if (!facts.source?.commit_sha || !/^[0-9a-f]{40}$/.test(facts.source.commit_sha)) {
    errors.push({ path: '/source/commit_sha', message: 'must be a 40-character lowercase hex SHA' });
  }
  if (!facts.source?.git_url) {
    errors.push({ path: '/source/git_url', message: 'missing git URL' });
  }
  if (typeof facts.native_tier !== 'string' || !['A', 'B', 'C'].includes(facts.native_tier)) {
    errors.push({ path: '/native_tier', message: 'must be A, B, or C' });
  }
  if (!Array.isArray(facts.could_not_verify)) {
    errors.push({ path: '/could_not_verify', message: 'must be an array' });
  }
  return { valid: errors.length === 0, errors };
}

export { KNOWN_FACTS };
