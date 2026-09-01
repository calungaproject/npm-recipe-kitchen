import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePriorityQueue } from '../scripts/lib/compute-priority-queue.mjs';
import { createDefaultPriorityAdapters, parseIdentityKey } from '../scripts/lib/adapters/priority-adapters.mjs';

describe('parseIdentityKey', () => {
  it('parses scoped and unscoped identities', () => {
    assert.deepEqual(parseIdentityKey('semver@7.7.2'), {
      name: 'semver',
      versionSpec: '7.7.2',
    });
    assert.deepEqual(parseIdentityKey('depd@^2.0.0'), {
      name: 'depd',
      versionSpec: '^2.0.0',
    });
  });
});

describe('computePriorityQueue', () => {
  it('ranks closure blockers above pure popularity seeds', async () => {
    const adapters = createDefaultPriorityAdapters({
      closureIndex: {
        schema_version: 1,
        revision: 3,
        entries: {
          'depd@2.0.0': { parents: ['send@0.19.0', 'finalhandler@1.3.1'] },
        },
      },
      tlCatalogNames: ['semver', 'lodash', 'express'],
      isVersionOnTl: async (name, version) => {
        if (name === 'semver' && version === '7.7.2') return true;
        return false;
      },
      latestVersions: {
        depd: '2.0.0',
        chalk: '5.3.0',
      },
      weeklyDownloads: {
        depd: 50_000,
        chalk: 5_000_000,
      },
      popularSeeds: ['chalk'],
    });

    const result = await computePriorityQueue({
      adapters,
      topN: 2,
      closureWeight: 0.6,
      popularityWeight: 0.4,
    });

    assert.ok(result.shortlist.length >= 2);
    assert.equal(result.shortlist[0].candidate, 'depd@2.0.0');
    assert.ok(result.shortlist[0].closure_raw >= 2);
    assert.ok(result.shortlist[0].combined_score >= result.shortlist[1].combined_score);
  });

  it('excludes packages already on TL at the resolved version', async () => {
    const adapters = createDefaultPriorityAdapters({
      closureIndex: { schema_version: 1, revision: 1, entries: {} },
      tlCatalogNames: ['semver'],
      isVersionOnTl: async (name, version) => name === 'semver' && version === '7.7.2',
      latestVersions: { semver: '7.7.2' },
      weeklyDownloads: { semver: 1_000_000 },
      popularSeeds: ['semver'],
    });

    const result = await computePriorityQueue({ adapters, topN: 5 });
    assert.ok(!result.shortlist.some((row) => row.candidate === 'semver@7.7.2'));
  });
});
