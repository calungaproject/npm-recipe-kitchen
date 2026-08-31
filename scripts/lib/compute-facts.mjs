// On-demand fact collector.
//
// Produces a versioned, trusted fact bundle for an EXACT npm identity by
// inspecting real evidence (registry metadata, the downloaded+integrity-checked
// tarball, and a pinned source checkout) rather than trusting registry metadata
// alone.
//
// Trust boundaries (see README):
//   - The npm ARTIFACT and the SOURCE repository are separate trust questions.
//   - Metadata is never treated as proof of tarball contents; the downloaded
//     bytes are integrity-checked and the tarball is inspected directly.
//   - `git ls-remote` tag resolution is `tag_only`, NOT proof the tarball was
//     built from that commit. This POC accepts a tag_only association and records
//     the gap as a could_not_verify caveat; only cryptographically verified
//     provenance yields an authoritative `verified_provenance` link.
//
// Failure model:
//   - Package / policy outcomes return { status: 'needs_human', reason_code }.
//     The pre-script turns these into facts_available:false so the agent emits a
//     bounded needs_human (never a run failure).
//   - Missing / malformed identity returns { status: 'input_error' } so the
//     agent is never asked to fabricate a schema-valid identity.
//   - Operational faults (timeout, DNS/TLS, 429, 5xx, truncation/oversize,
//     invalid JSON, unrelated child-process failure) THROW OperationalError so
//     the run fails as a retryable infrastructure error.
//
// All network / process access is behind injected adapters (options.adapters)
// so the default test suite runs against deterministic fixtures with no network.

import { createHash } from 'node:crypto';

import { FACT_BUNDLE_SCHEMA_VERSION } from './fact-bundle-constants.mjs';
import { TEMPLATE_ID as TIER_A_TEMPLATE_ID } from './templates/tier-a-npm-pack-no-build-v1.mjs';
import { isValidRegistryContractSha } from './registry-contract.mjs';

export const COLLECTOR_VERSION = 1;

// Exact npm identity only: `name@1.2.3` or `@scope/name@1.2.3`. No ranges,
// dist-tags, incomplete versions, git URLs, or registry URLs.
export const NAME_VERSION_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?([a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+([-+][-a-zA-Z0-9.+]+)?)$/;

// Explicitly supported HTTPS source hosts. Anything else is an ambiguous /
// unsupported outcome, not an assumption.
export const SUPPORTED_SOURCE_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
]);

// Stable reason codes. Tests and later automation key on these, never on prose.
export const REASON = {
  // input-error path
  INVALID_IDENTITY: 'INVALID_IDENTITY',
  // package / policy -> needs_human (facts_available:false)
  PACKAGE_NOT_FOUND: 'PACKAGE_NOT_FOUND',
  MISSING_DIST_INTEGRITY: 'MISSING_DIST_INTEGRITY',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
  UNSUPPORTED_REPO_HOST: 'UNSUPPORTED_REPO_HOST',
  AMBIGUOUS_TAG: 'AMBIGUOUS_TAG',
  UNVERIFIED_SOURCE_ASSOCIATION: 'UNVERIFIED_SOURCE_ASSOCIATION',
  COMPLEX_EXPORTS: 'COMPLEX_EXPORTS',
  UNSUPPORTED_CLI_LAYOUT: 'UNSUPPORTED_CLI_LAYOUT',
  MULTIPLE_CLI_BINS: 'MULTIPLE_CLI_BINS',
  NATIVE_OR_BUILD_INDICATORS: 'NATIVE_OR_BUILD_INDICATORS',
  MISSING_MAIN_ENTRY: 'MISSING_MAIN_ENTRY',
  PACK_NAME_VERSION_MISMATCH: 'PACK_NAME_VERSION_MISMATCH',
  REGISTRY_CONTRACT_UNAVAILABLE: 'REGISTRY_CONTRACT_UNAVAILABLE',
  // operational -> throw (retryable infra)
  TIMEOUT: 'TIMEOUT',
  DNS_FAILURE: 'DNS_FAILURE',
  TLS_FAILURE: 'TLS_FAILURE',
  HTTP_429: 'HTTP_429',
  HTTP_5XX: 'HTTP_5XX',
  TRUNCATED_RESPONSE: 'TRUNCATED_RESPONSE',
  OVERSIZED_RESPONSE: 'OVERSIZED_RESPONSE',
  INVALID_JSON: 'INVALID_JSON',
  CHILD_PROCESS_FAILURE: 'CHILD_PROCESS_FAILURE',
};

// Reason codes that represent retryable infrastructure faults. Adapters throw
// OperationalError with one of these; computeFacts lets them propagate.
export const OPERATIONAL_REASONS = new Set([
  REASON.TIMEOUT, REASON.DNS_FAILURE, REASON.TLS_FAILURE, REASON.HTTP_429,
  REASON.HTTP_5XX, REASON.TRUNCATED_RESPONSE, REASON.OVERSIZED_RESPONSE,
  REASON.INVALID_JSON, REASON.CHILD_PROCESS_FAILURE,
]);

const BUILD_LIFECYCLE = ['build', 'prepare', 'prepack', 'prepublishOnly'];
const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall'];

const DEFAULT_MAX_METADATA_BYTES = 5 * 1024 * 1024;   // 5 MiB
const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024;   // 64 MiB
const DEFAULT_TIMEOUT_MS = 30_000;

export class OperationalError extends Error {
  constructor(message, reasonCode) {
    super(message);
    this.name = 'OperationalError';
    this.reason_code = reasonCode;
    this.retryable = true;
  }
}

/**
 * Parse an exact npm identity. Never coerces a range/dist-tag into a version.
 * @returns {{ valid: true, name: string, version: string, unscoped: string }
 *          | { valid: false }}
 */
export function parseNpmIdentity(identity) {
  if (typeof identity !== 'string') return { valid: false };
  const m = NAME_VERSION_RE.exec(identity);
  if (!m) return { valid: false };
  const name = identity.slice(0, identity.lastIndexOf('@'));
  const version = m[3];
  const unscoped = name.startsWith('@') ? name.split('/')[1] : name;
  return { valid: true, name, version, unscoped };
}

/** Strip a leading `./` from an intra-package relative path. */
function normalizeRel(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/^\.\//, '');
}

/**
 * Normalise a package.json `repository` field to an https git URL on a supported
 * host. Returns null for unsupported / unparseable hosts.
 */
export function normalizeRepoUrl(repository) {
  let raw = repository;
  if (repository && typeof repository === 'object') raw = repository.url;
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let url = raw.trim();
  // Shorthand `github:owner/repo` / `owner/repo` are ambiguous about host in the
  // general case; only accept the explicit `github:` shorthand for github.
  const shorthand = /^github:([^/\s]+)\/([^/\s#]+)$/.exec(url);
  if (shorthand) {
    return { git_url: `https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/, '')}.git`, host: 'github.com' };
  }

  url = url.replace(/^git\+/, '');
  url = url.replace(/^git:\/\//, 'https://');
  url = url.replace(/^ssh:\/\/git@/, 'https://');
  url = url.replace(/^git@([^:]+):/, 'https://$1/');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname;
  if (!SUPPORTED_SOURCE_HOSTS.has(host)) return null;

  // Canonical: strip credentials, query, fragment; ensure single .git suffix.
  let path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  return { git_url: `https://${host}${path}.git`, host };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Pure classification helpers (independently testable).
// ---------------------------------------------------------------------------

/** Resolve the single unambiguous main entry, or flag complexity/ambiguity. */
export function resolveMainEntry(pkgJson) {
  const exp = pkgJson.exports;
  if (exp !== undefined) {
    if (typeof exp === 'string') return { status: 'ok', main_entry: normalizeRel(exp) };
    if (exp && typeof exp === 'object') {
      const keys = Object.keys(exp);
      const rootOnly = keys.length === 1 && keys[0] === '.';
      if (!rootOnly) return { status: 'complex_exports' };
      const root = exp['.'];
      if (typeof root === 'string') return { status: 'ok', main_entry: normalizeRel(root) };
      // Conditional export object ({ import, require, default, ... }) is a
      // multiple-incompatible-entrypoints case: do not guess.
      return { status: 'complex_exports' };
    }
    return { status: 'complex_exports' };
  }
  const main = pkgJson.main;
  if (typeof main === 'string' && main.length > 0) return { status: 'ok', main_entry: normalizeRel(main) };
  if (main === undefined) return { status: 'ok', main_entry: 'index.js' }; // node default
  return { status: 'ambiguous' };
}

/** Resolve CLI layout: none, a single bin (carrying both name and path), or unsupported. */
export function resolveCli(pkgJson, unscopedName) {
  const bin = pkgJson.bin;
  if (bin === undefined || bin === null) return { has_cli: false };
  if (typeof bin === 'string') {
    return { has_cli: true, cli_bin_name: unscopedName, cli_bin_path: normalizeRel(bin) };
  }
  if (typeof bin === 'object') {
    const keys = Object.keys(bin);
    if (keys.length === 0) return { has_cli: false };
    if (keys.length > 1) return { status: 'multiple_bins', names: keys };
    const name = keys[0];
    const path = bin[name];
    if (typeof path !== 'string') return { status: 'unsupported' };
    return { has_cli: true, cli_bin_name: name, cli_bin_path: normalizeRel(path) };
  }
  return { status: 'unsupported' };
}

function detectRuntime(pkgJson, mainEntry) {
  if (typeof mainEntry === 'string') {
    if (mainEntry.endsWith('.mjs')) return 'ESM';
    if (mainEntry.endsWith('.cjs')) return 'CommonJS';
  }
  return pkgJson.type === 'module' ? 'ESM' : 'CommonJS';
}

/**
 * Classify Tier A eligibility from INSPECTED evidence (both the source checkout
 * and the produced tarball). Returns either an eligible upstream summary or a
 * needs_human reason. Never eligible on the mere absence of registry fields.
 */
export function classifyTierA({ name, version, unscoped, sourcePackageJson, sourceFiles, packedPackageJson, packedFiles }) {
  const reasons = [];

  const scripts = sourcePackageJson.scripts || {};
  const buildScripts = BUILD_LIFECYCLE.filter(s => typeof scripts[s] === 'string' && scripts[s].length > 0);
  const installScripts = INSTALL_LIFECYCLE.filter(s => typeof scripts[s] === 'string' && scripts[s].length > 0);
  const hasLifecycle = buildScripts.length > 0 || installScripts.length > 0;

  // Native / build indicators from inspected source and packed files.
  const hasBindingGyp = sourceFiles.includes('binding.gyp');
  const hasNodeArtifact = packedFiles.some(f => f.endsWith('.node')) || sourceFiles.some(f => f.endsWith('.node'));
  const gypInScripts = Object.values(scripts).some(s => typeof s === 'string' && /node-gyp|prebuild|node-pre-gyp/.test(s));

  if (buildScripts.length > 0) {
    return { eligible: false, reason_code: REASON.NATIVE_OR_BUILD_INDICATORS, reason: `source has build lifecycle script(s): ${buildScripts.join(', ')}` };
  }
  if (installScripts.length > 0) {
    return { eligible: false, reason_code: REASON.NATIVE_OR_BUILD_INDICATORS, reason: `source has install lifecycle script(s): ${installScripts.join(', ')}` };
  }
  // binding.gyp is treated as a native build path unless explicitly and safely
  // disabled; we have no supported "safely disabled" signal, so it is not Tier A.
  if (hasBindingGyp) {
    return { eligible: false, reason_code: REASON.NATIVE_OR_BUILD_INDICATORS, reason: 'source contains binding.gyp (implicit native build path)' };
  }
  if (hasNodeArtifact || gypInScripts) {
    return { eligible: false, reason_code: REASON.NATIVE_OR_BUILD_INDICATORS, reason: 'native artifacts or gyp/prebuild indicators present' };
  }

  // Main entry — resolve against the PACKED package.json (what consumers get).
  const mainRes = resolveMainEntry(packedPackageJson);
  if (mainRes.status === 'complex_exports') {
    return { eligible: false, reason_code: REASON.COMPLEX_EXPORTS, reason: 'complex or conditional root exports; entrypoint is not unambiguous' };
  }
  if (mainRes.status === 'ambiguous') {
    return { eligible: false, reason_code: REASON.COMPLEX_EXPORTS, reason: 'main entry could not be resolved unambiguously' };
  }
  const mainEntry = mainRes.main_entry;
  if (!packedFiles.includes(mainEntry)) {
    return { eligible: false, reason_code: REASON.MISSING_MAIN_ENTRY, reason: `main entry "${mainEntry}" is not present in the packed tarball` };
  }

  // CLI — resolve against the PACKED package.json too.
  const cliRes = resolveCli(packedPackageJson, unscoped);
  if (cliRes.status === 'multiple_bins') {
    return { eligible: false, reason_code: REASON.MULTIPLE_CLI_BINS, reason: `multiple CLI bins: ${cliRes.names.join(', ')}` };
  }
  if (cliRes.status === 'unsupported') {
    return { eligible: false, reason_code: REASON.UNSUPPORTED_CLI_LAYOUT, reason: 'unsupported bin layout' };
  }
  if (cliRes.has_cli && !packedFiles.includes(cliRes.cli_bin_path)) {
    return { eligible: false, reason_code: REASON.MISSING_MAIN_ENTRY, reason: `CLI bin "${cliRes.cli_bin_path}" is not present in the packed tarball` };
  }

  // The produced tarball must have the expected name and version.
  if (packedPackageJson.name !== name || packedPackageJson.version !== version) {
    return {
      eligible: false,
      reason_code: REASON.PACK_NAME_VERSION_MISMATCH,
      reason: `packed ${packedPackageJson.name}@${packedPackageJson.version} != expected ${name}@${version}`,
    };
  }

  return {
    eligible: true,
    template_id: TIER_A_TEMPLATE_ID,
    native_tier: 'A',
    reasons,
    upstream: buildUpstreamSummary({
      version,
      sourcePackageJson,
      packedPackageJson,
      packedFiles,
      unscoped,
      hasLifecycle,
      hasNativeIndicators: false,
      mainEntry,
      cliRes,
    }),
  };
}

/**
 * Best-effort upstream snapshot from inspected source + packed tarball.
 * Used when Tier A template eligibility fails but facts are still useful.
 */
export function extractUpstreamSnapshot({
  version,
  sourcePackageJson,
  sourceFiles,
  packedPackageJson,
  packedFiles,
  unscoped,
}) {
  const scripts = sourcePackageJson.scripts || {};
  const buildScripts = BUILD_LIFECYCLE.filter(s => typeof scripts[s] === 'string' && scripts[s].length > 0);
  const installScripts = INSTALL_LIFECYCLE.filter(s => typeof scripts[s] === 'string' && scripts[s].length > 0);
  const hasLifecycle = buildScripts.length > 0 || installScripts.length > 0;
  const hasBindingGyp = sourceFiles.includes('binding.gyp');
  const hasNodeArtifact = packedFiles.some(f => f.endsWith('.node')) || sourceFiles.some(f => f.endsWith('.node'));
  const gypInScripts = Object.values(scripts).some(s => typeof s === 'string' && /node-gyp|prebuild|node-pre-gyp/.test(s));
  const hasNativeIndicators = hasBindingGyp || hasNodeArtifact || gypInScripts;

  const mainRes = resolveMainEntry(packedPackageJson);
  const mainEntry = mainRes.status === 'ok' ? mainRes.main_entry : null;
  const cliRes = resolveCli(packedPackageJson, unscoped);

  return buildUpstreamSummary({
    version,
    sourcePackageJson,
    packedPackageJson,
    packedFiles,
    unscoped,
    hasLifecycle,
    hasNativeIndicators,
    hasBuildStep: buildScripts.length > 0,
    mainEntry,
    mainEntryStatus: mainRes.status ?? 'ok',
    cliRes,
    optionalDependencies: packedPackageJson.optionalDependencies ?? {},
  });
}

function buildUpstreamSummary({
  version,
  packedPackageJson,
  hasLifecycle,
  hasNativeIndicators,
  hasBuildStep = false,
  mainEntry,
  mainEntryStatus = 'ok',
  cliRes,
  optionalDependencies = {},
}) {
  const hasCli = cliRes?.has_cli === true;
  return {
    has_build_step: hasBuildStep,
    has_lifecycle_scripts: hasLifecycle,
    has_native_indicators: hasNativeIndicators,
    has_platform_optional_deps: detectPlatformOptionalDeps(optionalDependencies),
    has_cli: hasCli,
    cli_bin_name: hasCli ? cliRes.cli_bin_name : null,
    cli_bin_path: hasCli ? cliRes.cli_bin_path : null,
    main_entry: mainEntry,
    main_entry_status: mainEntryStatus,
    runtime: mainEntry ? detectRuntime(packedPackageJson, mainEntry) : null,
    upstream_npm_version: version,
  };
}

function detectPlatformOptionalDeps(optionalDependencies) {
  return Object.keys(optionalDependencies).some(k => /linux-x64|darwin-|win32-|android-|freebsd-|openbsd-|sunos-|@esbuild\/|@img\/|@next\/swc-/i.test(k));
}

/**
 * Heuristic native tier hint for the recipe agent. Not authoritative — the model
 * must still justify tier choice in evidence.
 */
export function suggestNativeTier(upstream) {
  if (!upstream || typeof upstream !== 'object') return null;
  if (upstream.has_platform_optional_deps) return 'B';
  if (upstream.has_native_indicators) return 'C';
  return 'A';
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function requireAdapters(adapters, names) {
  for (const n of names) {
    if (typeof adapters?.[n] !== 'function') {
      throw new Error(`compute-facts: missing required adapter "${n}"`);
    }
  }
}

/**
 * Collect a trusted fact bundle for an exact npm identity.
 *
 * @param {string} identity  `name@1.2.3` or `@scope/name@1.2.3`
 * @param {object} options
 * @param {string}  options.registryContractSha  full 40-hex SHA (Gate A input)
 * @param {object}  options.adapters             injected IO adapters (see README)
 * @param {string}  [options.registryUrl]        configured registry (default npmjs)
 * @returns {Promise<{status:'ok', bundle} | {status:'needs_human', reason_code, reason} | {status:'input_error', reason_code, reason} | {status:'blocked', reason_code, reason}>}
 * @throws {OperationalError} for retryable infrastructure faults
 */
export async function computeFacts(identity, options = {}) {
  const {
    registryContractSha,
    adapters = {},
    registryUrl = 'https://registry.npmjs.org',
    limits = {},
  } = options;

  const parsed = parseNpmIdentity(identity);
  if (!parsed.valid) {
    return {
      status: 'input_error',
      reason_code: REASON.INVALID_IDENTITY,
      reason: `"${identity}" is not an exact npm identity (name@1.2.3 or @scope/name@1.2.3)`,
    };
  }

  const { name, version, unscoped } = parsed;

  // The collector path requires the pinned registry-contract SHA (Gate A input).
  // It is NOT derived from npm metadata; if unavailable we block rather than
  // invent one.
  if (!isValidRegistryContractSha(registryContractSha)) {
    return {
      status: 'blocked',
      reason_code: REASON.REGISTRY_CONTRACT_UNAVAILABLE,
      reason: 'registry contract SHA is unavailable or not a full commit SHA; cannot produce an auditable fact bundle',
    };
  }

  requireAdapters(adapters, ['getPackument', 'download', 'inspectTarball', 'checkProvenance', 'resolveSourceTag', 'packFromSource']);

  const maxMetadataBytes = limits.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
  const maxTarballBytes = limits.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const evidence = [];
  const couldNotVerify = [];

  // 1. Exact-version metadata. Adapter throws OperationalError for infra faults
  //    and returns null (or throws a tagged not-found) for a missing version.
  let manifest;
  try {
    manifest = await adapters.getPackument({ name, version, registryUrl, maxBytes: maxMetadataBytes, timeoutMs });
  } catch (err) {
    rethrowOperational(err);
    throw err;
  }
  if (!manifest) {
    return { status: 'needs_human', reason_code: REASON.PACKAGE_NOT_FOUND, reason: `${identity} not found on ${registryUrl}` };
  }

  // 2. Require and record dist.integrity.
  const dist = manifest.dist || {};
  if (typeof dist.integrity !== 'string' || dist.integrity.length === 0) {
    return { status: 'needs_human', reason_code: REASON.MISSING_DIST_INTEGRITY, reason: `${identity} has no dist.integrity in registry metadata` };
  }
  if (typeof dist.tarball !== 'string' || dist.tarball.length === 0) {
    return { status: 'needs_human', reason_code: REASON.MISSING_DIST_INTEGRITY, reason: `${identity} has no dist.tarball in registry metadata` };
  }

  // 3-4. Download the tarball under strict limits and verify bytes vs integrity.
  let tarballBuf;
  try {
    tarballBuf = await adapters.download({ url: dist.tarball, maxBytes: maxTarballBytes, timeoutMs });
  } catch (err) {
    rethrowOperational(err);
    throw err;
  }
  if (!Buffer.isBuffer(tarballBuf)) {
    throw new OperationalError('download adapter did not return a Buffer', REASON.TRUNCATED_RESPONSE);
  }
  const integrityOk = await adapters.verifyIntegrity
    ? await adapters.verifyIntegrity({ buffer: tarballBuf, integrity: dist.integrity })
    : verifyIntegrityDefault(tarballBuf, dist.integrity);
  if (!integrityOk) {
    return { status: 'needs_human', reason_code: REASON.INTEGRITY_MISMATCH, reason: `downloaded tarball bytes do not match dist.integrity for ${identity}` };
  }
  const tarballSha256 = sha256(tarballBuf);
  evidence.push({ kind: 'artifact-integrity', detail: `tarball verified against dist.integrity (${dist.integrity})` });

  // 5-6. Inspect the tarball's actual package/package.json and file list.
  let packed;
  try {
    packed = await adapters.inspectTarball({ buffer: tarballBuf });
  } catch (err) {
    rethrowOperational(err);
    throw err;
  }
  const packedPackageJson = packed.packageJson || {};
  const packedFiles = Array.isArray(packed.files) ? packed.files.map(normalizeRel) : [];

  // 7. Registry signature / provenance status — never asserted "verified" unless
  //    the adapter cryptographically verified it.
  let provStatus = { registry_signature_status: 'absent', provenance_status: 'absent' };
  try {
    const p = await adapters.checkProvenance({ name, version, registryUrl });
    if (p && typeof p === 'object') {
      provStatus = {
        registry_signature_status: normalizeStatus(p.registry_signature_status),
        provenance_status: normalizeStatus(p.provenance_status),
      };
    }
  } catch (err) {
    rethrowOperational(err);
    throw err;
  }
  if (provStatus.provenance_status !== 'verified') {
    couldNotVerify.push(provStatus.provenance_status === 'absent'
      ? 'No npm provenance attestation found for this package version'
      : 'npm provenance attestation present but not cryptographically verified');
  }

  // 8-9. Normalise and validate the source repository URL from the packed
  //     package.json (falling back to registry metadata).
  const repoField = packedPackageJson.repository ?? manifest.repository;
  const normalizedRepo = normalizeRepoUrl(repoField);
  if (!normalizedRepo) {
    return { status: 'needs_human', reason_code: REASON.UNSUPPORTED_REPO_HOST, reason: `source repository host is unsupported or unparseable: ${JSON.stringify(repoField)}` };
  }

  // 10. Resolve the version tag to an immutable commit. Adapter distinguishes
  //     unique / ambiguous / not-found and reports annotated vs lightweight.
  let tagRes;
  try {
    tagRes = await adapters.resolveSourceTag({ git_url: normalizedRepo.git_url, name, unscoped, version });
  } catch (err) {
    rethrowOperational(err);
    throw err;
  }
  if (!tagRes || tagRes.status === 'not_found') {
    return { status: 'needs_human', reason_code: REASON.UNVERIFIED_SOURCE_ASSOCIATION, reason: `no version tag found for ${identity} in ${normalizedRepo.git_url}` };
  }
  if (tagRes.status === 'ambiguous') {
    return { status: 'needs_human', reason_code: REASON.AMBIGUOUS_TAG, reason: `ambiguous version tags for ${identity}: ${(tagRes.candidates || []).join(', ')}` };
  }
  const commitSha = tagRes.commit_sha;
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(commitSha)) {
    return { status: 'needs_human', reason_code: REASON.UNVERIFIED_SOURCE_ASSOCIATION, reason: `resolved commit for ${identity} is not a full commit SHA` };
  }
  evidence.push({
    kind: 'tag-resolution',
    detail: `${tagRes.tag} (${tagRes.annotated ? 'annotated' : 'lightweight'}) resolves to commit ${commitSha}`,
  });

  // 11-12. Source-to-artifact association.
  //   git ls-remote proves the tag->commit mapping only (tag_only). It does NOT
  //   prove the npm tarball was built from that commit. This POC accepts a
  //   tag_only association and records the unverified build provenance as a
  //   could_not_verify caveat; only cryptographically verified provenance yields
  //   an authoritative `verified_provenance` link.
  let resolutionMethod;
  if (provStatus.provenance_status === 'verified') {
    resolutionMethod = 'verified_provenance';
  } else {
    resolutionMethod = 'tag_only';
    couldNotVerify.push('Source association is tag_only (tag->commit only); tarball build provenance not verified');
  }

  // 13. Pack from a clean pinned source checkout (scripts disabled).
  let sourcePack;
  try {
    sourcePack = await adapters.packFromSource({ git_url: normalizedRepo.git_url, commit_sha: commitSha });
  } catch (err) {
    rethrowOperational(err);
    throw err;
  }
  const sourcePackageJson = sourcePack.packageJson || {};
  const sourceFiles = Array.isArray(sourcePack.sourceFiles) ? sourcePack.sourceFiles.map(normalizeRel) : [];
  const sourcePackedFiles = Array.isArray(sourcePack.packedFiles) ? sourcePack.packedFiles.map(normalizeRel) : packedFiles;
  const sourcePackedJson = sourcePack.packedPackageJson || packedPackageJson;
  const sourceTarballSha256 = sourcePack.tarballSha256 ?? (Buffer.isBuffer(sourcePack.tarball) ? sha256(sourcePack.tarball) : undefined);

  // 14. Classify from inspected evidence (source checkout + produced tarball).
  const classification = classifyTierA({
    name, version, unscoped,
    sourcePackageJson,
    sourceFiles,
    packedPackageJson: sourcePackedJson,
    packedFiles: sourcePackedFiles,
  });

  const upstream = classification.eligible
    ? classification.upstream
    : extractUpstreamSnapshot({
      version,
      sourcePackageJson,
      sourceFiles,
      packedPackageJson: sourcePackedJson,
      packedFiles: sourcePackedFiles,
      unscoped,
    });

  const suggestedTier = classification.eligible
    ? classification.native_tier
    : suggestNativeTier(upstream);

  evidence.push({
    kind: 'pack-test',
    detail: classification.eligible
      ? `npm pack --ignore-scripts from ${commitSha} produced ${name}-${version}.tgz with the expected entrypoints`
      : `inspected source checkout at ${commitSha} and packed layout for ${name}@${version}`,
  });
  if (upstream.has_cli) {
    evidence.push({ kind: 'cli', detail: `CLI bin "${upstream.cli_bin_name}" -> ${upstream.cli_bin_path}` });
  }
  if (!classification.eligible) {
    evidence.push({
      kind: 'tier-a-ineligible',
      detail: `${classification.reason_code}: ${classification.reason}`,
    });
  }

  const bundle = {
    schema_version: FACT_BUNDLE_SCHEMA_VERSION,
    identity,
    package_name: name,
    package_version: version,
    collector: { version: COLLECTOR_VERSION },
    registry: {
      registry_url: registryUrl,
      tarball_url: dist.tarball,
      dist_integrity: dist.integrity,
      registry_signature_status: provStatus.registry_signature_status,
      provenance_status: provStatus.provenance_status,
    },
    source: {
      git_url: normalizedRepo.git_url,
      commit_sha: commitSha,
      tag: tagRes.tag,
      annotated_tag: tagRes.annotated === true,
      tag_matches_version: true,
      resolution_method: resolutionMethod,
    },
    upstream,
    classification: {
      tier_a_eligible: classification.eligible,
      native_tier: suggestedTier,
      ...(classification.eligible
        ? {
          template_id: classification.template_id,
          reasons: classification.reasons,
        }
        : {
          reason_code: classification.reason_code,
          reason: classification.reason,
          reasons: [],
        }),
    },
    native_tier: suggestedTier,
    registry_contract_sha: registryContractSha,
    could_not_verify: couldNotVerify,
    evidence,
    digests: {
      tarball_sha256: tarballSha256,
      ...(sourceTarballSha256 ? { source_tarball_sha256: sourceTarballSha256 } : {}),
    },
  };

  return { status: 'ok', bundle };
}

/**
 * Map a computeFacts outcome to the recipe-input.json payload the agent reads.
 * Only the `ok` outcome yields facts_available:true; every non-ok outcome is a
 * bounded facts_available:false input carrying its stable reason code. Operational
 * failures never reach here — they throw before an outcome is produced.
 */
export function toAgentInput(identity, outcome) {
  switch (outcome.status) {
    case 'ok':
      return { identity, facts_available: true, facts: outcome.bundle };
    case 'input_error':
      return { identity, facts_available: false, input_error: true, reason_code: outcome.reason_code, reason: outcome.reason };
    case 'blocked':
      return { identity, facts_available: false, blocked: true, reason_code: outcome.reason_code, reason: outcome.reason };
    case 'needs_human':
    default:
      return { identity, facts_available: false, reason_code: outcome.reason_code, reason: outcome.reason };
  }
}

function normalizeStatus(s) {
  return s === 'verified' || s === 'unverified' || s === 'absent' ? s : 'absent';
}

function rethrowOperational(err) {
  if (err instanceof OperationalError) throw err;
  if (err && OPERATIONAL_REASONS.has(err.reason_code)) {
    throw new OperationalError(err.message, err.reason_code);
  }
}

function verifyIntegrityDefault(buffer, integrity) {
  // Supports the ssri-style `sha512-<base64>` / `sha256-<base64>` form.
  const m = /^(sha256|sha384|sha512)-(.+)$/.exec(integrity);
  if (!m) return false;
  const algo = m[1];
  const expected = m[2];
  const actual = createHash(algo).update(buffer).digest('base64');
  return actual === expected;
}
