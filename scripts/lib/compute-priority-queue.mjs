import {
  DEFAULT_SHORTLIST_SIZE,
  DEFAULT_TOP_N,
  DEFAULT_WEIGHT_CLOSURE,
  DEFAULT_WEIGHT_POPULARITY,
} from './priority-queue-constants.mjs';
import {
  createDefaultPriorityAdapters,
  identityKey,
  parseIdentityKey,
} from './adapters/priority-adapters.mjs';

const SEMVER_EXACT_RE =
  /^\d+\.\d+\.\d+([-+][-a-zA-Z0-9.+]+)?$/;

function normalizeWeights(closureWeight, popularityWeight) {
  const c = Number(closureWeight);
  const p = Number(popularityWeight);
  if (!Number.isFinite(c) || !Number.isFinite(p) || c < 0 || p < 0 || c + p === 0) {
    throw new Error('closure and popularity weights must be non-negative numbers that sum > 0');
  }
  const sum = c + p;
  return { closure: c / sum, popularity: p / sum };
}

function percentileRank(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted.at(-1) ?? 0;
  const min = sorted[0] ?? 0;
  if (max === min) return values.map(() => (max > 0 ? 1 : 0));
  return values.map((v) => (v - min) / (max - min));
}

function gapReductionsFromParents(parents) {
  const reductions = {};
  for (const parent of parents) {
    reductions[parent] = (reductions[parent] ?? 0) + 1;
  }
  return reductions;
}

/**
 * Build a scored shortlist for Agent 1.
 *
 * @param {object} options
 * @param {import('./adapters/priority-adapters.mjs').createDefaultPriorityAdapters} [options.adapters]
 */
export async function computePriorityQueue(options = {}) {
  const adapters = options.adapters ?? createDefaultPriorityAdapters();
  const topN = Number(options.topN ?? DEFAULT_TOP_N);
  const shortlistSize = Number(options.shortlistSize ?? DEFAULT_SHORTLIST_SIZE);
  const weights = normalizeWeights(
    options.closureWeight ?? DEFAULT_WEIGHT_CLOSURE,
    options.popularityWeight ?? DEFAULT_WEIGHT_POPULARITY,
  );

  const index = await adapters.fetchClosureIndex();
  const tlNames = await adapters.fetchTlCatalogNames();

  /** @type {Map<string, object>} */
  const candidates = new Map();

  const addCandidate = (name, version, meta) => {
    if (!name || !version || !SEMVER_EXACT_RE.test(version)) return;
    const key = identityKey(name, version);
    const existing = candidates.get(key) ?? {
      candidate: key,
      name,
      version,
      closure_raw: 0,
      parents: [],
      sources: new Set(),
      immediate_l3_unlocks: [],
      gap_reductions: {},
      affected_packages: [],
      native_tier: 'unknown',
      demand: 0,
    };
    existing.closure_raw = Math.max(existing.closure_raw, meta.closureRaw ?? 0);
    if (meta.parents?.length) {
      const parentSet = new Set([...existing.parents, ...meta.parents]);
      existing.parents = [...parentSet];
      existing.affected_packages = [...parentSet];
      existing.gap_reductions = gapReductionsFromParents(existing.parents);
    }
    if (meta.source) existing.sources.add(meta.source);
    candidates.set(key, existing);
  };

  for (const [blockerKey, entry] of Object.entries(index.entries ?? {})) {
    const parsed = parseIdentityKey(blockerKey);
    if (!parsed) continue;
    const parents = Array.isArray(entry?.parents) ? entry.parents : [];
    let version = parsed.versionSpec;
    if (!SEMVER_EXACT_RE.test(version)) {
      try {
        version = await adapters.fetchLatestVersion(parsed.name);
      } catch {
        continue;
      }
    }
    addCandidate(parsed.name, version, {
      closureRaw: parents.length,
      parents,
      source: 'closure_blocker',
    });
  }

  for (const name of adapters.popularSeeds) {
    if (tlNames.has(name)) continue;
    try {
      const version = await adapters.fetchLatestVersion(name);
      addCandidate(name, version, { closureRaw: 0, parents: [], source: 'popular_seed' });
    } catch {
      // skip unreachable seed
    }
  }

  const filtered = [];
  for (const row of candidates.values()) {
    if (await adapters.isVersionOnTl(row.name, row.version)) continue;
    filtered.push(row);
  }

  const downloads = await adapters.fetchWeeklyDownloads(filtered.map((r) => r.name));
  for (const row of filtered) {
    row.demand = downloads[row.name] ?? 0;
  }

  const closureVals = filtered.map((r) => r.closure_raw);
  const demandVals = filtered.map((r) => r.demand);
  const closureNorm = percentileRank(closureVals);
  const demandNorm = percentileRank(demandVals);

  const scored = filtered.map((row, i) => {
    const closure_score = closureNorm[i];
    const popularity_score = demandNorm[i];
    const combined_score =
      weights.closure * closure_score + weights.popularity * popularity_score;
    return {
      candidate: row.candidate,
      name: row.name,
      version: row.version,
      closure_raw: row.closure_raw,
      closure_score,
      popularity_score,
      demand: row.demand,
      combined_score,
      immediate_l3_unlocks: row.parents.filter((p) => p.endsWith('@L3')),
      gap_reductions: row.gap_reductions,
      affected_packages: row.affected_packages,
      native_tier: row.native_tier,
      sources: [...row.sources],
      rationale: buildRationale(row, closure_score, popularity_score),
    };
  });

  scored.sort((a, b) => b.combined_score - a.combined_score || b.closure_raw - a.closure_raw);

  const shortlist = scored.slice(0, shortlistSize).map((row) => ({
    candidate: row.candidate,
    closure_raw: row.closure_raw,
    closure_score: round(row.closure_score),
    popularity_score: round(row.popularity_score),
    combined_score: round(row.combined_score),
    demand: row.demand,
    affected_packages: row.affected_packages,
    gap_reductions: row.gap_reductions,
    sources: row.sources,
    rationale: row.rationale,
  }));

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    weights: {
      closure: weights.closure,
      popularity: weights.popularity,
    },
    top_n: topN,
    closure_index_revision: index.revision ?? null,
    tl_catalog_size: tlNames.size,
    shortlist_size: shortlist.length,
    shortlist,
    agent_instructions:
      `Select the top ${topN} candidates from shortlist. Prefer higher combined_score ` +
      'but you may swap in a closure blocker with high affected_packages when it unlocks L3 ' +
      'for waiting TL packages. Output priority-result.json only.',
  };
}

function buildRationale(row, closureScore, popularityScore) {
  const parts = [];
  if (row.closure_raw > 0) {
    parts.push(
      `unblocks ${row.closure_raw} waiting package(s): ${row.affected_packages.slice(0, 3).join(', ')}`,
    );
  }
  if (row.demand > 0) {
    parts.push(`${row.demand.toLocaleString('en-US')} weekly npm downloads`);
  }
  parts.push(
    `scores closure=${closureScore.toFixed(2)} popularity=${popularityScore.toFixed(2)}`,
  );
  return parts.join('; ');
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
