import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeFacts } from '../scripts/lib/compute-facts.mjs';
import { defaultAdapters } from '../scripts/lib/adapters/npm-adapters.mjs';

// Opt-in live smoke test. SKIPPED by default so `npm test` stays hermetic
// (no network, no child processes). Enable with:
//
//   NRK_LIVE_SMOKE=1 NRK_LIVE_IDENTITY=semver@7.7.2 \
//   NRK_REGISTRY_CONTRACT_SHA=<40-hex> node --test test/live-smoke.test.js
//
// Because the default checkProvenance adapter is conservative (never "verified"),
// a live run reaches a tag_only association and, under default policy, returns
// needs_human(UNVERIFIED_SOURCE_ASSOCIATION) — which is the correct, safe
// outcome. Pass NRK_LIVE_ALLOW_TAG_ONLY=1 to exercise the full eligible path.

const LIVE = process.env.NRK_LIVE_SMOKE === '1';

describe('live smoke (opt-in)', { skip: LIVE ? false : 'set NRK_LIVE_SMOKE=1 to enable' }, () => {
  it('collects real facts for a public package', async () => {
    const identity = process.env.NRK_LIVE_IDENTITY || 'semver@7.7.2';
    const registryContractSha = process.env.NRK_REGISTRY_CONTRACT_SHA || '0'.repeat(40);
    const allowTagOnly = process.env.NRK_LIVE_ALLOW_TAG_ONLY === '1';

    const out = await computeFacts(identity, {
      registryContractSha,
      adapters: defaultAdapters,
      policy: { allowTagOnly },
    });

    // Whatever the outcome, it must be a bounded, well-formed result — never a
    // thrown non-operational error.
    assert.ok(['ok', 'needs_human', 'blocked', 'input_error'].includes(out.status), JSON.stringify(out));
    if (out.status === 'ok') {
      assert.match(out.bundle.source.commit_sha, /^[0-9a-f]{40}$/);
      assert.equal(out.bundle.package_version, identity.split('@').pop());
    }
  });
});
