// Deterministic fakes for the on-demand fact collector.
//
// These build the injected adapter set (compute-facts.mjs receives all IO by
// injection) so the default test suite exercises the real collector logic and
// the real post-validation path with NO network and NO child processes. Every
// adapter here is a pure in-memory stand-in; the real ones live in
// scripts/lib/adapters/npm-adapters.mjs and are only wired up by the opt-in
// live smoke test.

// A valid 40-char lowercase hex commit SHA to stand in for a resolved tag.
export const FAKE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

// A pinned registry-contract SHA (Gate A input). Distinct from FAKE_COMMIT so a
// test can tell the two apart.
export const FAKE_CONTRACT_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

/**
 * Build a full adapter set for a happy-path, eligible Tier A pure-JS package.
 * Pass `over` to replace individual adapters (or nested return values) for the
 * failure/edge cases.
 *
 * The default package is `foo@1.2.3`: pure JS, single root `main`, no CLI,
 * verified provenance (so it is eligible under the default policy).
 */
export function makeAdapters(over = {}) {
  const name = over.name ?? 'foo';
  const version = over.version ?? '1.2.3';
  const packedPackageJson = over.packedPackageJson ?? { name, version, main: 'index.js' };
  const packedFiles = over.packedFiles ?? ['package.json', 'index.js'];
  const sourcePackageJson = over.sourcePackageJson ?? { name, version, main: 'index.js' };
  const sourceFiles = over.sourceFiles ?? ['package.json', 'index.js'];
  const repository = over.repository ?? { url: 'git+https://github.com/acme/foo.git' };
  const provenanceStatus = over.provenanceStatus ?? 'verified';
  const signatureStatus = over.signatureStatus ?? 'unverified';

  const adapters = {
    getPackument: over.getPackument ?? (async () => ({
      name,
      version,
      dist: {
        integrity: 'sha512-Zm9v',
        tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      },
      repository,
    })),
    download: over.download ?? (async () => Buffer.from('fake-tarball-bytes')),
    // Skip real ssri math: the integrity gate itself is exercised by the
    // integrity-mismatch case, which overrides this to return false.
    verifyIntegrity: over.verifyIntegrity ?? (async () => true),
    inspectTarball: over.inspectTarball ?? (async () => ({
      packageJson: packedPackageJson,
      files: packedFiles,
    })),
    checkProvenance: over.checkProvenance ?? (async () => ({
      registry_signature_status: signatureStatus,
      provenance_status: provenanceStatus,
    })),
    resolveSourceTag: over.resolveSourceTag ?? (async () => ({
      status: 'unique',
      tag: `v${version}`,
      commit_sha: over.commit_sha ?? FAKE_COMMIT,
      annotated: over.annotated ?? true,
    })),
    packFromSource: over.packFromSource ?? (async () => ({
      packageJson: sourcePackageJson,
      sourceFiles,
      packedPackageJson,
      packedFiles,
      package_dir_rel: over.package_dir_rel ?? '.',
      rootPackageJson: over.rootPackageJson ?? sourcePackageJson,
    })),
  };
  return adapters;
}

/**
 * Standard options for computeFacts with the pinned contract SHA supplied.
 */
export function makeOptions(over = {}) {
  return {
    registryContractSha: over.registryContractSha ?? FAKE_CONTRACT_SHA,
    adapters: makeAdapters(over.adapters ?? {}),
    registryUrl: over.registryUrl ?? 'https://registry.npmjs.org',
  };
}
