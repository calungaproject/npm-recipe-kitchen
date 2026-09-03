// Derive the npm-builder command inventory from plumbing/npm-builder/Containerfile.
// Same rules the recipe agent should apply when reading the Containerfile.

/** RPM package name → binaries typically on PATH after install. */
const DNF_PACKAGE_COMMANDS = {
  nodejs: ['node'],
  npm: ['npm', 'npx'],
  golang: ['go'],
  git: ['git'],
  python3: ['python3'],
  'python3-pip': ['pip3', 'pip'],
  tar: ['tar'],
  gzip: ['gzip'],
  xz: ['xz'],
  jq: ['jq'],
  which: ['which'],
  findutils: ['find', 'xargs'],
  grep: ['grep'],
  patch: ['patch'],
  make: ['make'],
  gcc: ['gcc'],
  'gcc-c++': ['g++'],
  'pkg-config': ['pkg-config'],
};

const DNF_INSTALL_RE = /dnf\s+-y\s+install\b/g;

/** Present on UBI8 base image (FROM registry.access.redhat.com/ubi8/ubi). */
const UBI_BASE_COMMANDS = [
  'basename', 'cat', 'chmod', 'cp', 'date', 'dirname', 'echo', 'env', 'expr',
  'false', 'head', 'id', 'ln', 'ls', 'mkdir', 'mktemp', 'mv', 'printf', 'pwd',
  'readlink', 'rm', 'rmdir', 'sleep', 'sort', 'tail', 'tee', 'test', 'touch',
  'true', 'uname', 'wc', 'whoami',
];

/**
 * @param {string} content Containerfile text
 * @returns {string[]}
 */
export function extractDnfInstallPackages(content) {
  const packages = [];
  let match;
  while ((match = DNF_INSTALL_RE.exec(content)) !== null) {
    const start = match.index + match[0].length;
    let block = content.slice(start);
    const end = block.search(/\n\s*&&\s*dnf\s+clean\b|\nFROM\b|\nCOPY\b|\nRUN\s+useradd\b/);
    if (end >= 0) block = block.slice(0, end);
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    for (const line of lines) {
      const token = line.replace(/\\$/, '').trim();
      if (!token || token.startsWith('--')) continue;
      if (token === '&&') continue;
      packages.push(token);
    }
  }
  return packages;
}

/**
 * @param {string} content
 * @returns {string[]}
 */
export function extractCopiedScriptCommands(content) {
  const names = new Set();
  for (const line of content.split('\n')) {
    if (!line.includes('COPY --chmod=755 scripts/')) continue;
    const tokens = line.replace(/^COPY --chmod=755 /, '').trim().split(/\s+/);
    for (const tok of tokens) {
      if (!tok.startsWith('scripts/')) continue;
      const base = tok.slice('scripts/'.length).split('/').pop();
      if (base) names.add(base);
    }
  }
  return [...names];
}

/**
 * @param {string} content Containerfile text
 * @returns {{ commands: Set<string>, packages: string[], scripts: string[], sourcePath: string }}
 */
export function parseNpmBuilderContainerfile(content, sourcePath = 'npm-builder/Containerfile') {
  const commands = new Set(['bash', 'sh', 'cd', 'test', '[', ...UBI_BASE_COMMANDS]);

  for (const pkg of extractDnfInstallPackages(content)) {
    const mapped = DNF_PACKAGE_COMMANDS[pkg];
    if (mapped) {
      for (const cmd of mapped) commands.add(cmd);
    } else if (!pkg.includes('-devel') && !pkg.includes('langpack') && pkg !== 'ca-certificates') {
      commands.add(pkg.toLowerCase());
    }
  }

  if (/COPY --from=syft-bin[^\n]*\bsyft\b/m.test(content)) {
    commands.add('syft');
  }

  for (const script of extractCopiedScriptCommands(content)) {
    commands.add(script.toLowerCase());
    if (script.endsWith('.sh')) {
      commands.add(script.slice(0, -3).toLowerCase());
    }
  }

  if (/gcc-toolset/i.test(content)) {
    commands.add('gcc');
    commands.add('g++');
  }
  if (/rust-toolset/i.test(content)) {
    commands.add('cargo');
    commands.add('rustc');
  }

  return {
    commands,
    packages: extractDnfInstallPackages(content),
    scripts: extractCopiedScriptCommands(content),
    sourcePath,
  };
}

/**
 * Human-readable summary for agent prompts / review comments.
 * @param {string} content
 */
export function formatNpmBuilderInventoryMarkdown(content) {
  const { commands, packages, scripts, sourcePath } = parseNpmBuilderContainerfile(content);
  const sorted = [...commands].sort();
  return [
    `# npm-builder command inventory (from ${sourcePath})`,
    '',
    'Derived from `dnf install`, factory scripts copied to `/usr/local/bin`, and gcc/rust toolsets.',
    '',
    '## Commands',
    '',
    ...sorted.map((c) => `- \`${c}\``),
    '',
    '## dnf packages',
    '',
    ...packages.map((p) => `- \`${p}\``),
    '',
    '## Factory scripts',
    '',
    ...scripts.map((s) => `- \`${s}\``),
    '',
  ].join('\n');
}
