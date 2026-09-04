# Canonical recipe examples

Study these merged recipes in `calungaproject/npm-registry` (`packages/`). Clone or read via GitHub raw; registry-contract in npm-recipe-kitchen pins commit `017ebd5a3c5fef6d595f7c852fd584a7d5fae255`.

## Tier A

### lodash@4.18.1 — minimal pack

- **Path:** `packages/lodash/4.18.1/`
- **Pattern:** clone tag → `npm pack` → version check
- **Smoke:** `package/lodash.js`, `node --check`
- **Copy when:** single-package repo, no build step, dist already in tag

### async@3.2.6 — JS build before pack

- **Path:** `packages/async/3.2.6/`
- **Pattern:** clone → `npm install --include=dev --ignore-scripts` → `npm run build` → `npm pack`
- **Smoke:** `package/dist/async.js`
- **Copy when:** TypeScript/bundler produces `dist/` at build time but no native platform package

### express@4.22.0 / debug@4.4.3 / bluebird@3.7.2

- Additional Tier A variants in the same repo — compare when the target package is a dependency-heavy pure JS library.

## Tier B

### esbuild@0.28.0 — make + dual tarball

- **Path:** `packages/esbuild/0.28.0/`
- **Pattern:** `make platform-linux-x64` → patch `install.js` and `optionalDependencies` → tar-pack main + `@calunga/esbuild-linux-x64`
- **Smoke:** platform `bin/esbuild --version`
- **Copy when:** upstream Go/Rust binary built from repo; existing `@esbuild/linux-x64` optional dep

## Tier C

### better-sqlite3@11.8.1 — node-gyp + tl-install.js

- **Path:** `packages/better-sqlite3/11.8.1/`
- **Files:** `manifest.json`, `build.entrypoint.sh`, `verify.smoke.sh`, `tl-install.js`
- **Pattern:** `npm run build-release` → stage slim main + platform `.node` → install shim copies from `@calunga/better-sqlite3-linux-x64`
- **Smoke:** ELF check on `better_sqlite3.node`; main must not retain compile `install` script
- **Copy when:** `binding.gyp` / node-gyp addon compiled in factory

## Kitchen golden output (local)

Deterministic renderer output for semver (Tier A template era):

- `npm-recipe-kitchen/recipes/output/fullsend/semver/7.7.2/`

Use npm-registry examples for tier B/C and for Tier A packages that need a build step.

## Inference checklist (per package)

When reading an example to draft a new recipe, note:

1. What `source.ref` format upstream uses (`v1.2.3` vs `1.2.3`)
2. Where the packable tree lives (repo root vs `npm/` subdir)
3. Build command (`npm run build`, `make`, `npm run build-release`)
4. Platform binary path and platform `package.json` layout
5. Whether `install.js` is patched in place or replaced via `tl-install.js`
6. Which tarball members smoke asserts (drives entrypoint staging)
