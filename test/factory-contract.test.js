import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFactorySection,
  detectFactoryBlockers,
  validateDraftedAgainstFactoryBlockers,
  validateEntrypointAgainstFactory,
  FACTORY_BLOCKER,
} from '../scripts/lib/factory-contract.mjs';

describe('detectFactoryBlockers', () => {
  it('flags pnpm packageManager and workspace protocol', () => {
    const root = { packageManager: 'pnpm@10.12.1', private: true, devDependencies: { zod: 'workspace:*' } };
    const pkg = { name: 'zod', version: '4.5.4' };
    const { blockers } = detectFactoryBlockers(root, pkg);
    assert.ok(blockers.includes(FACTORY_BLOCKER.PNPM_WORKSPACE));
    assert.ok(blockers.includes(FACTORY_BLOCKER.WORKSPACE_PROTOCOL));
  });

  it('returns no blockers for a single-package npm repo', () => {
    const pkg = { name: 'lodash', version: '4.18.1', scripts: { build: 'tsc' } };
    assert.deepEqual(detectFactoryBlockers(pkg, pkg).blockers, []);
  });
});

describe('buildFactorySection', () => {
  it('uses --include=dev when a build step is required', () => {
    const section = buildFactorySection({ hasBuildStep: true, packageDirRel: '.', blockers: [] });
    assert.equal(section.install_command, 'npm install --include=dev --ignore-scripts');
    assert.equal(section.node_env, 'production');
  });
});

describe('validateEntrypointAgainstFactory', () => {
  const facts = {
    upstream: { has_build_step: true },
    factory: { package_dir: '.', blockers: [] },
  };

  it('requires --include=dev when facts say build step', () => {
    const script = '#!/usr/bin/env bash\nnpm install --ignore-scripts\nnpm run build\n';
    const errors = validateEntrypointAgainstFactory(script, facts);
    assert.ok(errors.some((e) => e.check === 'factory-install-devdeps'));
  });

  it('accepts npm install --include=dev', () => {
    const script = '#!/usr/bin/env bash\nnpm install --include=dev --ignore-scripts\nnpm run build\n';
    assert.deepEqual(validateEntrypointAgainstFactory(script, facts), []);
  });

  it('requires cd into monorepo package_dir', () => {
    const monorepoFacts = {
      upstream: { has_build_step: false },
      factory: { package_dir: 'packages/zod', blockers: [] },
    };
    const script = '#!/usr/bin/env bash\ngit clone repo src\ncd src\nnpm pack\n';
    const errors = validateEntrypointAgainstFactory(script, monorepoFacts);
    assert.ok(errors.some((e) => e.check === 'factory-package-dir'));
  });
});

describe('validateDraftedAgainstFactoryBlockers', () => {
  it('rejects drafted when blockers are present', () => {
    const facts = { factory: { blockers: ['pnpm-workspace'], blocker_details: ['no pnpm'] } };
    const errors = validateDraftedAgainstFactoryBlockers(facts, 'drafted');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].check, 'factory-blocker-drafted');
  });

  it('allows needs_human with blockers', () => {
    const facts = { factory: { blockers: ['pnpm-workspace'] } };
    assert.deepEqual(validateDraftedAgainstFactoryBlockers(facts, 'needs_human'), []);
  });
});
