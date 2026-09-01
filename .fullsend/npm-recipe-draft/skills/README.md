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

- Recipe files: `${RECIPE_PACKAGES_DIR:-/sandbox/workspace/target-repo/packages}/<name>/<version>/` (synced to runner `REPO_DIR` via SafeDownload)
- Status: `recipe-result.json` schema version 2 under `$FULLSEND_OUTPUT_DIR/`

Post-validate checks manifest schema + fact binding; no template renderer.

## Local review

```bash
fullsend run ...   # or issue comment /fs-onboard lodash@4.18.1
ls -la target-repo/packages/<name>/<version>/   # in sandbox after run
```

Audit artifacts: `recipes/audit/<name>/<version>/fact-bundle.json` (kitchen repo, gitignored).
