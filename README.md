# npm-recipe-kitchen

PoC for safe npm package on-boarding through auditable recipe bundles.

## Current scope

This repository is the **recipe kitchen**: it investigates a supplied npm package candidate and drafts a deterministic, reviewable recipe bundle.
The focused slice implemented here has a deliberately narrow boundary.

**In:** an ordered, static list of candidates supplied to this repository.
Each candidate is an exact package name and exact version (for example `semver@7.7.2`).
This repository consumes that order; it does not discover, score, or re-prioritize candidates.

**Out:** exactly one of two bounded results per candidate.

- `drafted` — a recipe bundle of four fixed files (`manifest.json`, `build.entrypoint.sh`, `verify.smoke.sh`, `evidence.md`) plus review evidence.
- `needs_human` — evidence only, with **no** rendered recipe files and **no** patch.
  `needs_human` is a successful, bounded refusal, not a failed run.

Between in and out sit two deterministic, non-model gates:

- **Validation** (`scripts/lib/recipe-validator.mjs`) checks a recipe-result against the schema, the known package facts, the template allowlist, the source-SHA match, and parameter safety before anything is rendered.
- **Rendering** (`scripts/lib/renderer.mjs`) turns a validated `drafted` result into the four fixed files, and refuses unsupported templates, arbitrary paths, shell injection, path traversal, symlinks, control characters, unknown parameters, oversized values, and `needs_human` input.

Every drafted bundle is then reviewed by a human before anything further happens.

## Boundary: what this repository does NOT do

- It does **not** write to any registry, open a registry PR, promote, sign, build, or publish.
- It does **not** compute compliance, queue scores, popularity, or candidate priority.
  Those are owned elsewhere and are parked on other branches; they are intentionally excluded from this slice.
- If provenance metadata such as `bundle.json` is ever retained, it is a kitchen-side artifact only and must never be included in a target registry PR.

## Templates and scripts are policy, not a model

The templates under `scripts/lib/templates/` and the deterministic scripts under `scripts/lib/` are **policy and validation mechanisms**.
They encode what a safe recipe is allowed to look like and reject everything else.
They are not a substitute for the model's investigation or drafting judgement, and the model's output is not trusted until these deterministic gates accept it.

## Local validation

Install and run the deterministic gate from a clean checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`npm run check` runs the full deterministic test suite (`node --test`): package facts, the recipe-result schema and semantic validator, the renderer and its rejection paths, the golden SemVer recipe, the registry-contract snapshot, and the `drafted` / `needs_human` evaluation fixtures.
`npm test` runs the same suite; CI runs both.

The internal modules are separated by responsibility (facts, validator, renderer, template) on purpose; each seam is independently tested.

## Fullsend

Fullsend orchestration in `.fullsend/` and the managed workflow in `.github/workflows/fullsend.yaml` remain installed but **inactive**: `kill_switch: true` is set in `.fullsend/config.yaml`.
Activation is a separate, explicitly authorized step and is not part of preparing this repository.
