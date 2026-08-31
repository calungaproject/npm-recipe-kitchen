import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFacts,
  parseNpmIdentity,
  normalizeRepoUrl,
  resolveMainEntry,
  resolveCli,
  classifyTierA,
  toAgentInput,
  OperationalError,
  REASON,
  COLLECTOR_VERSION,
} from '../scripts/lib/compute-facts.mjs';
import { TEMPLATE_ID as TIER_A_TEMPLATE_ID } from '../scripts/lib/templates/tier-a-npm-pack-no-build-v1.mjs';
import { makeOptions, makeAdapters, FAKE_COMMIT, FAKE_CONTRACT_SHA } from './helpers/collector-fakes.mjs';

describe('parseNpmIdentity', () => {
  it('accepts exact name@1.2.3', () => {
    assert.deepEqual(parseNpmIdentity('foo@1.2.3'), { valid: true, name: 'foo', version: '1.2.3', unscoped: 'foo' });
  });

  it('accepts scoped @scope/name@1.2.3', () => {
    assert.deepEqual(parseNpmIdentity('@acme/foo@1.2.3'), { valid: true, name: '@acme/foo', version: '1.2.3', unscoped: 'foo' });
  });

  it('accepts a prerelease version', () => {
    assert.equal(parseNpmIdentity('foo@1.2.3-beta.1').valid, true);
  });

  it('rejects a semver range', () => {
    assert.equal(parseNpmIdentity('foo@^1.2.3').valid, false);
  });

  it('rejects a dist-tag', () => {
    assert.equal(parseNpmIdentity('foo@latest').valid, false);
  });

  it('rejects an incomplete version', () => {
    assert.equal(parseNpmIdentity('foo@1.2').valid, false);
  });

  it('rejects a git+registry URL', () => {
    assert.equal(parseNpmIdentity('git+https://github.com/a/b.git').valid, false);
  });

  it('rejects a bare name', () => {
    assert.equal(parseNpmIdentity('foo').valid, false);
  });
});

describe('normalizeRepoUrl', () => {
  it('normalises git+https github url', () => {
    assert.deepEqual(normalizeRepoUrl('git+https://github.com/acme/foo.git'), { git_url: 'https://github.com/acme/foo.git', host: 'github.com' });
  });

  it('normalises ssh git@ url', () => {
    assert.deepEqual(normalizeRepoUrl('git@github.com:acme/foo.git'), { git_url: 'https://github.com/acme/foo.git', host: 'github.com' });
  });

  it('accepts the github: shorthand', () => {
    assert.deepEqual(normalizeRepoUrl('github:acme/foo'), { git_url: 'https://github.com/acme/foo.git', host: 'github.com' });
  });

  it('rejects an unsupported host', () => {
    assert.equal(normalizeRepoUrl('https://evil.example.com/a/b.git'), null);
  });

  it('rejects a non-https protocol', () => {
    assert.equal(normalizeRepoUrl('http://github.com/a/b.git'), null);
  });

  it('rejects an ambiguous owner/repo shorthand (no host)', () => {
    assert.equal(normalizeRepoUrl('acme/foo'), null);
  });
});

describe('resolveMainEntry', () => {
  it('defaults to index.js when neither main nor exports present', () => {
    assert.deepEqual(resolveMainEntry({}), { status: 'ok', main_entry: 'index.js' });
  });

  it('uses main and strips ./', () => {
    assert.deepEqual(resolveMainEntry({ main: './lib/index.js' }), { status: 'ok', main_entry: 'lib/index.js' });
  });

  it('accepts a string exports', () => {
    assert.deepEqual(resolveMainEntry({ exports: './index.js' }), { status: 'ok', main_entry: 'index.js' });
  });

  it('accepts a root-only string subpath export', () => {
    assert.deepEqual(resolveMainEntry({ exports: { '.': './index.js' } }), { status: 'ok', main_entry: 'index.js' });
  });

  it('flags a conditional root export object as complex', () => {
    assert.equal(resolveMainEntry({ exports: { '.': { import: './i.mjs', require: './i.cjs' } } }).status, 'complex_exports');
  });

  it('flags multiple subpath exports as complex', () => {
    assert.equal(resolveMainEntry({ exports: { '.': './i.js', './sub': './sub.js' } }).status, 'complex_exports');
  });
});

describe('resolveCli', () => {
  it('reports no cli for missing bin', () => {
    assert.deepEqual(resolveCli({}, 'foo'), { has_cli: false });
  });

  it('uses package (unscoped) name for a string bin', () => {
    assert.deepEqual(resolveCli({ bin: './cli.js' }, 'foo'), { has_cli: true, cli_bin_name: 'foo', cli_bin_path: 'cli.js' });
  });

  it('carries an explicit bin name distinct from the file basename', () => {
    assert.deepEqual(resolveCli({ bin: { mytool: 'bin/run.js' } }, 'foo'), { has_cli: true, cli_bin_name: 'mytool', cli_bin_path: 'bin/run.js' });
  });

  it('flags multiple bins', () => {
    assert.deepEqual(resolveCli({ bin: { a: 'a.js', b: 'b.js' } }, 'foo'), { status: 'multiple_bins', names: ['a', 'b'] });
  });
});

describe('classifyTierA', () => {
  const base = {
    name: 'foo', version: '1.2.3', unscoped: 'foo',
    sourcePackageJson: { name: 'foo', version: '1.2.3', main: 'index.js' },
    sourceFiles: ['package.json', 'index.js'],
    packedPackageJson: { name: 'foo', version: '1.2.3', main: 'index.js' },
    packedFiles: ['package.json', 'index.js'],
  };

  it('is eligible for a pure-JS single-entry package', () => {
    const r = classifyTierA(base);
    assert.equal(r.eligible, true);
    assert.equal(r.template_id, TIER_A_TEMPLATE_ID);
    assert.equal(r.upstream.has_cli, false);
    assert.equal(r.upstream.main_entry, 'index.js');
  });

  it('rejects a build lifecycle script', () => {
    const r = classifyTierA({ ...base, sourcePackageJson: { ...base.sourcePackageJson, scripts: { build: 'tsc' } } });
    assert.equal(r.eligible, false);
    assert.equal(r.reason_code, REASON.NATIVE_OR_BUILD_INDICATORS);
  });

  it('rejects binding.gyp as a native build path', () => {
    const r = classifyTierA({ ...base, sourceFiles: ['package.json', 'index.js', 'binding.gyp'] });
    assert.equal(r.eligible, false);
    assert.equal(r.reason_code, REASON.NATIVE_OR_BUILD_INDICATORS);
  });

  it('rejects a missing main entry in the packed tarball', () => {
    const r = classifyTierA({ ...base, packedFiles: ['package.json'] });
    assert.equal(r.eligible, false);
    assert.equal(r.reason_code, REASON.MISSING_MAIN_ENTRY);
  });

  it('rejects complex exports', () => {
    const r = classifyTierA({ ...base, packedPackageJson: { name: 'foo', version: '1.2.3', exports: { '.': './i.js', './x': './x.js' } } });
    assert.equal(r.eligible, false);
    assert.equal(r.reason_code, REASON.COMPLEX_EXPORTS);
  });

  it('rejects multiple CLI bins', () => {
    const r = classifyTierA({ ...base, packedPackageJson: { name: 'foo', version: '1.2.3', main: 'index.js', bin: { a: 'a.js', b: 'b.js' } } });
    assert.equal(r.eligible, false);
    assert.equal(r.reason_code, REASON.MULTIPLE_CLI_BINS);
  });

  it('rejects a packed name/version mismatch', () => {
    const r = classifyTierA({ ...base, packedPackageJson: { name: 'other', version: '9.9.9', main: 'index.js' } });
    assert.equal(r.eligible, false);
    assert.equal(r.reason_code, REASON.PACK_NAME_VERSION_MISMATCH);
  });

  it('carries a CLI whose command name differs from the bin file basename', () => {
    const r = classifyTierA({
      ...base,
      packedPackageJson: { name: 'foo', version: '1.2.3', main: 'index.js', bin: { mytool: 'bin/run.js' } },
      packedFiles: ['package.json', 'index.js', 'bin/run.js'],
    });
    assert.equal(r.eligible, true);
    assert.equal(r.upstream.has_cli, true);
    assert.equal(r.upstream.cli_bin_name, 'mytool');
    assert.equal(r.upstream.cli_bin_path, 'bin/run.js');
  });
});

describe('computeFacts — input gates', () => {
  it('returns input_error for an invalid identity (never fabricates one)', async () => {
    const out = await computeFacts('not-an-identity', makeOptions());
    assert.equal(out.status, 'input_error');
    assert.equal(out.reason_code, REASON.INVALID_IDENTITY);
  });

  it('blocks the collector path when the registry contract SHA is unavailable', async () => {
    const out = await computeFacts('foo@1.2.3', { adapters: makeAdapters() });
    assert.equal(out.status, 'blocked');
    assert.equal(out.reason_code, REASON.REGISTRY_CONTRACT_UNAVAILABLE);
  });
});

describe('computeFacts — package/policy outcomes (needs_human, facts_available:false)', () => {
  it('PACKAGE_NOT_FOUND when the exact version is absent', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { getPackument: async () => null } }));
    assert.equal(out.status, 'needs_human');
    assert.equal(out.reason_code, REASON.PACKAGE_NOT_FOUND);
  });

  it('MISSING_DIST_INTEGRITY when registry metadata has no integrity', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: {
      getPackument: async () => ({ dist: { tarball: 'https://x/y.tgz' }, repository: { url: 'https://github.com/acme/foo.git' } }),
    } }));
    assert.equal(out.status, 'needs_human');
    assert.equal(out.reason_code, REASON.MISSING_DIST_INTEGRITY);
  });

  it('INTEGRITY_MISMATCH when downloaded bytes do not match dist.integrity', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { verifyIntegrity: async () => false } }));
    assert.equal(out.status, 'needs_human');
    assert.equal(out.reason_code, REASON.INTEGRITY_MISMATCH);
  });

  it('UNSUPPORTED_REPO_HOST for a repository on an unsupported host', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { repository: { url: 'https://sourcehut.example/acme/foo' } } }));
    assert.equal(out.status, 'needs_human');
    assert.equal(out.reason_code, REASON.UNSUPPORTED_REPO_HOST);
  });

  it('AMBIGUOUS_TAG for monorepo-style ambiguous version tags', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: {
      resolveSourceTag: async () => ({ status: 'ambiguous', candidates: ['a@1.2.3', 'b@1.2.3'] }),
    } }));
    assert.equal(out.status, 'needs_human');
    assert.equal(out.reason_code, REASON.AMBIGUOUS_TAG);
  });

  it('UNVERIFIED_SOURCE_ASSOCIATION when no version tag is found', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: {
      resolveSourceTag: async () => ({ status: 'not_found' }),
    } }));
    assert.equal(out.status, 'needs_human');
    assert.equal(out.reason_code, REASON.UNVERIFIED_SOURCE_ASSOCIATION);
  });

  it('COMPLEX_EXPORTS is recorded in classification but still produces a bundle', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: {
      packedPackageJson: { name: 'foo', version: '1.2.3', exports: { '.': './i.js', './x': './x.js' } },
    } }));
    assert.equal(out.status, 'ok');
    assert.equal(out.bundle.classification.tier_a_eligible, false);
    assert.equal(out.bundle.classification.reason_code, REASON.COMPLEX_EXPORTS);
  });

  it('NATIVE_OR_BUILD_INDICATORS is recorded in classification but still produces a bundle', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: {
      sourceFiles: ['package.json', 'index.js', 'binding.gyp'],
    } }));
    assert.equal(out.status, 'ok');
    assert.equal(out.bundle.classification.tier_a_eligible, false);
    assert.equal(out.bundle.classification.reason_code, REASON.NATIVE_OR_BUILD_INDICATORS);
    assert.equal(out.bundle.classification.native_tier, 'C');
  });
});

describe('computeFacts — successful bundles', () => {
  it('produces an eligible Tier A bundle with verified provenance', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions());
    assert.equal(out.status, 'ok');
    const b = out.bundle;
    assert.equal(b.schema_version, 1);
    assert.equal(b.collector.version, COLLECTOR_VERSION);
    assert.equal(b.package_name, 'foo');
    assert.equal(b.package_version, '1.2.3');
    assert.equal(b.source.git_url, 'https://github.com/acme/foo.git');
    assert.equal(b.source.commit_sha, FAKE_COMMIT);
    assert.equal(b.source.resolution_method, 'verified_provenance');
    assert.equal(b.registry.provenance_status, 'verified');
    assert.equal(b.registry_contract_sha, FAKE_CONTRACT_SHA);
    assert.equal(b.classification.tier_a_eligible, true);
    assert.equal(b.classification.template_id, TIER_A_TEMPLATE_ID);
    assert.equal(b.upstream.has_cli, false);
    assert.equal(b.digests.tarball_sha256.length, 64);
    assert.deepEqual(b.could_not_verify, []);
  });

  it('records annotated vs lightweight tag state', async () => {
    const annotated = await computeFacts('foo@1.2.3', makeOptions({ adapters: { annotated: true } }));
    assert.equal(annotated.bundle.source.annotated_tag, true);
    const lightweight = await computeFacts('foo@1.2.3', makeOptions({ adapters: { annotated: false } }));
    assert.equal(lightweight.bundle.source.annotated_tag, false);
  });

  it('accepts a tag_only source association by default with a could_not_verify caveat', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: { provenanceStatus: 'absent' } }));
    assert.equal(out.status, 'ok');
    assert.equal(out.bundle.source.resolution_method, 'tag_only');
    assert.ok(out.bundle.could_not_verify.some(c => /tag_only/i.test(c)));
  });

  it('carries a CLI command name distinct from the bin basename into the bundle', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions({ adapters: {
      packedPackageJson: { name: 'foo', version: '1.2.3', main: 'index.js', bin: { mytool: 'bin/run.js' } },
      packedFiles: ['package.json', 'index.js', 'bin/run.js'],
    } }));
    assert.equal(out.status, 'ok');
    assert.equal(out.bundle.upstream.has_cli, true);
    assert.equal(out.bundle.upstream.cli_bin_name, 'mytool');
    assert.equal(out.bundle.upstream.cli_bin_path, 'bin/run.js');
  });
});

describe('computeFacts — operational faults throw (retryable infra, NOT needs_human)', () => {
  const cases = [
    ['429', REASON.HTTP_429],
    ['5xx', REASON.HTTP_5XX],
    ['timeout', REASON.TIMEOUT],
    ['oversize', REASON.OVERSIZED_RESPONSE],
    ['DNS', REASON.DNS_FAILURE],
    ['invalid JSON', REASON.INVALID_JSON],
  ];
  for (const [label, code] of cases) {
    it(`getPackument ${label} propagates as OperationalError`, async () => {
      await assert.rejects(
        () => computeFacts('foo@1.2.3', makeOptions({ adapters: {
          getPackument: async () => { throw new OperationalError(label, code); },
        } })),
        (err) => err instanceof OperationalError && err.reason_code === code && err.retryable === true,
      );
    });
  }

  it('a child-process failure during packFromSource propagates as OperationalError', async () => {
    await assert.rejects(
      () => computeFacts('foo@1.2.3', makeOptions({ adapters: {
        packFromSource: async () => { throw new OperationalError('git clone failed', REASON.CHILD_PROCESS_FAILURE); },
      } })),
      (err) => err instanceof OperationalError && err.reason_code === REASON.CHILD_PROCESS_FAILURE,
    );
  });

  it('re-wraps a plain error tagged with an operational reason code', async () => {
    await assert.rejects(
      () => computeFacts('foo@1.2.3', makeOptions({ adapters: {
        download: async () => { const e = new Error('boom'); e.reason_code = REASON.TIMEOUT; throw e; },
      } })),
      (err) => err instanceof OperationalError && err.reason_code === REASON.TIMEOUT,
    );
  });
});

describe('toAgentInput', () => {
  it('maps ok -> facts_available:true with the bundle', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions());
    const input = toAgentInput('foo@1.2.3', out);
    assert.equal(input.facts_available, true);
    assert.equal(input.facts.identity, 'foo@1.2.3');
  });

  it('maps input_error -> facts_available:false with input_error:true and reason_code', () => {
    const input = toAgentInput('bad', { status: 'input_error', reason_code: REASON.INVALID_IDENTITY, reason: 'x' });
    assert.equal(input.facts_available, false);
    assert.equal(input.input_error, true);
    assert.equal(input.reason_code, REASON.INVALID_IDENTITY);
  });

  it('maps blocked -> facts_available:false with blocked:true', () => {
    const input = toAgentInput('foo@1.2.3', { status: 'blocked', reason_code: REASON.REGISTRY_CONTRACT_UNAVAILABLE, reason: 'x' });
    assert.equal(input.facts_available, false);
    assert.equal(input.blocked, true);
  });

  it('maps needs_human -> facts_available:false with a stable reason_code', () => {
    const input = toAgentInput('foo@1.2.3', { status: 'needs_human', reason_code: REASON.PACKAGE_NOT_FOUND, reason: 'x' });
    assert.equal(input.facts_available, false);
    assert.equal(input.reason_code, REASON.PACKAGE_NOT_FOUND);
    assert.equal(input.input_error, undefined);
  });
});
