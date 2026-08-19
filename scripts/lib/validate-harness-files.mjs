// host_files preflight check for the Fullsend configuration.
//
// Fullsend validates a harness's host_files in TWO phases, and their order is
// the source of a recurring CI failure (see the harness YAML comment):
//
//   1. "validating files"   — stat every non-optional `src`   (BEFORE pre-script)
//   2. "Running pre-script"  — the pre-script writes its output files
//   3. "Creating sandbox"    — host_files are copied into the sandbox (AFTER pre-script)
//
// A host_files entry whose `src` is produced by the pre-script therefore does
// NOT exist at phase 1. If it is not marked `optional: true`, phase 1 aborts the
// run with:
//   validating files: host_files[N].src: stat <path>: no such file or directory
//
// The distinguishing signal: fullsend expands `src` with os.ExpandEnv (the
// runner PROCESS env). So a `src` falls into one of three buckets:
//   - "${VAR}" env indirection  → runner-provisioned, exists at phase 1 (fine)
//   - relative path             → a committed file under .fullsend/, exists (fine)
//   - literal ABSOLUTE path     → not a checkout file; only the pre-script can
//                                 create it, so it does NOT exist at phase 1 and
//                                 MUST be optional
//
// This static check flags the third bucket when it is not optional, so the trap
// fails fast in `npm run check` with a clear message instead of blowing up mid
// dispatch. Deliberately no YAML dependency: the harness files are simple,
// repo-controlled block YAML and we reuse the same targeted parser style as
// validate-roles.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScalarAll } from './validate-roles.mjs';

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

// Parse the `host_files:` block sequence into entries of the fields we care
// about: { src, optional }. Each entry begins with a `- src: ...` line; its
// remaining fields are indented continuation lines until the next `- ` item or
// the next top-level key.
export function parseHostFiles(text) {
  const lines = stripComments(text).split('\n');
  const entries = [];
  let inBlock = false;
  let current = null;

  const push = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const line of lines) {
    if (/^host_files:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;

    if (/^\s*$/.test(line)) continue;
    // A non-indented, non-list line ends the block sequence (next top-level key).
    if (/^\S/.test(line)) {
      push();
      inBlock = false;
      continue;
    }

    const item = line.match(/^\s*-\s+(.*)$/);
    if (item) {
      push();
      current = { src: null, optional: false };
      const kv = item[1].match(/^(\w+):\s*(.*)$/);
      if (kv) applyField(current, kv[1], kv[2]);
      continue;
    }

    const cont = line.match(/^\s+(\w+):\s*(.*)$/);
    if (cont && current) applyField(current, cont[1], cont[2]);
  }
  push();
  return entries;
}

function applyField(entry, key, rawValue) {
  const value = unquote(rawValue);
  if (key === 'src') entry.src = value;
  else if (key === 'optional') entry.optional = value === 'true';
}

// True when `src` is a literal absolute path — i.e. not an ${ENV} indirection
// and not a relative (committed) path. Only the pre-script can produce such a
// file, so it does not exist during fullsend's phase-1 file validation.
export function isPreScriptOutputSrc(src) {
  if (!src) return false;
  if (src.includes('${') || src.includes('$(')) return false; // runner-provisioned
  return src.startsWith('/');
}

// Core check, decoupled from the filesystem for testing.
export function checkHostFileValidation(harnessText, source = '<harness>') {
  const errors = [];
  const hasPreScript = parseScalarAll(harnessText, 'pre_script').length > 0;
  const entries = parseHostFiles(harnessText);

  entries.forEach((entry, index) => {
    if (!isPreScriptOutputSrc(entry.src)) return;
    if (entry.optional) return;
    errors.push(
      `harness "${source}" host_files[${index}].src "${entry.src}" is a literal ` +
        `absolute path that no repo checkout provides. Fullsend stat-validates ` +
        `host_files BEFORE the pre-script runs, so this file does not exist yet ` +
        `and the run aborts with "validating files: ... no such file or directory". ` +
        (hasPreScript
          ? `It is produced by the pre_script, which runs AFTER validation — mark ` +
            `this entry "optional: true" so validation skips it and the copy step ` +
            `(after the pre-script) picks up the now-present file.`
          : `Mark it "optional: true" or point it at an ${'${ENV}'} indirection / a ` +
            `committed relative path.`),
    );
  });
  return errors;
}

// Run the check against every agent harness declared in a Fullsend directory.
export function validateHarnessFiles(fullsendDir = FULLSEND_DIR) {
  const configText = readFileSync(join(fullsendDir, 'config.yaml'), 'utf-8');
  const errors = [];
  for (const source of parseScalarAll(configText, 'source')) {
    let harnessText;
    try {
      harnessText = readFileSync(join(fullsendDir, source), 'utf-8');
    } catch (err) {
      errors.push(`agent harness "${source}" could not be read: ${err.message}`);
      continue;
    }
    errors.push(...checkHostFileValidation(harnessText, source));
  }
  return errors;
}

// CLI entrypoint: exit non-zero on any inconsistency so CI fails fast.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateHarnessFiles();
  if (errors.length > 0) {
    console.error('Harness host_files check failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('Harness host_files check passed: no pre-script output is left non-optional.');
}
