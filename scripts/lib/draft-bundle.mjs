import {
  mkdirSync, readFileSync, writeFileSync, rmSync, openSync, writeSync, closeSync,
  constants as fsConstants,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { render, FIXED_FILENAMES } from './renderer.mjs';
import { validateRecipeResult, validateNeedsHumanResult } from './recipe-validator.mjs';

// Joins a validated Fullsend recipe result to a read-only registry snapshot and produces a
// reviewable local handoff bundle: rendered recipe files, provenance/hashes, and an unapplied
// apply.patch targeting packages/<name>/<version>/. It changes no registry checkout and applies
// nothing. A needs_human result yields an evidence bundle with no invented files and no patch.

export const DEFAULT_BUNDLE_BASE = 'demo/output/draft-bundle';
const NOT_APPLIED_NOTE =
  'PROPOSAL ONLY: these files have not been built, promoted, applied, or merged to npm-registry.';

export class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleError';
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function splitIdentity(identity) {
  const at = identity.lastIndexOf('@');
  if (at <= 0) throw new BundleError(`invalid package identity: ${identity}`);
  return { name: identity.slice(0, at), version: identity.slice(at + 1) };
}

function assertUnderBase(dir, base) {
  const nd = resolve(dir);
  const nb = resolve(base);
  if (nd !== nb && !nd.startsWith(nb + '/')) {
    throw new BundleError(`bundle output ${nd} escapes allowed base ${nb}`);
  }
}

function writeFileExclusive(path, content, mode) {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
  try {
    writeSync(fd, content, 0, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

// Emits a git-applyable unified diff that creates one new file from /dev/null.
function newFilePatch(repoRelPath, content, mode) {
  const endsWithNewline = content.endsWith('\n');
  const body = endsWithNewline ? content.slice(0, -1) : content;
  const lines = body.length === 0 && endsWithNewline ? [''] : body.split('\n');
  let out = '';
  out += `diff --git a/${repoRelPath} b/${repoRelPath}\n`;
  out += `new file mode ${mode}\n`;
  out += `--- /dev/null\n`;
  out += `+++ b/${repoRelPath}\n`;
  out += `@@ -0,0 +1,${lines.length} @@\n`;
  for (const line of lines) out += `+${line}\n`;
  if (!endsWithNewline) out += `\\ No newline at end of file\n`;
  return out;
}

function modeFor(filename) {
  return filename.endsWith('.sh') ? '100755' : '100644';
}

function octalFor(filename) {
  return filename.endsWith('.sh') ? 0o755 : 0o644;
}

function stableJson(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Render a draft handoff bundle.
 *
 * Options:
 *   - recipeResult     (required): a validated Fullsend recipe result (drafted or needs_human)
 *   - registrySnapshot (required): the registry-snapshot document from snapshot-registry
 *   - repoRoot         (required): kitchen repo root; the allowlisted renderer stages under it
 *   - now              (required): injected ISO timestamp for generated_at (byte-stable runs)
 *   - bundleBaseRel    (optional): output base relative to repoRoot
 *   - expectedFacts    (optional): deterministic facts to cross-check the model output against
 */
export function renderDraftBundle({
  recipeResult,
  registrySnapshot,
  repoRoot,
  now,
  bundleBaseRel = DEFAULT_BUNDLE_BASE,
  expectedFacts,
}) {
  if (!recipeResult || typeof recipeResult !== 'object') {
    throw new BundleError('recipeResult must be an object');
  }
  if (!registrySnapshot || typeof registrySnapshot !== 'object') {
    throw new BundleError('registrySnapshot must be an object');
  }
  if (!repoRoot) throw new BundleError('repoRoot is required');
  if (!now) throw new BundleError('now (injected clock) is required for byte-stable output');

  const status = recipeResult.status;
  if (status !== 'drafted' && status !== 'needs_human') {
    throw new BundleError(`unsupported recipe result status: ${status}`);
  }

  // Treat the model output as untrusted: validate before doing anything with it.
  const check =
    status === 'drafted'
      ? validateRecipeResult(recipeResult, expectedFacts)
      : validateNeedsHumanResult(recipeResult);
  if (!check.valid) {
    throw new BundleError(
      `recipe result failed validation: ` +
        check.errors.map((e) => `${e.check || 'semantic'} ${e.path || ''} ${e.message}`.trim()).join('; '),
    );
  }

  const { name, version } = splitIdentity(recipeResult.package);

  const bundleBase = resolve(repoRoot, bundleBaseRel);
  const outDir = join(bundleBase, name, version);
  assertUnderBase(outDir, bundleBase);

  // Never silently overwrite a previous run's directory; recreate deterministically.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const alreadyInRegistry = registrySnapshot.recipes.some((r) => r.identity === recipeResult.package);

  const evidenceSummary = (recipeResult.evidence || []).map((e) => `[${e.kind}] ${e.detail}`);

  const bundleMeta = {
    schema_version: 1,
    kind: 'draft-handoff-bundle',
    status,
    generated_at: now,
    target_repository: registrySnapshot.repository,
    target_commit: registrySnapshot.commit_sha,
    package: recipeResult.package,
    already_present_in_registry_snapshot: alreadyInRegistry,
    confidence: recipeResult.confidence ?? null,
    evidence_summary: evidenceSummary,
    could_not_verify: recipeResult.could_not_verify || [],
    recipe_result: recipeResult,
    notes: [NOT_APPLIED_NOTE],
  };

  if (status === 'needs_human') {
    // A refusal produces evidence only: no invented recipe files and no patch.
    bundleMeta.reason = recipeResult.reason ?? null;
    bundleMeta.escalation_target = recipeResult.escalation_target ?? null;
    bundleMeta.files = [];
    bundleMeta.apply_patch = null;
    writeFileExclusive(join(outDir, 'bundle.json'), stableJson(bundleMeta), 0o644);
    return { status, output_dir: outDir, files: [], patch: null, already_present_in_registry_snapshot: alreadyInRegistry };
  }

  // drafted: stage files through the existing allowlisted deterministic renderer.
  // The renderer owns all shell text and enforces traversal/symlink/allowlist defenses.
  const rendered = render(recipeResult, repoRoot);

  const relDir = `packages/${name}/${version}`;
  const pkgDir = join(outDir, relDir);
  assertUnderBase(pkgDir, bundleBase);
  mkdirSync(pkgDir, { recursive: true });

  const fileEntries = [];
  let patch = '';
  for (const filename of FIXED_FILENAMES) {
    const content = readFileSync(join(rendered.output_dir, filename), 'utf-8');
    writeFileExclusive(join(pkgDir, filename), content, octalFor(filename));
    fileEntries.push({ path: `${relDir}/${filename}`, sha256: sha256(content) });
    patch += newFilePatch(`${relDir}/${filename}`, content, modeFor(filename));
  }

  bundleMeta.template_id = recipeResult.template_id;
  bundleMeta.files = fileEntries;
  bundleMeta.apply_patch = 'apply.patch';

  writeFileExclusive(join(outDir, 'apply.patch'), patch, 0o644);
  writeFileExclusive(join(outDir, 'bundle.json'), stableJson(bundleMeta), 0o644);

  return {
    status,
    output_dir: outDir,
    staged_dir: rendered.output_dir,
    files: fileEntries.map((f) => f.path),
    patch: join(outDir, 'apply.patch'),
    already_present_in_registry_snapshot: alreadyInRegistry,
  };
}
