Draft an npm package onboarding recipe for the Calunga trusted-libraries pipeline.

Given a package identity ($ARGUMENTS or prompt for one), gather deterministic pre-recipe facts and classify whether the package matches the `tier-a-npm-pack-no-build-v1` template pattern.

Steps:
1. Validate the package identity matches `name@version` format.
2. Load pre-computed deterministic facts from `scripts/lib/facts.mjs`.
3. Classify the recipe pattern:
   - Tier A, no build step, npm-pack from git source → `tier-a-npm-pack-no-build-v1`
   - Anything else → `needs_human` with a reason and escalation target.
4. If drafted, emit a recipe-result JSON with:
   - `template_id`: only a reviewed template from the allowlist
   - `parameters`: bounded, typed values (no arbitrary paths or shell)
   - `evidence`: supporting facts from the deterministic inspection
   - `confidence`: numeric 0–1
   - `could_not_verify`: items that need human follow-up
5. Validate the result against `schemas/recipe-result.schema.json` and the post-recipe validator.
6. If valid and `drafted`, render output files using `scripts/lib/renderer.mjs` under `demo/output/fullsend/`.
7. Report the result. A `needs_human` is a successful bounded result, not a failure.

Constraints:
- source.ref must be the immutable commit SHA, not a mutable tag
- Never emit a `files` map, complete shell commands, or arbitrary paths
- Never treat a recipe draft as catalog availability
- Never approve, merge, promote, or publish
- Never acquire or use registry-write credentials
