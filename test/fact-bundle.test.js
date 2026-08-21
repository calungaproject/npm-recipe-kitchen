import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveAuthoritative, buildParametersFromFacts, FACT_BUNDLE_SCHEMA_VERSION } from '../scripts/lib/fact-bundle.mjs';
import { computeFacts } from '../scripts/lib/compute-facts.mjs';
import { makeOptions } from './helpers/collector-fakes.mjs';
import { semverFacts, chalkFacts } from './helpers/fixture-facts.mjs';

// deriveAuthoritative must collapse a fact bundle onto one authoritative field
// set, whether it comes from a static fixture or the live collector.

describe('deriveAuthoritative — static fixture shape', () => {
  it('derives identity/source/entrypoint from the fixture', () => {
    const a = deriveAuthoritative(semverFacts());
    assert.equal(a.identity, 'semver@7.7.2');
    assert.equal(a.package_name, 'semver');
    assert.equal(a.source_ref, '281055e7716ef0415a8826972471331989ede58c');
    assert.equal(a.source_tag, 'v7.7.2');
    assert.equal(a.main_entry, 'index.js');
    assert.equal(a.upstream_npm_version, '7.7.2');
    assert.equal(a.has_cli, true);
    assert.equal(a.cli_bin_path, 'bin/semver.js');
    assert.equal(a.cli_bin_name, 'semver');
    assert.equal(a.template_id, 'tier-a-npm-pack-no-build-v1');
  });

  it('normalises no-CLI absence for a non-CLI package (chalk)', () => {
    const chalk = deriveAuthoritative(chalkFacts());
    assert.equal(chalk.has_cli, false);
    assert.equal(chalk.cli_bin_path, null);
    assert.equal(chalk.cli_bin_name, null);
  });
});

describe('deriveAuthoritative — collector shape', () => {
  it('derives the same authoritative fields from a collector bundle', async () => {
    const out = await computeFacts('foo@1.2.3', makeOptions());
    const a = deriveAuthoritative(out.bundle);
    assert.equal(a.identity, 'foo@1.2.3');
    assert.equal(a.package_name, 'foo');
    assert.equal(a.source_ref.length, 40);
    assert.equal(a.has_cli, false);
    assert.equal(a.template_id, 'tier-a-npm-pack-no-build-v1');
  });

  it('returns null for a non-bundle', () => {
    assert.equal(deriveAuthoritative(null), null);
    assert.equal(deriveAuthoritative('nope'), null);
  });
});

describe('buildParametersFromFacts', () => {
  it('omits cli params for a non-CLI package', () => {
    const params = buildParametersFromFacts(chalkFacts());
    assert.equal(params.cli_bin_path, undefined);
    assert.equal(params.cli_bin_name, undefined);
    assert.equal(params.has_cli.value, false);
  });

  it('emits cli params for a CLI package', () => {
    const params = buildParametersFromFacts(semverFacts());
    assert.equal(params.cli_bin_path.value, 'bin/semver.js');
    assert.equal(params.cli_bin_name.value, 'semver');
    assert.equal(params.has_cli.value, true);
  });

  it('uses the model-supplied description when present, else a default', () => {
    const b = chalkFacts();
    assert.equal(buildParametersFromFacts(b, { description: 'hi' }).description.value, 'hi');
    assert.equal(buildParametersFromFacts(b).description.value, 'chalk 5.3.0');
  });

  it('exposes a stable schema version', () => {
    assert.equal(FACT_BUNDLE_SCHEMA_VERSION, 1);
  });
});
