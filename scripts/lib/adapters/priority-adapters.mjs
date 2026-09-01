import {
  DEFAULT_CLOSURE_INDEX_IMAGE,
  DEFAULT_NPM_REGISTRY_URL,
  DEFAULT_TL_REGISTRY_URL,
  POPULAR_PACKAGE_SEEDS,
} from '../priority-queue-constants.mjs';

const IDENTITY_RE =
  /^((@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/;

export function parseIdentityKey(key) {
  const match = String(key).match(IDENTITY_RE);
  if (!match) return null;
  return { name: match[1], versionSpec: match[3] };
}

export function identityKey(name, version) {
  return `${name}@${version}`;
}

export function encodePackageName(name) {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

export function createDefaultPriorityAdapters(overrides = {}) {
  const tlRegistryUrl = overrides.tlRegistryUrl ?? DEFAULT_TL_REGISTRY_URL;
  const npmRegistryUrl = overrides.npmRegistryUrl ?? DEFAULT_NPM_REGISTRY_URL;
  const closureIndexImage = overrides.closureIndexImage ?? DEFAULT_CLOSURE_INDEX_IMAGE;
  const fetchFn = overrides.fetch ?? globalThis.fetch;
  const execFile = overrides.execFile ?? null;

  return {
    async fetchClosureIndex() {
      if (overrides.closureIndex) return overrides.closureIndex;
      if (execFile) {
        return pullClosureIndexWithOras(execFile, closureIndexImage);
      }
      throw new Error(
        'fetchClosureIndex requires execFile (oras) or injected closureIndex in tests',
      );
    },

    async fetchTlCatalogNames() {
      if (overrides.tlCatalogNames) return new Set(overrides.tlCatalogNames);
      const res = await fetchFn(`${tlRegistryUrl}/`, {
        headers: { Accept: 'text/html' },
      });
      if (!res.ok) {
        throw new Error(`TL catalog listing failed: HTTP ${res.status}`);
      }
      const html = await res.text();
      const names = new Set();
      for (const match of html.matchAll(/<a href="([^"]+)\/">/g)) {
        let href = match[1];
        if (!href || href === '..' || href === '../') continue;
        href = href.replace(/^\.\//, '').replace(/\/$/, '');
        if (!href || href === '..') continue;
        if (href.startsWith('@calunga/')) continue;
        // Unscoped package directory (semver, lodash, …)
        if (!href.startsWith('@') && !href.includes('/')) {
          names.add(href);
        }
        // Scoped root only (@scope/) — skip; individual scoped packages use @scope/pkg paths
      }
      return names;
    },

    async isVersionOnTl(name, version) {
      if (typeof overrides.isVersionOnTl === 'function') {
        return overrides.isVersionOnTl(name, version);
      }
      if (overrides.tlVersions?.[name]?.includes(version)) return true;
      const encoded = encodePackageName(name);
      const res = await fetchFn(`${tlRegistryUrl}/${encoded}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new Error(`TL packument fetch failed for ${name}: HTTP ${res.status}`);
      }
      const packument = await res.json();
      return Boolean(packument?.versions?.[version]);
    },

    async fetchLatestVersion(name) {
      if (overrides.latestVersions?.[name]) return overrides.latestVersions[name];
      const encoded = encodePackageName(name);
      const res = await fetchFn(`${npmRegistryUrl}/${encoded}/latest`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`npm latest fetch failed for ${name}: HTTP ${res.status}`);
      }
      const doc = await res.json();
      const version = doc?.version;
      if (!version) throw new Error(`npm latest missing version for ${name}`);
      return version;
    },

    async fetchWeeklyDownloads(names) {
      if (overrides.weeklyDownloads) return overrides.weeklyDownloads;
      if (!names.length) return {};
      const chunkSize = 20;
      const out = {};
      for (let i = 0; i < names.length; i += chunkSize) {
        const chunk = names.slice(i, i + chunkSize);
        const url = `https://api.npmjs.org/downloads/point/last-week/${chunk.join(',')}`;
        const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          throw new Error(`npm downloads API failed: HTTP ${res.status}`);
        }
        const body = await res.json();
        for (const [name, row] of Object.entries(body)) {
          out[name] = Number(row?.downloads ?? 0);
        }
      }
      return out;
    },

    popularSeeds: overrides.popularSeeds ?? POPULAR_PACKAGE_SEEDS,
  };
}

async function pullClosureIndexWithOras(execFileImpl, imageRef) {
  const { execFile: nodeExecFile } = await import('node:child_process');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { promisify } = await import('node:util');
  // Caller may inject an already-promisified execFile; do not promisify twice.
  const run = execFileImpl ?? promisify(nodeExecFile);

  const dir = await mkdtemp(join(tmpdir(), 'npm-closure-index-'));
  try {
    await run('oras', ['pull', imageRef, '-o', dir], { env: process.env });
    const raw = await readFile(join(dir, 'npm-closure-index.json'), 'utf-8');
    return JSON.parse(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
