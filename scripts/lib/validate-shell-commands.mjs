// Static check: recipe shell scripts must only invoke commands present in npm-builder.

import { loadNpmBuilderInventory } from './npm-builder-inventory.mjs';

/** Bash/POSIX builtins and common reserved words — not looked up on PATH. */
const SHELL_BUILTINS = new Set([
  '.', ':', '[', '[[', ']]', 'alias', 'bg', 'break', 'builtin', 'caller', 'cd',
  'command', 'compgen', 'complete', 'continue', 'declare', 'dirs', 'disown',
  'do', 'done', 'elif', 'else', 'esac', 'eval', 'exec', 'exit', 'export',
  'false', 'fc', 'fg', 'fi', 'for', 'function', 'getopts', 'hash', 'help',
  'history', 'if', 'in', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile',
  'popd', 'printf', 'pushd', 'read', 'readarray', 'readonly', 'return', 'select',
  'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'then', 'time', 'times',
  'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset',
  'until', 'wait', 'while',
]);

const ASSIGNMENT_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip # comments (naive; sufficient for recipe scripts).
 * @param {string} line
 */
function stripLineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/**
 * Remove $(...) command substitutions (balanced parens).
 * @param {string} s
 */
function stripCommandSubstitutions(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '$' && s[i + 1] === '(') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') depth -= 1;
        i += 1;
      }
      out += ' ';
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * Remove quoted strings and command substitutions so we only scan top-level commands.
 * @param {string} content
 */
function stripNestedShell(content) {
  let s = stripCommandSubstitutions(content);
  s = s.replace(/`[^`]*`/g, ' ');
  s = s.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, ' ');
  s = s.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, ' ');
  return s;
}

/**
 * @param {string} segment
 * @returns {string|null}
 */
function firstCommandName(segment) {
  let s = segment.trim();
  if (!s || s.startsWith('#')) return null;

  // Drop leading env assignments: FOO=bar cmd ...
  while (ASSIGNMENT_PREFIX_RE.test(s)) {
    const sp = s.indexOf(' ');
    if (sp === -1) return null;
    s = s.slice(sp + 1).trim();
  }

  if (!s) return null;
  if (s.startsWith('(') || s.startsWith('{') || s.startsWith('!')) return null;

  const tokens = s.split(/\s+/);
  const first = tokens[0];
  if (!first) return null;

  if (first.startsWith('./') || first.startsWith('../') || first.startsWith('/')) {
    return null;
  }
  if (first.includes('/')) {
    return first.split('/').pop()?.toLowerCase() ?? null;
  }
  if (first.startsWith('-')) return null;
  if (first.includes('$') || first.includes('{') || first.includes('}')) return null;

  const name = first.toLowerCase();
  // npm subcommands (npm pack, npm run, npm install, …) — npm is on PATH.
  if (name === 'npm' && tokens.length > 1 && !tokens[1].startsWith('-')) {
    return 'npm';
  }
  return name;
}

/**
 * @param {string} content
 * @returns {string[]}
 */
export function extractExternalCommands(content) {
  const names = new Set();
  const withoutHeredoc = content.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1/g, '');

  for (const rawLine of withoutHeredoc.split('\n')) {
    const commented = stripLineComment(rawLine).trim();
    if (!commented) continue;
    const line = stripNestedShell(commented).trim();
    if (!line) continue;

    const segments = line.split(/&&|\|\||;|\|/);
    for (const segment of segments) {
      const name = firstCommandName(segment);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * @param {string} content
 * @param {string} label
 * @returns {Array<{ check: string, path: string, message: string }>}
 */
export function validateShellCommandsForNpmBuilder(content, label) {
  const { commands: allowed } = loadNpmBuilderInventory();
  const errors = [];
  const seen = new Set();

  for (const name of extractExternalCommands(content)) {
    if (SHELL_BUILTINS.has(name) || allowed.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    errors.push({
      check: 'npm-builder-command',
      path: `/${label}`,
      message: `command "${name}" is not available in the npm-builder factory image (parse registry-contract/npm-builder/Containerfile or plumbing/npm-builder/Containerfile)`,
    });
  }
  return errors;
}
