// Role-consistency check for the Fullsend configuration.
//
// Every custom agent harness dispatches as a role (its `role:` field). The mint
// service will only issue a token for a role that is declared in
// `.fullsend/config.yaml` under `roles:`. If a harness requests an undeclared
// role, minting fails with an opaque HTTP 502 at dispatch time (see PR #5).
//
// This is a lightweight static check so that mismatch fails fast in CI with a
// clear message instead of surfacing as a 502 during a live run. The Fullsend
// config and harness files are simple, repo-controlled block YAML, so we
// deliberately parse only the two fields we need rather than pulling in a YAML
// dependency.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FULLSEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../.fullsend');

function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const hash = line.indexOf('#');
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join('\n');
}

function unquote(value) {
  const trimmed = value.trim();
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed[0] === '"' && trimmed.at(-1) === '"') ||
      (trimmed[0] === "'" && trimmed.at(-1) === "'"));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

// Parse a top-level `key:` that is either an inline flow list (`[a, b]` / `[]`)
// or the block sequence of `- item` lines that follows it. Returns null when
// the key is absent.
export function parseList(text, key) {
  const lines = stripComments(text).split('\n');
  const header = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(header);
    if (!match) continue;

    const inline = match[1].trim();
    if (inline.startsWith('[')) {
      const inner = inline.slice(1, inline.lastIndexOf(']')).trim();
      if (!inner) return [];
      return inner
        .split(',')
        .map((item) => unquote(item))
        .filter((item) => item.length > 0);
    }
    if (inline) return [unquote(inline)];

    const items = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*$/.test(line)) continue;
      const item = line.match(/^\s+-\s+(.*)$/);
      if (!item) break; // end of this block sequence
      items.push(unquote(item[1]));
    }
    return items;
  }
  return null;
}

// Collect every `key: value` scalar in the document, at any indentation.
export function parseScalarAll(text, key) {
  const lines = stripComments(text).split('\n');
  const matcher = new RegExp(`(?:^|\\s)${key}:\\s*(\\S.*)$`);
  const values = [];
  for (const line of lines) {
    const match = line.match(matcher);
    if (match) values.push(unquote(match[1]));
  }
  return values;
}

function parseScalar(text, key) {
  const [first] = parseScalarAll(text, key);
  return first ?? null;
}

// Core check, decoupled from the filesystem for testing. `readHarness(source)`
// returns the text of a harness file given its config-relative `source:` path.
export function checkRoleConsistency(configText, readHarness) {
  const errors = [];
  const declared = parseList(configText, 'roles') ?? [];
  const declaredSet = new Set(declared);

  for (const source of parseScalarAll(configText, 'source')) {
    let harnessText;
    try {
      harnessText = readHarness(source);
    } catch (err) {
      errors.push(`agent harness "${source}" could not be read: ${err.message}`);
      continue;
    }

    const role = parseScalar(harnessText, 'role');
    const agent = parseScalar(harnessText, 'agent') ?? source;
    if (!role) {
      errors.push(`harness "${source}" declares no role:`);
      continue;
    }
    if (!declaredSet.has(role)) {
      errors.push(
        `harness "${source}" (agent "${agent}") dispatches as role "${role}", which is ` +
          `not declared in .fullsend/config.yaml roles: [${declared.join(', ')}]. ` +
          `Add "${role}" to roles, or the mint service will fail with a 502 when issuing its token.`,
      );
    }
  }
  return errors;
}

// Run the check against a Fullsend directory on disk (defaults to this repo's).
export function validateRoles(fullsendDir = FULLSEND_DIR) {
  const configText = readFileSync(join(fullsendDir, 'config.yaml'), 'utf-8');
  return checkRoleConsistency(configText, (source) =>
    readFileSync(join(fullsendDir, source), 'utf-8'),
  );
}

// CLI entrypoint: exit non-zero on any inconsistency so CI fails fast.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateRoles();
  if (errors.length > 0) {
    console.error('Role consistency check failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('Role consistency check passed: every harness role is declared in config.yaml.');
}
