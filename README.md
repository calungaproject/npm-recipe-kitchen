# npm-recipe-kitchen

PoC for safe npm package on-boarding through auditable recipe bundles.

## Current scope

This repository is the **recipe kitchen**: it investigates a supplied npm package candidate and drafts a deterministic, reviewable recipe bundle.

**In:** an ordered, static list of candidates supplied to this repository.
Each candidate is an exact package name and exact version (for example `semver@7.7.2`).
This repository consumes that order; it does not discover, score, or re-prioritize candidates.

**Out:** exactly one of two bounded results per candidate.

- `drafted` — validated recipe under `packages/<name>/<version>/` on **npm-registry** (PR opened there).
- `needs_human` — bounded refusal with reason; best-effort draft staged under `recipes/drafts/<name>/<version>/` on **this kitchen repo** for review-only PR. No npm-registry PR.
  `needs_human` is a successful, bounded outcome, not a failed run.

Between in and out sit two deterministic, non-model gates:

- **Validation** (`scripts/lib/recipe-validator.mjs`) checks a recipe-result against the schema, the trusted fact bundle, the template allowlist, the source-SHA match, and parameter safety before anything is rendered.
- **Rendering** (`scripts/lib/renderer.mjs`) turns a validated `drafted` result into the four fixed files, and refuses unsupported templates, arbitrary paths, shell injection, path traversal, symlinks, control characters, unknown parameters, oversized values, and `needs_human` input.

Every drafted bundle is then reviewed by a human before anything further happens.

## Facts: verified, on-demand fact bundles

Facts about a candidate are not a hand-maintained map.
For an **exact** npm identity (`name@1.2.3` or `@scope/name@1.2.3`) the on-demand collector (`scripts/lib/compute-facts.mjs`) produces a versioned, trusted **fact bundle** by inspecting real evidence, behind injected IO adapters (`scripts/lib/adapters/npm-adapters.mjs`) so the default test suite is hermetic.
Ranges, dist-tags, incomplete versions, and git/registry URLs are rejected as invalid identities — never coerced into a version.

### Two separate trust questions

The npm **artifact** and the **source** repository are distinct trust questions and are never conflated:

- **Artifact integrity** — the tarball bytes are downloaded under strict size/time limits and verified against `dist.integrity`; the tarball's own `package.json` and file list are inspected directly. Registry metadata is never treated as proof of tarball contents.
- **Source association** — `git ls-remote` resolves the version tag to an immutable commit. That mapping is `tag_only`: it proves tag→commit, **not** that the published tarball was built from that commit. This PoC accepts a `tag_only` association and records the unverified build provenance as a `could_not_verify` caveat on the bundle. Only cryptographically **verified provenance** establishes an authoritative `verified_provenance` link.

Provenance/signature statuses are recorded as `verified` / `unverified` / `absent` and are never asserted `verified` unless an adapter actually verified them; the default provenance adapter is intentionally conservative and never returns `verified`.

### Tier A eligibility

A bundle is Tier A eligible only from **inspected** evidence (both the pinned source checkout and the produced tarball), never from the mere absence of registry fields: no build/install lifecycle scripts, no `binding.gyp` or native artifacts, an unambiguous single entrypoint present in the tarball, at most one CLI bin (present in the tarball), and a packed name/version matching the request.
The CLI command name may differ from the bin file's basename, so it is carried explicitly and never guessed.

### Failure taxonomy (load-bearing)

- **Package / policy / input / blocked** outcomes are bounded: the collector returns a stable `reason_code` and the pre-script writes `facts_available: false`, exit 0, so the agent emits `needs_human` — a successful, bounded refusal.
  A missing/invalid **identity** is an `input_error` (never asks the model to fabricate an identity); a missing registry-contract SHA is `blocked`.
- **Operational** faults (timeout, DNS/TLS, HTTP 429/5xx, truncation/oversize, invalid JSON, unrelated child-process failure) throw `OperationalError` → the pre-script exits non-zero → the run **fails as retryable infrastructure**. Infra faults must never masquerade as `needs_human`.

### Runner-side enforcement (Gate 0)

The post-step (`scripts/lib/post-validate.mjs`, invoked by `post-recipe-validate.sh`) loads the **exact** fact bundle the pre-script produced — never a silently recomputed set — and both **validates against** and **renders from** it.
The model is authoritative only for a bounded `description` and its own evidence; every authoritative parameter (identity, source URL/ref/tag, upstream npm version, `has_cli`, CLI bin path/name incl. required absence, main entry, selected template) is re-derived from the bundle via `scripts/lib/fact-bundle.mjs`.
A `drafted` result is therefore impossible when facts are unavailable, the bundle is invalid, the model changed or omitted an authoritative value, or the selected template differs from the bundle's eligibility template.

### Registry contract and audit artifact

- The **registry-contract SHA** is a pinned, read-only Gate A input (`scripts/lib/registry-contract.mjs`), established out-of-band and validated as a full 40-hex commit SHA. It is never derived from npm metadata; when unavailable the collector blocks rather than inventing one. The kitchen only reads it — it never writes to `npm-registry`.
- The reviewed snapshot ships as `registry-contract/provenance.json`; the pre-script defaults `REGISTRY_CONTRACT_PROVENANCE` to it, and an out-of-band review may point that variable elsewhere. Without a wired contract the collector path can never run — every package would block with `REGISTRY_CONTRACT_UNAVAILABLE`.
- The exact fact bundle used for inference/validation is persisted as a reviewable, **kitchen-side** audit artifact (`recipes/audit/<name>/<version>/fact-bundle.json`). It is never part of the rendered recipe bundle that becomes a registry PR diff.

### Fullsend's restricted role

Fullsend (the sandboxed model) is restricted to **judgment**: given the trusted bundle and the template allowlist it selects a template (or emits `needs_human`). It never resolves identity, fetches facts, or produces authoritative values.

## Boundary: what this repository does NOT do

- It does **not** write to any registry, open a registry PR, promote, sign, build, or publish.
- It does **not** compute queue scores, popularity, or candidate priority.
- If provenance metadata such as `bundle.json` is ever retained, it is a kitchen-side artifact only and must never be included in a target registry PR.

## Templates and scripts are policy, not a model

The templates under `scripts/lib/templates/` and the deterministic scripts under `scripts/lib/` are **policy and validation mechanisms**.
They encode what a safe recipe is allowed to look like and reject everything else.
They are not a substitute for the model's investigation or drafting judgement, and the model's output is not trusted until these deterministic gates accept it.

## Local validation

Install and run the deterministic gate from a clean checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check
```

`npm test` runs the deterministic test suite (`node --test`): package facts, the recipe-result schema and semantic validator, the renderer and its rejection paths, the golden SemVer recipe, the registry contract, and the `drafted` / `needs_human` evaluation fixtures.
`npm run check` runs the config consistency gates (`.fullsend` role declarations and harness files).
CI runs both.

The internal modules are separated by responsibility (facts, validator, renderer, template) on purpose; each seam is independently tested.

## Fullsend

Fullsend drives the drafting run: the `npm-recipe-draft` harness in `.fullsend/` and the managed workflow in `.github/workflows/fullsend.yaml`.
A `/fs-onboard <name@version>` comment is handled by the `npm-recipe-onboard` job in `.github/workflows/fullsend.yaml`.

| Outcome | PR target | Token |
|---------|-----------|--------|
| `drafted` | `npm-registry` (or your fork → upstream PR) | `REGISTRY_PUSH_TOKEN` secret |
| `needs_human` | `npm-recipe-kitchen` (`recipes/drafts/…`) | Minted `PUSH_TOKEN` only — no personal PAT |

`REGISTRY_PUSH_TOKEN` is required only for `drafted` registry PRs.
Upstream `REGISTRY_REPO_FULL_NAME` is cloned anonymously when public (no PAT read).
For demos without upstream write access, set Actions variable `REGISTRY_PUSH_REPO_FULL_NAME` to your fork (e.g. `dperaza4dustbit/npm-registry`); each run clones upstream `main` fresh, pushes a new branch to your fork, and opens a cross-repo PR — no manual fork rebase required.
`kill_switch` in `.fullsend/config.yaml` disables all dispatch when set to `true`.
