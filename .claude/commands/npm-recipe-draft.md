Draft an npm package onboarding recipe for the Calunga trusted-libraries pipeline.

Given a package identity ($ARGUMENTS or prompt for one), classify whether it matches the `tier-a-npm-pack-no-build-v1` template and emit a recipe-result.

Facts are not gathered here: the deterministic collector (`scripts/lib/compute-facts.mjs`, run by the pre-script outside the sandbox) produces a trusted fact bundle. Classification consumes those facts; it never re-derives or invents them.

Steps:
1. Validate the package identity matches `name@version` format.
2. Read the trusted fact bundle for the package (identity, git URL, source SHA, provenance, upstream CLI/build evidence).
3. Classify the recipe pattern:
   - Tier A, no build step, npm-pack from git source → `tier-a-npm-pack-no-build-v1`
   - Anything else, or facts unavailable → `needs_human` with a reason and escalation target.
4. If drafted, emit a recipe-result JSON with:
   - `template_id`: only a reviewed template from the allowlist
   - `parameters`: bounded, typed values bound verbatim to the facts (no arbitrary paths or shell)
   - `evidence`: supporting facts from the deterministic inspection
   - `confidence`: numeric 0–1
   - `could_not_verify`: items that need human follow-up
5. Validate the result with the deterministic gate (`scripts/lib/post-validate.mjs`), which re-checks it against the schema, fact bundle, and template allowlist and renders the bundle with `scripts/lib/renderer.mjs` under `recipes/output/fullsend/`.
6. Report the result. A `needs_human` is a successful bounded result, not a failure.

Constraints:
- source_ref must be the immutable commit SHA, not a mutable tag
- Never emit a `files` map, complete shell commands, or arbitrary paths
- Never treat a recipe draft as catalog availability
- Never approve, merge, promote, or publish
- Never acquire or use registry-write credentials
