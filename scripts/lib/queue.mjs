import { createCatalog } from './catalog.mjs';
import { deriveCompliance } from './compliance.mjs';

export function scoreQueue({ consumers, catalogJson, demand, tiers }) {
  const catalog = createCatalog(catalogJson);

  const baselines = consumers.map(c => {
    const { report, level } = deriveCompliance({
      consumer: c.consumer,
      directProduction: c.directProduction,
      productionClosure: c.productionClosure,
      catalog,
    });
    return { ...c, report, level };
  });

  const candidateSet = new Set();
  for (const b of baselines) {
    for (const gap of b.report.closure_gaps) {
      candidateSet.add(gap);
    }
  }

  const demandPackages = (demand && demand.packages) || {};
  const tierMap = tiers || {};
  const entries = [];
  const evidence = new Map();

  for (const candidate of candidateSet) {
    const simCatalogJson = {
      ...catalogJson,
      entries: {
        ...catalogJson.entries,
        [candidate]: { available: true, source: 'simulated' },
      },
    };
    const simCatalog = createCatalog(simCatalogJson);

    const immediateL3Unlocks = [];
    const gapReductions = {};
    const affectedPackages = [];
    const details = [];

    for (const baseline of baselines) {
      if (!baseline.report.closure_gaps.includes(candidate)) continue;

      const { report: simReport, level: simLevel } = deriveCompliance({
        consumer: baseline.consumer,
        directProduction: baseline.directProduction,
        productionClosure: baseline.productionClosure,
        catalog: simCatalog,
      });

      const beforeGapCount = baseline.report.closure_gaps.length;
      const afterGapCount = simReport.closure_gaps.length;
      const reduction = beforeGapCount - afterGapCount;

      affectedPackages.push(baseline.consumer);

      if (simLevel === 'L3') {
        immediateL3Unlocks.push(baseline.consumer);
      }

      if (reduction > 0) {
        gapReductions[baseline.consumer] = reduction;
      }

      details.push({
        consumer: baseline.consumer,
        before: {
          level: baseline.level,
          gap_count: beforeGapCount,
          closure_gaps: [...baseline.report.closure_gaps],
        },
        after: {
          level: simLevel,
          gap_count: afterGapCount,
          closure_gaps: [...simReport.closure_gaps],
        },
      });
    }

    const nativeTier = tierMap[candidate] || 'Z';
    const demandCount = demandPackages[candidate] || 0;

    entries.push({
      candidate,
      immediate_l3_unlocks: immediateL3Unlocks.sort(),
      gap_reductions: sortObjectKeys(gapReductions),
      affected_packages: affectedPackages.sort(),
      native_tier: nativeTier,
      demand: demandCount,
    });

    evidence.set(candidate, details);
  }

  entries.sort((a, b) => {
    const unlockDiff = b.immediate_l3_unlocks.length - a.immediate_l3_unlocks.length;
    if (unlockDiff !== 0) return unlockDiff;

    const gapRedDiff = Object.keys(b.gap_reductions).length - Object.keys(a.gap_reductions).length;
    if (gapRedDiff !== 0) return gapRedDiff;

    if (a.native_tier < b.native_tier) return -1;
    if (a.native_tier > b.native_tier) return 1;

    const demandDiff = b.demand - a.demand;
    if (demandDiff !== 0) return demandDiff;

    if (a.candidate < b.candidate) return -1;
    if (a.candidate > b.candidate) return 1;

    return 0;
  });

  return {
    queue: { schema_version: 1, entries },
    evidence,
  };
}

export function renderWhy(entry, details) {
  const parts = [];

  if (entry.immediate_l3_unlocks.length > 0) {
    parts.push(`Unlocks L3 for ${entry.immediate_l3_unlocks.join(', ')}`);
  }

  const nonL3 = details.filter(d =>
    d.after.level !== 'L3' && d.before.gap_count > d.after.gap_count,
  );
  if (nonL3.length > 0) {
    const items = nonL3.map(d =>
      `${d.consumer} (${d.before.gap_count} → ${d.after.gap_count})`,
    );
    parts.push(`Reduces gaps for ${items.join(', ')}`);
  }

  return parts.join('. ') + (parts.length > 0 ? '.' : '');
}

function sortObjectKeys(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}
