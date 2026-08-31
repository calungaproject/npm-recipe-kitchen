# Tier classification guide

Classify before writing scripts. Wrong tier breaks factory assumptions and consumer install paths.

## Tier A — pure JS main package

**Definition:** A single `npm-package` output. No `@calunga/<name>-linux-x64` platform package. Consumers install only the main tarball from Pulp.

**Typical upstream signals:**

- No `optionalDependencies` pointing at `@scope/platform-*` or `prebuild` packages
- No `binding.gyp`, no published `.node` files
- Install lifecycle may exist but only for pure JS setup (still prefer stripping if it fetches binaries)

**Build strategies (pick one after inspecting repo):**

1. **Pack-only** — clone tag, `npm pack` from root (`lodash`)
2. **Build then pack** — `npm install --ignore-scripts` (or full install if needed), `npm run build`, then `npm pack` (`async`)
3. **Subpath / monorepo** — clone, `cd` to package dir inside repo, then pack (document path in evidence)

**Still Tier A even when:**

- Upstream has a `prepare` or `build` script that only compiles TypeScript/bundles JS
- Package has a CLI bin (`bin` field)

**Escalate (not Tier A) when:**

- `optionalDependencies` includes platform-specific packages (`@esbuild/linux-x64`, `sharp-libvips-*`, etc.)
- `install` script runs `node-gyp`, `prebuild-install`, or downloads arch-specific binaries
- Published tarball from a local `npm pack` would include `.node` native addons

## Tier B — platform optional family

**Definition:** Main JS wrapper + one TL-built `@calunga/<name>-linux-x64` package wired via `optionalDependencies`. Upstream often already splits binary and wrapper (esbuild, sharp-style).

**Typical upstream signals:**

- `optionalDependencies` with `@something/linux-x64` or similar
- `install.js` that resolves a platform package
- Prebuilt binary produced by Go/Rust/make in upstream repo (not node-gyp)

**Recipe responsibilities:**

1. Build or extract **linux-x64 glibc** binary from **git source** (e.g. `make platform-linux-x64`)
2. Pack platform tarball to `out/@calunga/<name>-linux-x64-<version>.tgz`
3. Stage main package: patch `optionalDependencies` to `@calunga/<name>-linux-x64@<version>`
4. Patch or replace `install.js` so it resolves the **TL** platform name from Pulp, not npmjs
5. Remove consumer compile paths (`prebuild-install`, `node-gyp`, `|| npm run build` fallbacks) from the **published** main `package.json`
6. Pack main tarball

**Naming:**

- `pulp_name` for platform: `@calunga/<unscoped-name>-linux-x64`
- Platform tarball path: `out/@calunga/<unscoped-name>-linux-x64-<version>.tgz`

**Canonical example:** `packages/esbuild/0.28.0/`

## Tier C — compile-heavy native

**Definition:** Main JS API + platform package, but the native artifact is **compiled in the TL factory** (typically node-gyp) from source — not vendored from upstream prebuild tarballs.

**Typical upstream signals:**

- `binding.gyp` or `node-gyp` in scripts
- `prebuild-install` in dependencies
- Native addon ends up at `build/Release/*.node`

**Recipe responsibilities:**

1. Clone source at `ref`, run upstream's compile command (`npm run build-release`, etc.) **in factory**
2. Place compiled `.node` in platform package (layout varies — match smoke expectations)
3. Stage slim main package: JS sources + TL `install.js` shim; strip `install`/`prepare` that would compile on consumer machines
4. Set `optionalDependencies` to `@calunga/<name>-linux-x64@<version>`
5. Ship `tl-install.js` copied into main tarball as `install.js` when upstream shim is not adaptable

**Canonical example:** `packages/better-sqlite3/11.8.1/` (`tl-install.js` + `verify.smoke.sh` ELF checks)

**Higher scrutiny:** Tier C recipes need explicit human review. Prefer `needs_human` if compile flags, toolchain version, or addon layout is unclear.

## Quick decision tree

```
Does the published package need a linux-x64 native binary at install time?
├─ No  → Tier A
└─ Yes → Is the binary built from source in factory (node-gyp, cargo, etc.)?
         ├─ Yes → Tier C
         └─ No  → Tier B (prebuild/make upstream binary from git, esbuild-style)
```

## Common misclassifications

| Package style | Wrong | Right |
| --- | --- | --- |
| TS lib with `npm run build` → JS | B or C | A |
| esbuild | C | B (Go binary via upstream make, not node-gyp) |
| better-sqlite3 | B | C (node-gyp compile in factory) |
| Package with only `prebuild` optional on npmjs | A | B |
