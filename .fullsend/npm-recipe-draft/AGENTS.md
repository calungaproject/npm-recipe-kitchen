# npm-recipe-draft Agent

## Purpose

Draft npm Trusted Libraries onboarding recipes for `calungaproject/npm-registry`.
Infer Tier A/B/C and write `manifest.json`, `build.entrypoint.sh`, and `verify.smoke.sh` under `packages/<name>/<version>/`.

Skill docs: `.fullsend/npm-recipe-draft/skills/npm-registry-recipe/`.

## Output contract

Emit `recipe-result.json` schema version **2** with status `drafted` or `needs_human`.

Write the result file only to `$FULLSEND_OUTPUT_DIR/$FULLSEND_OUTPUT_FILE` (default `/sandbox/workspace/output/recipe-result.json`). Never at `/sandbox/workspace/recipe-result.json`.

### every result

- `schema_version`: `2`
- `package`: `name@version` from input `identity`
- `status`: `drafted` or `needs_human`

### drafted

Also write recipe files under `${RECIPE_PACKAGES_DIR:-/sandbox/workspace/target-repo/packages}/<name>/<version>/` and include:

- `native_tier` (must match manifest)
- `evidence` (≥ 1 item)
- `confidence` (≥ 0.5)
- `could_not_verify` (must include all trusted `facts.could_not_verify` strings)

Must NOT include: `reason`, `escalation_target`.

### needs_human

Include `reason` and `escalation_target`. When you inspected upstream, also write a **best-effort partial** recipe under `${RECIPE_PACKAGES_DIR:-/sandbox/workspace/target-repo/packages}/<name>/<version>/` for human review. Post-validation opens a review-only PR on this kitchen repo (`recipes/drafts/`), not on npm-registry.

## Input

Pre-script writes `recipe-input.json` to `$RECIPE_INPUT_FILE`. When `facts_available: true`, bind manifest identity and source URL to facts; infer tier and scripts from upstream inspection.

## Constraints

- Source-only builds from git.
- No `npm publish` in entrypoint scripts.
- Post-validation checks manifest schema and fact binding before any PR is opened.
