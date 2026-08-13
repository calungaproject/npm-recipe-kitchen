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

## Constraints

- Package identity, git URL, source SHA, and provenance state come from pre-computed deterministic facts.
- Do not invent or guess facts that were not provided.
- The agent does not have registry-write or publication credentials.
- Output is validated by a deterministic post-step before rendering.
- The agent writes output only to Fullsend's designated output directory.
