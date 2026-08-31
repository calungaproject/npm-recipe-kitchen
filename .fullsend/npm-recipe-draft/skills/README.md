# Agent 2 skills — npm-registry recipe drafting

Skills for the **npm-recipe-draft** Fullsend agent (Tier A/B/C, LLM-authored recipes).

## Layout

```text
skills/npm-registry-recipe/
  SKILL.md
  tier-guide.md
  manifest.md
  build-entrypoint.md
  verify-smoke.md
  examples.md
```

## Wiring

Enabled via `@skills/...` includes in `.fullsend/npm-recipe-draft/CLAUDE.md`.

Agent output:

- Recipe files: `packages/<name>/<version>/` in the target repo working tree (`$REPO_DIR`)
- Status: `recipe-result.json` schema version 2

Post-validate checks manifest schema + fact binding; no template renderer.

## Local review

```bash
fullsend run ...   # or issue comment /fs-onboard lodash@4.18.1
ls -la packages/<name>/<version>/
```

Audit artifacts: `recipes/audit/<name>/<version>/fact-bundle.json` (kitchen repo, gitignored).
