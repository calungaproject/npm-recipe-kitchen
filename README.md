# npm-recipe-kitchen

PoC for safe npm package on-boarding through auditable recipe bundles.

## Current scope

This repository is the **recipe kitchen**: it investigates a supplied npm package candidate and drafts a deterministic, reviewable recipe bundle.

**In:** Agent 1 (`npm-priority-queue`) ranks candidates from TL closure index + npm popularity, or an explicit `/fs-onboard` comment for a single package.
Each candidate is an exact package name and exact version (for example `semver@7.7.2`).

**Out:** exactly one of two bounded results per candidate (Agent 2).

- `drafted` — facts collected, agent confident → npm-registry fork + upstream PR (today’s auto path).
- `needs_human` — facts collected, agent wrote a **best-effort** recipe but is not confident → issue comment + fork push + **manual** upstream PR link. No kitchen draft PR.
- Fact collection failure → **run fails**; pre-script comments on the issue (agent never starts).

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

- **Package / policy / input / blocked** outcomes **fail the run** before the agent starts. The pre-script posts an issue comment with `reason_code` and detail, then exits non-zero.
- **Operational** faults (timeout, DNS/TLS, HTTP 429/5xx, truncation/oversize, invalid JSON, unrelated child-process failure) throw `OperationalError` → the pre-script exits non-zero → retryable infrastructure failure.

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

- It does **not** write to any registry, open a registry PR, promote, sign, build, or publish (Agent 2 defers registry PR to a follow-up job).
- Agent 1 scores and queues candidates; Agent 2 does not re-score the global queue.
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

See [docs/demo-end-to-end-flow.md](docs/demo-end-to-end-flow.md) for a concise walkthrough of recipes, both agents, and the Konflux → Pulp factory path (demo-oriented).

Fullsend drives two agents in sequence:

| Agent | Name | Trigger | Output |
|-------|------|---------|--------|
| **1** | `npm-priority-queue` | [`npm-priority-queue` workflow](.github/workflows/npm-priority-queue.yaml) (cron + manual) | Issues + `/fs-onboard` comments |
| **2** | `npm-recipe-draft` | `/fs-onboard <name@version>` issue comment | Recipe bundle PR |

### Agent 1: priority queue

Workflow **Actions → npm-priority-queue → Run workflow**:

- `top_n` (default `5`) — how many packages to queue
- `dry_run` — score and validate without creating GitHub issues (no tracker or onboard issues)

The pre-script pulls `npm-closure-index` from Quay, lists packages on the [TL npm registry](https://packages.redhat.com/api/pulp-content/public-trusted-libraries/javascript/), scores **60% closure / 40% popularity**, and passes a shortlist to the model. The post-script opens one issue per selected candidate (labels `npm-priority-candidate`, `npm-onboard`) and posts `/fs-onboard name@version` so Agent 2 runs automatically.

### Agent 2: recipe draft

A `/fs-onboard <name@version>` comment is handled by the `npm-recipe-onboard-*` jobs in `.github/workflows/fullsend.yaml`, which call upstream `reusable-dispatch` so token minting uses the enrolled fullsend workflow identity.

| Outcome | What happens |
|---------|----------------|
| **Fact collection fails** | Run **fails**. Issue comment with `reason_code` + detail. Agent does not run. |
| **`drafted`** | Fork push + auto upstream PR on `npm-registry` |
| **`needs_human`** | Issue comment with reason + fork push + manual PR link (no auto upstream PR) |

Before any registry push, CI parses the pinned **npm-builder Containerfile** and rejects recipe scripts that call commands not derived from it. Post-validation also enforces **`facts.factory`** (install line with `--include=dev` when builds need devDependencies, monorepo `package_dir`, and `needs_human` when pnpm/`workspace:` blockers are present). The **npm-registry on-pr** pipeline runs the real factory build — kitchen does not run npm-builder locally.

`REGISTRY_PUSH_TOKEN` is required for registry fork pushes (`drafted` and `needs_human` with recipe files).
Upstream `REGISTRY_REPO_FULL_NAME` is cloned anonymously when public (no PAT read).
For demos without upstream write access, set the **repository variable** `REGISTRY_PUSH_REPO_FULL_NAME` to your fork (e.g. `dperaza4dustbit/npm-registry` under Settings → Secrets and variables → Actions → Variables). The `npm-recipe-registry-publish` job reads that variable at publish time — it is not injected into the harness agent environment during the run.

Fork demo PAT scopes:

- **Git push** to your fork: `REGISTRY_PUSH_TOKEN` with **Contents: Read and write** on the fork (fine-grained scoped to the fork is fine).
- **Open upstream PR** on `calungaproject/npm-registry`: set **`REGISTRY_PR_TOKEN`** (or reuse `REGISTRY_PUSH_TOKEN`) with **Pull requests: Read and write** on `calungaproject/npm-registry`. A fine-grained PAT scoped only to your fork cannot `createPullRequest` on upstream.

### Hook up registry tokens (when org PAT is approved)

1. Create or reuse a fine-grained PAT (resource owner `calungaproject`):
   - **Repository access:** your fork (e.g. `dperaza4dustbit/npm-registry`) for push; add `calungaproject/npm-registry` if one token should open upstream PRs.
   - **Permissions:** Contents Read and write (fork); Pull requests Read and write (upstream, for `REGISTRY_PR_TOKEN`).
2. Org admin approves pending token: `https://github.com/organizations/calungaproject/settings/personal-access-token-requests`
3. Authorize SSO on the token if prompted (Developer settings → Fine-grained tokens → Configure SSO).
4. On **`calungaproject/npm-recipe-kitchen`** → Settings → Secrets and variables → Actions:
   - **`REGISTRY_PUSH_TOKEN`** — PAT that can push recipe branches to your fork.
   - **`REGISTRY_PR_TOKEN`** (optional) — PAT that can open PRs on `calungaproject/npm-registry`.
5. Set repository **variable** `REGISTRY_PUSH_REPO_FULL_NAME` to your fork (e.g. `dperaza4dustbit/npm-registry`).

`drafted` outcomes: fork push + automatic upstream PR (or compare link on failure).
`needs_human` with recipe files: fork push + compare link only (human opens upstream PR after review).

If PR creation still fails, the publish job posts a compare link on the kitchen issue after a successful fork push.
The publish job downloads the `fullsend-npm-recipe-draft` artifact uploaded by the fullsend composite action (v0.37.0) in the upstream `Dispatch` harness run.
`kill_switch` in `.fullsend/config.yaml` disables all dispatch when set to `true`.
