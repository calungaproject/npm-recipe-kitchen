// npm-builder factory runtime contract — shared by fact collection, validation, and agent skills.

export const FACTORY_BLOCKER = {
  PNPM_WORKSPACE: 'pnpm-workspace',
  YARN_WORKSPACE: 'yarn-workspace',
  WORKSPACE_PROTOCOL: 'workspace-protocol',
};

const NPM_INSTALL_RE = /\bnpm\s+install\b/;

/**
 * @param {unknown} pkgJson
 * @returns {boolean}
 */
export function jsonUsesWorkspaceProtocol(pkgJson) {
  if (!pkgJson || typeof pkgJson !== 'object') return false;
  const serialized = JSON.stringify(pkgJson);
  return serialized.includes('workspace:');
}

/**
 * Detect recipe patterns that cannot run in npm-builder with npm alone.
 * @param {object} rootPkg  repository root package.json
 * @param {object} packagePkg  publishable package package.json
 * @returns {{ blockers: string[], blocker_details: string[] }}
 */
export function detectFactoryBlockers(rootPkg, packagePkg) {
  const blockers = [];
  const blocker_details = [];
  const root = rootPkg && typeof rootPkg === 'object' ? rootPkg : {};
  const pkg = packagePkg && typeof packagePkg === 'object' ? packagePkg : {};

  const packageManager = typeof root.packageManager === 'string' ? root.packageManager.trim() : '';
  if (packageManager.startsWith('pnpm')) {
    blockers.push(FACTORY_BLOCKER.PNPM_WORKSPACE);
    blocker_details.push(`root packageManager is "${packageManager}"; npm-builder has no pnpm`);
  }
  if (packageManager.startsWith('yarn')) {
    blockers.push(FACTORY_BLOCKER.YARN_WORKSPACE);
    blocker_details.push(`root packageManager is "${packageManager}"; npm-builder has no yarn`);
  }
  if (jsonUsesWorkspaceProtocol(root) || jsonUsesWorkspaceProtocol(pkg)) {
    if (!blockers.includes(FACTORY_BLOCKER.WORKSPACE_PROTOCOL)) {
      blockers.push(FACTORY_BLOCKER.WORKSPACE_PROTOCOL);
    }
    blocker_details.push('package.json uses workspace: protocol; npm install cannot resolve it without the monorepo tool');
  }

  return { blockers, blocker_details };
}

/**
 * @param {object} opts
 * @param {boolean} opts.hasBuildStep
 * @param {string} opts.packageDirRel  relative path from repo root ("." when root is the package)
 * @param {string[]} opts.blockers
 * @param {string[]} [opts.blockerDetails]
 */
export function buildFactorySection({ hasBuildStep, packageDirRel, blockers, blockerDetails = [] }) {
  return {
    node_env: 'production',
    package_dir: packageDirRel || '.',
    install_command: hasBuildStep
      ? 'npm install --include=dev --ignore-scripts'
      : 'npm install --ignore-scripts',
    install_notes: hasBuildStep
      ? 'npm-builder sets NODE_ENV=production, which omits devDependencies unless --include=dev is used; TypeScript/babel/etc. are usually devDependencies'
      : 'Use when dependencies are required before pack; omit install for pack-only recipes from a clean tag',
    blockers,
    ...(blockerDetails.length > 0 ? { blocker_details: blockerDetails } : {}),
  };
}

/**
 * @param {string} content  build.entrypoint.sh body
 * @param {object} facts
 * @returns {Array<{ check: string, path: string, message: string }>}
 */
export function validateEntrypointAgainstFactory(content, facts) {
  const errors = [];
  if (!content || !facts || typeof facts !== 'object') return errors;

  const factory = facts.factory;
  const hasBuildStep = facts.upstream?.has_build_step === true;

  if (hasBuildStep && NPM_INSTALL_RE.test(content)) {
    const hasIncludeDev = /--include=dev\b/.test(content);
    const hasProductionFalse = /--production\s+false\b/.test(content)
      || /\bNODE_ENV=development\b/.test(content);
    if (!hasIncludeDev && !hasProductionFalse) {
      errors.push({
        check: 'factory-install-devdeps',
        path: '/build.entrypoint.sh',
        message: 'build requires devDependencies; use npm install --include=dev --ignore-scripts (npm-builder sets NODE_ENV=production)',
      });
    }
  }

  const packageDir = factory?.package_dir;
  if (typeof packageDir === 'string' && packageDir !== '.' && !content.includes(packageDir)) {
    errors.push({
      check: 'factory-package-dir',
      path: '/build.entrypoint.sh',
      message: `trusted facts place the publishable package at ${packageDir}; cd into that directory after clone before npm install/pack`,
    });
  }

  if (NPM_INSTALL_RE.test(content) && Array.isArray(factory?.blockers) && factory.blockers.length > 0) {
    const detail = factory.blocker_details?.[0] ?? factory.blockers.join(', ');
    errors.push({
      check: 'factory-blocker',
      path: '/build.entrypoint.sh',
      message: `factory blockers present (${factory.blockers.join(', ')}): ${detail}; emit needs_human instead of npm install at monorepo root`,
    });
  }

  return errors;
}

/**
 * @param {object} facts
 * @param {string} [status]  recipe-result status
 * @returns {Array<{ check: string, path: string, message: string }>}
 */
export function validateDraftedAgainstFactoryBlockers(facts, status) {
  if (status !== 'drafted') return [];
  const blockers = facts?.factory?.blockers;
  if (!Array.isArray(blockers) || blockers.length === 0) return [];
  const detail = facts.factory.blocker_details?.join('; ') ?? 'see facts.factory.blockers';
  return [{
    check: 'factory-blocker-drafted',
    path: '/recipe-result.json/status',
    message: `cannot draft with factory blockers (${blockers.join(', ')}): ${detail}; use status needs_human`,
  }];
}
