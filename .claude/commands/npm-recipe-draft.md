# npm-recipe-draft

Given a package identity ($ARGUMENTS or prompt for one), draft a full npm-registry recipe (Tier A/B/C).

1. Read skills under `.fullsend/npm-recipe-draft/skills/npm-registry-recipe/`.
2. Run the fact collector pre-step (or read `recipe-input.json` if present).
3. Write recipe files under `${RECIPE_PACKAGES_DIR:-/sandbox/workspace/target-repo/packages}/<name>/<version>/`:
   - `manifest.json`
   - `build.entrypoint.sh`
   - `verify.smoke.sh`
   - optional `tl-install.js` for Tier C
4. Write `recipe-result.json` schema version 2 (`drafted` or `needs_human`).
5. Validate with `scripts/lib/post-validate.mjs` (manifest schema + fact binding).
