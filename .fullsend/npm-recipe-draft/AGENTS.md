# npm-recipe-draft Agent

## Purpose

Draft npm package onboarding recipes for the Calunga trusted-libraries pipeline.
Classify whether a package matches the `tier-a-npm-pack-no-build-v1` template.

## Allowed template IDs

- `tier-a-npm-pack-no-build-v1` — Tier A, pure JavaScript, no compile/build step, npm-pack from git source

## Output contract

Emit a JSON object conforming to `schemas/recipe-result.schema.json` with status `drafted` or `needs_human`.

### drafted output

Must include: `template_id`, `parameters`, `evidence`, `confidence`, `could_not_verify`.
Must NOT include: `reason`, `escalation_target`.

### needs_human output

Must include: `reason`, `escalation_target`.
Must NOT include: `template_id`, `parameters`, `evidence`, `confidence`, `could_not_verify`.

## Input

The pre-script (`pre-recipe-facts.sh`, runs outside the sandbox with credentials
the agent lacks) resolves the target package and writes the pre-computed
deterministic facts to a JSON file copied into the sandbox at
`$RECIPE_INPUT_FILE` (`/sandbox/workspace/recipe-input.json`). The agent reads
that file for identity, git URL, source SHA, provenance, and upstream evidence.
When `facts_available` is `false`, the agent emits `needs_human`.

## Constraints

- Package identity, git URL, source SHA, and provenance state come from the pre-computed deterministic facts in `$RECIPE_INPUT_FILE`.
- Do not invent or guess facts that were not provided.
- The agent does not have registry-write or publication credentials.
- Output is validated by a deterministic post-step before rendering.
- The agent writes output only to Fullsend's designated output directory.
