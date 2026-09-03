# npm-recipe-draft Agent

## Purpose

Draft npm Trusted Libraries onboarding recipes for `calungaproject/npm-registry`.
Infer Tier A/B/C and write `manifest.json`, `build.entrypoint.sh`, and `verify.smoke.sh` under `packages/<name>/<version>/`.

Skill docs: `.fullsend/npm-recipe-draft/skills/npm-registry-recipe/`.

## Output contract

Emit `recipe-result.json` schema version **2** with status `drafted` or `needs_human`.

### every result

- `schema_version`: `2`
- `package`: `name@version` from input `identity`
- `status`: `drafted` or `needs_human`
- Full recipe files under `packages/<name>/<version>/` (required for both statuses)

### drafted

Also include:

- `native_tier` (must match manifest)
- `evidence` (≥ 1 item)
- `confidence` (≥ 0.5)
- `could_not_verify` (must include all trusted `facts.could_not_verify` strings)

### needs_human

Include `reason` and `escalation_target`. Same recipe files as `drafted`. Kitchen pushes to npm-registry **fork** and posts a manual upstream PR link — no auto PR.

## Input

Pre-script writes `recipe-input.json` with `facts_available: true`. If fact collection fails, the run aborts before you start.

## Constraints

- Source-only builds from git.
- No `npm publish` in entrypoint scripts.
- Post-validation checks manifest schema and fact binding before any registry push.
