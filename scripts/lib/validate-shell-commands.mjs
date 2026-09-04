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
const FUNCTION_DEF_RE = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/;
const FUNCTION_CALL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\(\)$/;

/**
 * Bash functions defined in the script (not external binaries).
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractShellFunctionNames(content) {
  const names = new Set();
  const re = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/gm;
  for (const m of content.matchAll(re)) {
    names.add(m[1].toLowerCase());
  }
  return names;
}

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
 * Remove heredoc bodies (node <<'EOF' … EOF, etc.).
 * @param {string} content
 */
function stripHeredocs(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/<<-?\s*(?:'(\w+)'|"(\w+)"|(\w+))\s*$/);
    if (m) {
      const delim = m[1] || m[2] || m[3];
      const stripTabs = line.includes('<<-');
      i += 1;
      while (i < lines.length) {
        const end = stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
        if (end.trim() === delim) {
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(' ');
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

/**
 * Collapse multiline node -e '…' / "…" blocks; preserve prefix/suffix on the same line.
 * @param {string} content
 */
function stripMultilineNodeE(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const nodeIdx = line.search(/\bnode\s+-e\s+/);
    if (nodeIdx < 0) {
      out.push(line);
      i += 1;
      continue;
    }
    const before = line.slice(0, nodeIdx);
    let after = line.slice(nodeIdx);
    let quote = null;
    for (const ch of after) {
      if (ch === "'" || ch === '"') {
        if (!quote) quote = ch;
        else if (quote === ch) quote = null;
      }
    }
    while (quote && i + 1 < lines.length) {
      i += 1;
      after += `\n${lines[i]}`;
      for (const ch of lines[i]) {
        if (ch === "'" || ch === '"') {
          if (!quote) quote = ch;
          else if (quote === ch) quote = null;
        }
      }
    }
    let suffix = '';
    if (!quote) {
      const lastLine = after.split('\n').pop() ?? '';
      const m = lastLine.match(/^.*?\bnode\s+-e\s+(?:'[^']*'|"[^"]*")(.*)$/);
      if (m) suffix = m[1];
    }
    out.push(`${before}node -e "..."${suffix}`);
    i += 1;
  }
  return out.join('\n');
}

/**
 * Remove quoted strings and command substitutions so we only scan top-level commands.
 * @param {string} content
 */
function stripNestedShell(content) {
  let s = stripCommandSubstitutions(content);
  s = s.replace(/`[^`]*`/g, ' ');
  // Multiline-safe: toggle quote state per character.
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      out += ' ';
      continue;
    }
    if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      out += ' ';
      continue;
    }
    if (inSingle || inDouble) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
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
  let first = tokens[0];
  if (!first) return null;

  const fnCall = first.match(FUNCTION_CALL_RE);
  if (fnCall) first = fnCall[1];

  if (first.startsWith('./') || first.startsWith('../') || first.startsWith('/')) {
    return null;
  }
  if (first.includes('/')) {
    return first.split('/').pop()?.toLowerCase() ?? null;
  }
  if (first.startsWith('-')) return null;
  if (first.includes('$') || first.includes('{') || first.includes('}')) return null;
  // Git trailers / header lines (e.g. Assisted-by: Claude) are not shell commands.
  if (first.includes(':') && !/^https?:/i.test(first)) return null;

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
  const localFunctions = extractShellFunctionNames(content);
  const stripped = stripMultilineNodeE(stripHeredocs(content));

  for (const rawLine of stripped.split('\n')) {
    const commented = stripLineComment(rawLine).trim();
    if (!commented) continue;
    if (FUNCTION_DEF_RE.test(commented)) continue;
    const line = stripNestedShell(commented).trim();
    if (!line) continue;

    const segments = line.split(/&&|\|\||;|\|/);
    for (const segment of segments) {
      const name = firstCommandName(segment);
      if (!name || localFunctions.has(name)) continue;
      names.add(name);
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
  const localFunctions = extractShellFunctionNames(content);
  const errors = [];
  const seen = new Set();

  for (const name of extractExternalCommands(content)) {
    if (SHELL_BUILTINS.has(name) || allowed.has(name) || localFunctions.has(name)) continue;
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
