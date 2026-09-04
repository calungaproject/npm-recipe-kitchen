// Default (real) IO adapters for the on-demand fact collector.
//
// This is the ONLY layer that touches the network or spawns child processes.
// compute-facts.mjs never imports it directly — it receives adapters by
// injection — so the default test suite runs entirely against fakes and never
// reaches this file. An opt-in live smoke test wires these in explicitly.
//
// Security posture:
//   - Never send runner credentials to source repositories. child processes get
//     a stripped environment (no npm/GitHub/cloud tokens) and are spawned with
//     argument arrays, never shell interpolation.
//   - Strict timeouts and size limits on every fetch; oversize/truncation and
//     transport faults surface as OperationalError (retryable infra), not as
//     package-eligibility outcomes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { OperationalError, REASON } from '../compute-facts.mjs';

// Environment variables stripped from every child process so no runner
// credential can leak to a source host or an npm lifecycle path.
// npm_config_* keys are policy knobs (ignore_scripts, audit, fund) — never strip them.
const SENSITIVE_ENV_RE = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY|GITHUB_|GH_|^NPM_|GCP_|GOOGLE_|AWS_|VERTEX)/i;

export function isSensitiveChildEnvKey(key) {
  if (key.startsWith('npm_config_')) return false;
  return SENSITIVE_ENV_RE.test(key);
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (isSensitiveChildEnvKey(k)) continue;
    env[k] = v;
  }
  // Belt-and-suspenders: disable npm lifecycle scripts and auth globally.
  env.npm_config_ignore_scripts = 'true';
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function isPublishablePackageJson(pkg) {
  return typeof pkg?.name === 'string' && pkg.name.length > 0
    && typeof pkg?.version === 'string' && pkg.version.length > 0
    && pkg.private !== true;
}

/**
 * Monorepos often tag the whole repo while the npm package lives under packages/*.
 * When the repo root is private or lacks name/version, locate the workspace member.
 */
export function resolvePackageDir(repoRoot, packageName) {
  const rootManifest = join(repoRoot, 'package.json');
  if (!existsSync(rootManifest)) return repoRoot;
  try {
    if (isPublishablePackageJson(readPackageJson(rootManifest))) return repoRoot;
  } catch {
    return repoRoot;
  }
  if (!packageName) return repoRoot;

  const packagesDir = join(repoRoot, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(packagesDir, entry.name);
      const manifestPath = join(candidate, 'package.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const pkg = readPackageJson(manifestPath);
        if (pkg.name === packageName) return candidate;
      } catch {
        // ignore malformed package.json
      }
    }
  }

  return findPackageDirByName(repoRoot, packageName, 0, 4) ?? repoRoot;
}

function findPackageDirByName(root, packageName, depth, maxDepth) {
  if (depth > maxDepth) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const dir = join(root, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const pkg = readPackageJson(manifestPath);
        if (pkg.name === packageName) return dir;
      } catch {
        // ignore malformed package.json
      }
    }
    const nested = findPackageDirByName(dir, packageName, depth + 1, maxDepth);
    if (nested) return nested;
  }
  return null;
}

async function fetchWithLimits(url, { maxBytes, timeoutMs, accept }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: accept ? { accept } : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new OperationalError(`timeout fetching ${url}`, REASON.TIMEOUT);
    const msg = String(err.message || err);
    if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(msg)) throw new OperationalError(msg, REASON.DNS_FAILURE);
    if (/TLS|certificate|SSL/i.test(msg)) throw new OperationalError(msg, REASON.TLS_FAILURE);
    throw new OperationalError(msg, REASON.DNS_FAILURE);
  }

  try {
    if (res.status === 404) return { notFound: true };
    if (res.status === 429) throw new OperationalError(`429 from ${url}`, REASON.HTTP_429);
    if (res.status >= 500) throw new OperationalError(`${res.status} from ${url}`, REASON.HTTP_5XX);
    if (!res.ok) throw new OperationalError(`${res.status} from ${url}`, REASON.HTTP_5XX);

    const declared = Number(res.headers.get('content-length') || '0');
    if (declared && declared > maxBytes) throw new OperationalError(`response exceeds ${maxBytes} bytes`, REASON.OVERSIZED_RESPONSE);

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new OperationalError(`response exceeds ${maxBytes} bytes`, REASON.OVERSIZED_RESPONSE);
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getPackument({ name, version, registryUrl, maxBytes, timeoutMs }) {
  const url = `${registryUrl}/${name.replace('/', '%2f')}/${version}`;
  const out = await fetchWithLimits(url, { maxBytes, timeoutMs, accept: 'application/json' });
  if (out.notFound) return null;
  let doc;
  try {
    doc = JSON.parse(out.buffer.toString('utf-8'));
  } catch (err) {
    throw new OperationalError(`invalid JSON from ${url}: ${err.message}`, REASON.INVALID_JSON);
  }
  return doc;
}

export async function download({ url, maxBytes, timeoutMs }) {
  const out = await fetchWithLimits(url, { maxBytes, timeoutMs });
  if (out.notFound) throw new OperationalError(`tarball 404 at ${url}`, REASON.HTTP_5XX);
  return out.buffer;
}

export async function inspectTarball({ buffer }) {
  const dir = mkdtempSync(join(tmpdir(), 'nrk-tarball-'));
  const tgz = join(dir, 'pkg.tgz');
  try {
    writeFileSync(tgz, buffer);
    const list = runOrThrow('tar', ['-tzf', tgz], { cwd: dir });
    const files = list.split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(f => f.startsWith('package/'))
      .map(f => f.slice('package/'.length))
      .filter(Boolean);
    const pkgRaw = runOrThrow('tar', ['-xzOf', tgz, 'package/package.json'], { cwd: dir });
    let packageJson;
    try {
      packageJson = JSON.parse(pkgRaw);
    } catch (err) {
      throw new OperationalError(`packed package.json is not valid JSON: ${err.message}`, REASON.INVALID_JSON);
    }
    return { packageJson, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function checkProvenance() {
  // Conservative default: we do not run a cryptographic provenance verification
  // here, so we never claim "verified". Callers that require a verified source
  // association will fall through to needs_human under the default policy.
  return { registry_signature_status: 'unverified', provenance_status: 'unverified' };
}

export async function resolveSourceTag({ git_url, unscoped, version }) {
  const out = runOrThrow('git', ['ls-remote', '--tags', git_url], { env: cleanEnv() });
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);

  // Map of tag name -> { commit, peeled }. Annotated tags appear twice: once for
  // the tag object and once as `<tag>^{}` for the peeled commit.
  const tags = new Map();
  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/);
    if (!ref?.startsWith('refs/tags/')) continue;
    let name = ref.slice('refs/tags/'.length);
    const peeled = name.endsWith('^{}');
    if (peeled) name = name.slice(0, -3);
    const entry = tags.get(name) || {};
    if (peeled) entry.peeled = sha; else entry.commit = sha;
    tags.set(name, entry);
  }

  const candidateNames = [`v${version}`, version];
  const matches = candidateNames.filter(n => tags.has(n));

  // Monorepo ambiguity: tags of the form `<other>@<version>` for this version.
  const monorepoMatches = [...tags.keys()].filter(n => n.endsWith(`@${version}`));
  if (matches.length === 0 && monorepoMatches.length > 0) {
    return { status: 'ambiguous', candidates: monorepoMatches };
  }
  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };

  const name = matches[0];
  const entry = tags.get(name);
  const annotated = Boolean(entry.peeled);
  const commit_sha = entry.peeled || entry.commit;
  return { status: 'unique', tag: name, commit_sha, annotated };
}

export async function packFromSource({ git_url, commit_sha, package_name }) {
  const dir = mkdtempSync(join(tmpdir(), 'nrk-src-'));
  const src = join(dir, 'src');
  const env = cleanEnv();
  try {
    runOrThrow('git', ['clone', '--no-checkout', '--quiet', git_url, src], { env });
    runOrThrow('git', ['-C', src, 'checkout', '--quiet', commit_sha], { env });

    const packageDir = resolvePackageDir(src, package_name);
    const rootManifestPath = join(src, 'package.json');
    const rootPackageJson = existsSync(rootManifestPath) ? readPackageJson(rootManifestPath) : {};
    const packageDirRel = relative(src, packageDir).replace(/\\/g, '/') || '.';
    const sourceFiles = listFilesRecursive(packageDir).filter(f => !f.startsWith('.git/'));
    const sourcePkg = readPackageJson(join(packageDir, 'package.json'));

    let packed;
    try {
      // Global --ignore-scripts works across npm versions; subcommand placement can be ignored on older CLIs.
      packed = runOrThrow('npm', ['--ignore-scripts', 'pack', '--quiet'], { cwd: packageDir, env });
    } catch (err) {
      if (err instanceof OperationalError && err.reason_code === REASON.CHILD_PROCESS_FAILURE) {
        return {
          packageJson: sourcePkg,
          sourceFiles,
          packSkipped: true,
          package_dir_rel: packageDirRel,
          rootPackageJson,
        };
      }
      throw err;
    }
    const tgzName = packed.split('\n').map(s => s.trim()).filter(Boolean).pop();
    const tgzPath = join(packageDir, tgzName);
    const tarballBuf = readFileSync(tgzPath);
    const inspected = await inspectTarball({ buffer: tarballBuf });

    return {
      packageJson: sourcePkg,
      sourceFiles,
      packedPackageJson: inspected.packageJson,
      packedFiles: inspected.files,
      tarball: tarballBuf,
      tarballSha256: createHash('sha256').update(tarballBuf).digest('hex'),
      package_dir_rel: packageDirRel,
      rootPackageJson,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listFilesRecursive(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(root, rel));
    else out.push(rel);
  }
  return out;
}

function runOrThrow(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
    ...opts,
  });
  if (res.error) {
    throw new OperationalError(`${cmd} failed to spawn: ${res.error.message}`, REASON.CHILD_PROCESS_FAILURE);
  }
  if (res.status !== 0) {
    throw new OperationalError(`${cmd} exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`, REASON.CHILD_PROCESS_FAILURE);
  }
  return res.stdout;
}

export const defaultAdapters = {
  getPackument,
  download,
  inspectTarball,
  checkProvenance,
  resolveSourceTag,
  packFromSource,
};
