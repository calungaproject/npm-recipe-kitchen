# build.entrypoint.sh patterns

Every entrypoint starts with:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${MANIFEST_PATH:?MANIFEST_PATH required}"
: "${OUT_DIR:?OUT_DIR required}"
: "${WORK_DIR:?WORK_DIR required}"
```

Read manifest:

```bash
VERSION="$(jq -r .version "${MANIFEST_PATH}")"
SOURCE_URL="$(jq -r .source.url "${MANIFEST_PATH}")"
SOURCE_REF="$(jq -r .source.ref "${MANIFEST_PATH}")"
MAIN_TGZ_REL="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "${MANIFEST_PATH}")"
main_tgz="${OUT_DIR}/${MAIN_TGZ_REL#out/}"
```

Helper — map manifest `out/...` paths to filesystem:

```bash
path_under_out() {
    local rel="$1"
    echo "${OUT_DIR}/${rel#out/}"
}
```

Helper — assert tarball member exists (use in all tiers):

```bash
assert_tgz_has_member() {
    local tgz="$1" member="$2"
    tar -xOf "${tgz}" "${member}" >/dev/null 2>&1 || {
        echo "[build.entrypoint] ${tgz} missing ${member}" >&2
        tar tf "${tgz}" >&2 || true
        exit 1
    }
}
```

**Do not use `file(1)`** in error paths — it is not installed in npm-builder. Use `tar tf "${tgz}" >&2 || true` only.

## Tier A — pack-only

1. `git clone --depth 1 --branch "${SOURCE_REF}" "${SOURCE_URL}" "${WORK_DIR}/src"`
2. `cd` to package root (monorepo: correct subdir)
3. `npm pack --quiet` → move to `main_tgz`
4. Assert `package/package.json` and main entry file exist
5. Assert packed version == `VERSION`

Reference: `npm-registry/packages/lodash/4.18.1/build.entrypoint.sh`

## Tier A — build then pack

Same as pack-only, but after clone (and `cd` into `facts.source.package_dir` when not `"."`):

```bash
npm install --include=dev --ignore-scripts   # use facts.factory.install_command when has_build_step
npm run build                  # or upstream's documented build command
```

Then `npm pack`. Assert dist/output files referenced in smoke (e.g. `package/dist/async.js`).

**Why `--include=dev`:** npm-builder sets `NODE_ENV=production`, which omits devDependencies from a plain `npm install` (TypeScript, babel, etc.).

Reference: `npm-registry/packages/async/3.2.6/build.entrypoint.sh` (align install line with factory contract)

## Tier B — dual tarball (esbuild pattern)

Single clone; one run produces **both** outputs.

1. Clone at `SOURCE_REF`
2. Build linux-x64 binary from **source** (package-specific: `make`, `go build`, etc.)
3. **Platform package** — stage minimal tree, write `package.json` with `@calunga/<name>-linux-x64`, pack with `tar` (npm pack can omit generated files due to ignore rules — prefer explicit `tar` staging like esbuild recipe)
4. **Main package** — copy JS wrapper files, patch `optionalDependencies`, patch `install.js` to reference `@calunga/...` instead of `@esbuild/linux-x64`
5. Pack main with `tar` into `main_tgz`
6. List `OUT_DIR` for debugging

Platform `package.json` template:

```bash
jq -n --arg name "@calunga/foo-linux-x64" --arg version "${VERSION}" \
  '{ name: $name, version: $version, os: ["linux"], cpu: ["x64"], ... }'
```

Reference: `npm-registry/packages/esbuild/0.28.0/build.entrypoint.sh`

## Tier C — compile + shim

1. Clone, run compile (`npm run build-release`, `node-gyp rebuild`, etc.)
2. Locate native artifact (e.g. `build/Release/better_sqlite3.node`)
3. **Main stage** — copy JS lib files only; write slim `package.json` (strip install/prepare/devDeps; set `optionalDependencies`; `postinstall: node install.js`)
4. Copy recipe `tl-install.js` → staged `install.js`
5. `pack_dir` helper or tar-based pack for main and platform tarballs
6. Platform tarball contains the `.node` file at the path the install shim expects

`RECIPE_DIR` for helper files:

```bash
RECIPE_DIR="$(cd "$(dirname "${MANIFEST_PATH}")" && pwd)"
cp "${RECIPE_DIR}/tl-install.js" "${MAIN_STAGE}/install.js"
```

Reference: `npm-registry/packages/better-sqlite3/11.8.1/build.entrypoint.sh`

## tl-install.js (Tier C)

Small CommonJS shim that `require.resolve`s `@calunga/<name>-linux-x64/...` and copies the native file into the layout the JS API expects. No network, no node-gyp on consumer.

Reference: `npm-registry/packages/better-sqlite3/11.8.1/tl-install.js`

## Forbidden

- `npm pack <name>@<version>` from registry.npmjs.org
- `curl`/`wget` of npmjs tarballs as build input
- `npm publish`
- Writing outside `OUT_DIR` / `WORK_DIR` (except reading `RECIPE_DIR` helpers)

## Monorepo tips

- Read `facts.source.package_dir` — clone repo root, then `cd` into that path before install/pack
- esbuild: sources under `npm/esbuild` and `npm/@esbuild/linux-x64`
- If `facts.factory.blockers` is non-empty (pnpm, `workspace:*`), emit **`needs_human`** — do not run `npm install` at monorepo root
- Document chosen subdirectory in evidence

## Packing note

Prefer **explicit tar** to `out/...` when:

- Generated `install.js` is ignored by npm pack
- You need exact `package/` prefix layout
- Staging dir is under `WORK_DIR` with git ancestry affecting npm pack

Pattern:

```bash
pack_root="$(mktemp -d)"
mkdir -p "${pack_root}/package"
cp -a "${STAGE}/." "${pack_root}/package/"
tar --create --gzip --file "${tgz}" --directory "${pack_root}" package
rm -rf "${pack_root}"
```
