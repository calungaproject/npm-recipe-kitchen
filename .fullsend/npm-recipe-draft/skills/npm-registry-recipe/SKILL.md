---
name: npm-registry-recipe
description: >-
  Draft npm Trusted Libraries onboarding recipes (manifest.json, build.entrypoint.sh,
  verify.smoke.sh) for calungaproject/npm-registry under packages/<name>/<version>/.
  Covers Tier A/B/C classification, source-only builds, platform optional packages,
  and TL install shims. Use when drafting npm TL recipes, onboarding packages to
  npm-registry, or inferring build/smoke scripts from upstream source.
---

# npm-registry recipe authoring

Draft a **complete recipe** for one `name@version` in the Calunga npm Trusted Libraries registry.

## Deliverable

Write exactly these files under `${RECIPE_PACKAGES_DIR:-/sandbox/workspace/target-repo/packages}/<name>/<version>/`:

```text
target-repo/packages/<name>/<version>/
  manifest.json           # required
  build.entrypoint.sh     # required, executable
  verify.smoke.sh         # required, executable
  tl-install.js           # optional — Tier B/C when upstream has no small shim to adapt
```

Do **not** write under `/sandbox/workspace/packages/` (outside the target-repo mount).

Do **not** create `out/` (factory output, gitignored). Do **not** author `compliance_level`, `missing_gaps`, or `pending_l3_gaps` — CI computes those on push.

## Hard rules

1. **Build from git source** at `manifest.source.ref` — never download or repack from registry.npmjs.org.
2. **`build.entrypoint.sh` writes only to `OUT_DIR`** — no `npm publish`, no cosign keys, no secret exfiltration.
3. **One manifest → one factory run → every `outputs[]` path** must exist after build (Tier B/C: main + platform).
4. **Platform packages use `@calunga/<unscoped-name>-linux-x64`** at the same version as the main package.
5. **Treat merged recipes as immutable** — fixes ship as a new version directory.
6. **Use only npm-builder commands** — derive from `plumbing/npm-builder/Containerfile` (see [npm-builder-containerfile.md](npm-builder-containerfile.md)). Post-validation parses the pinned snapshot; Konflux on-pr runs the real build.

Factory env vars (always available in entrypoint/smoke):

| Var | Meaning |
| --- | --- |
| `MANIFEST_PATH` | Absolute path to this recipe's `manifest.json` |
| `OUT_DIR` | Writable output root (maps `out/` paths in manifest) |
| `WORK_DIR` | Scratch space for clones and staging |

Read manifest fields with `jq`. Resolve `out/foo.tgz` as `${OUT_DIR}/foo.tgz` (strip the `out/` prefix).

## Workflow

1. **Identify** `name`, `version`, scoped vs unscoped npm name.
2. **Find authoritative source** — prefer the git repo linked from npm `repository` or known upstream; pin `source.ref` to the tag/commit that produces the requested npm version.
3. **Classify tier** — see [tier-guide.md](tier-guide.md). When unsure, prefer `needs_human` over guessing native layout.
4. **Inspect upstream** — `package.json` scripts, `optionalDependencies`, `binding.gyp`, monorepo layout, prebuild vs compile paths, install shims.
5. **Draft `manifest.json`** — see [manifest.md](manifest.md). Match `docs/manifest.schema.json` in npm-registry.
6. **Draft `build.entrypoint.sh`** — see [build-entrypoint.md](build-entrypoint.md). Copy patterns from the closest canonical example.
7. **Draft `verify.smoke.sh`** — see [verify-smoke.md](verify-smoke.md). Assert tarball layout, version, and tier-specific invariants.
8. **Self-check** — manifest paths match script outputs; `optional_dependencies_published` matches platform package; no consumer `install`/`prepare` that runs node-gyp or prebuild-install on Tier B/C main tarball.

## Tier decision (summary)

| Tier | When | Outputs |
| --- | --- | --- |
| **A** | Pure JS artifact from git; no linux-x64 platform package | 1× `npm-package` |
| **B** | Upstream ships optional platform family (esbuild-style); TL rebuilds or vendors linux-x64 binary | main + `tl-platform-package` |
| **C** | Native addon compiled in factory (node-gyp, etc.) | main + `tl-platform-package` |

**Tier A nuance:** `npm run build` for JS bundling/transpile is still Tier A if there is no platform optional and no consumer native compile. See `async@3.2.6` in npm-registry.

**Not Tier A:** `binding.gyp`, `.node` in published tree, `prebuild-install`, install scripts that download binaries, multiple platform optionals, or monorepo paths you cannot map confidently.

## Canonical examples (read these)

In `calungaproject/npm-registry` at `packages/`:

| Package | Tier | Why read it |
| --- | --- | --- |
| `lodash/4.18.1` | A | Minimal `npm pack` from tag |
| `async/3.2.6` | A | `npm install` + `npm run build` before pack |
| `esbuild/0.28.0` | B | Upstream make + dual tarball + install.js patch |
| `better-sqlite3/11.8.1` | C | node-gyp compile + `tl-install.js` shim |

Full pointers: [examples.md](examples.md).

Proposal background (factory model, L1–L3, install policy): `npm-registry/docs/proposal-npm-lightwell-onboarding.md`.

## Using pre-collected facts

When `recipe-input.json` is present, treat `facts` as authoritative for:

- package identity, git URL, commit SHA, tag
- upstream `main_entry`, CLI layout, provenance flags
- `could_not_verify` gaps (carry into evidence; do not silently ignore)

You still **infer** tier, build commands, staging layout, smoke checks, and manifest `description` from upstream inspection.

If you are **not confident** the recipe is production-ready, emit `needs_human` with `reason` — but still write the **full** recipe under `packages/<name>/<version>/`. Kitchen pushes it to an npm-registry fork and posts a manual upstream PR link.

## Confidence and escalation

Emit `needs_human` when:

- Source repo or tag for the requested version cannot be verified
- Monorepo layout is ambiguous (multiple publishable packages)
- Native layout does not match A/B/C patterns you can implement safely
- Upstream requires network/tooling outside the npm-builder image without a documented path
- Multiple linux platform optionals or non-x64 targets are required

When drafting, include a short `evidence.md` (optional locally) listing: repo URL, ref, files inspected, tier rationale, and commands chosen.

## Additional resources

- [npm-builder-containerfile.md](npm-builder-containerfile.md) — derive available commands from the factory Containerfile
- [tier-guide.md](tier-guide.md) — classification detail
- [manifest.md](manifest.md) — field-by-field manifest guide
- [build-entrypoint.md](build-entrypoint.md) — entrypoint patterns and helpers
- [verify-smoke.md](verify-smoke.md) — smoke test patterns
- [examples.md](examples.md) — example index and what to copy
