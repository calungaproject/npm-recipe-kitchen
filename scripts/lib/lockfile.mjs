export function deriveProductionFacts(packageJson, packageLock) {
  const { lockfileVersion, packages } = packageLock;

  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    throw new Error(
      `Unsupported lockfileVersion ${lockfileVersion}: only 2 and 3 are supported`,
    );
  }

  if (!packages || typeof packages !== 'object') {
    throw new Error('Lockfile is missing the "packages" map');
  }

  const root = packages[''];
  if (!root) {
    throw new Error('Lockfile is missing the root ("") entry in packages');
  }

  if (packageJson.workspaces || root.workspaces) {
    throw new Error('Workspaces are not supported');
  }

  const rootDeps = packageJson.dependencies || {};
  const rootOptDeps = packageJson.optionalDependencies || {};
  const optionalNames = new Set(Object.keys(rootOptDeps));
  const rootProdDepNames = [
    ...new Set([...Object.keys(rootDeps), ...Object.keys(rootOptDeps)]),
  ];

  const visited = new Set();
  const identityByKey = new Map();

  function resolve(depName, fromKey) {
    if (fromKey === '') {
      const key = `node_modules/${depName}`;
      return packages[key] ? key : null;
    }

    const nested = `${fromKey}/node_modules/${depName}`;
    if (packages[nested]) return nested;

    let current = fromKey;
    while (current.includes('node_modules/')) {
      const lastNm = current.lastIndexOf('/node_modules/');
      current = lastNm === -1 ? '' : current.slice(0, lastNm);
      const candidate = current
        ? `${current}/node_modules/${depName}`
        : `node_modules/${depName}`;
      if (packages[candidate]) return candidate;
    }

    return null;
  }

  function nameFromKey(key) {
    const prefix = 'node_modules/';
    const i = key.lastIndexOf(prefix);
    return key.slice(i + prefix.length);
  }

  function validateEntry(key, entry) {
    if (entry.link) {
      throw new Error(`Unsupported: link entry at ${key}`);
    }

    if (entry.resolved) {
      if (entry.resolved.startsWith('file:')) {
        throw new Error(`Unsupported: file: dependency at ${key}`);
      }
      if (/^git[+:]|^github:/.test(entry.resolved)) {
        throw new Error(`Unsupported: git dependency at ${key}`);
      }
    }

    if (!entry.version) {
      throw new Error(`Missing resolved package version at ${key}`);
    }

    if (
      entry.peerDependencies &&
      Object.keys(entry.peerDependencies).length > 0
    ) {
      const name = nameFromKey(key);
      throw new Error(
        `Unsupported: ${name}@${entry.version} declares peerDependencies; ` +
          'peer dependency resolution is not implemented',
      );
    }
  }

  function traverse(depName, fromKey, isOptional) {
    const resolvedKey = resolve(depName, fromKey);
    if (!resolvedKey) {
      if (isOptional) return;
      throw new Error(
        `Cannot resolve dependency "${depName}" from ${fromKey || 'root'}`,
      );
    }

    if (visited.has(resolvedKey)) return;
    visited.add(resolvedKey);

    const entry = packages[resolvedKey];
    validateEntry(resolvedKey, entry);

    identityByKey.set(
      resolvedKey,
      `${nameFromKey(resolvedKey)}@${entry.version}`,
    );

    if (entry.dependencies) {
      for (const dep of Object.keys(entry.dependencies)) {
        traverse(dep, resolvedKey, false);
      }
    }
    if (entry.optionalDependencies) {
      for (const dep of Object.keys(entry.optionalDependencies)) {
        traverse(dep, resolvedKey, true);
      }
    }
  }

  const directIdentities = [];
  for (const depName of rootProdDepNames) {
    const key = resolve(depName, '');
    if (!key) {
      if (optionalNames.has(depName)) continue;
      throw new Error(`Cannot resolve root dependency "${depName}"`);
    }
    traverse(depName, '', optionalNames.has(depName));
    directIdentities.push(identityByKey.get(key));
  }

  return {
    directProduction: [...new Set(directIdentities)].sort(),
    productionClosure: [...identityByKey.values()].sort(),
  };
}
