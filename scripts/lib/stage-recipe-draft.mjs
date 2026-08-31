// Stage a kitchen-side draft recipe directory for needs_human review PRs.
//
// Copies best-effort agent output from the registry sandbox into
// recipes/drafts/<name>/<version>/ on the kitchen repo checkout.

import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseNpmIdentity } from './compute-facts.mjs';
import { recipeDraftRelDir, resolveRecipeDraftDir } from './recipe-bundle.mjs';

/**
 * @param {object} opts
 * @param {string} opts.kitchenRoot
 * @param {string} opts.identity
 * @param {string} [opts.draftSourceDir]
 * @param {string} [opts.resultPath]
 * @param {string} [opts.auditPath]
 * @param {string} [opts.reason]
 * @returns {{ draftDir: string, draftRel: string }}
 */
export function stageRecipeDraft({
  kitchenRoot,
  identity,
  draftSourceDir = '',
  resultPath = '',
  auditPath = '',
  reason = '',
}) {
  const parsed = parseNpmIdentity(identity);
  if (!parsed?.valid) {
    throw new Error(`invalid npm identity for draft staging: ${JSON.stringify(identity)}`);
  }

  const draftDir = resolveRecipeDraftDir(kitchenRoot, parsed.name, parsed.version);
  const draftRel = recipeDraftRelDir(parsed.name, parsed.version);
  mkdirSync(draftDir, { recursive: true });

  if (draftSourceDir && existsSync(draftSourceDir)) {
    cpSync(draftSourceDir, draftDir, { recursive: true, force: true });
  }

  if (resultPath && existsSync(resultPath)) {
    cpSync(resultPath, join(draftDir, 'recipe-result.json'), { force: true });
  }

  if (auditPath && existsSync(auditPath)) {
    cpSync(auditPath, join(draftDir, 'fact-bundle.audit.json'), { force: true });
  }

  const review = `# Recipe draft (review only)

This PR stages a **draft** recipe for \`${identity}\`. It is **not** an npm-registry onboarding PR.
Human review is required before promoting files to \`calungaproject/npm-registry\`.

## Reason for needs_human

${reason.trim() || '(no reason provided)'}

## Next steps

1. Review manifest, build entrypoint, and verify scripts (if present).
2. Fix gaps and re-run \`/fs-onboard ${identity}\` or manually promote to npm-registry.
`;

  writeFileSync(join(draftDir, 'REVIEW.md'), review, 'utf-8');

  return { draftDir, draftRel };
}
