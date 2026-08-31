# verify.smoke.sh patterns

Runs in the same builder image after `build.entrypoint.sh`. Must exit non-zero on failure.

## Boilerplate

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${MANIFEST_PATH:?MANIFEST_PATH required}"
: "${OUT_DIR:?OUT_DIR required}"

VERSION="$(jq -r .version "${MANIFEST_PATH}")"
MAIN_TGZ="$(jq -r '.outputs[] | select(.type == "npm-package") | .path' "${MANIFEST_PATH}")"

path_under_out() {
    local rel="$1"
    echo "${OUT_DIR}/${rel#out/}"
}

MAIN_PATH="$(path_under_out "${MAIN_TGZ}")"
```

## Tier A checks

1. Main tarball file exists
2. Required members present (`package/package.json`, main entry file)
3. `name` and `version` inside tarball match manifest
4. Optional: `node --check` on main JS entry

Reference: `npm-registry/packages/lodash/4.18.1/verify.smoke.sh`

## Tier B checks

1. Main **and** platform tarballs exist
2. Main: `package/install.js` present; platform: binary at expected path (`package/bin/esbuild`)
3. Extract platform bin, `chmod +x`, run `--version` or equivalent
4. Dump tarball listing on failure (`tar tf`)

Reference: `npm-registry/packages/esbuild/0.28.0/verify.smoke.sh`

## Tier C checks

1. Main + platform tarballs exist
2. Main: `install.js`, key JS modules; **no** upstream `scripts.install` that compiles natives
3. Main `package.json`: `optionalDependencies["@calunga/<name>-linux-x64"] == VERSION`
4. Platform: `.node` file present
5. ELF validation for linux-x64 (npm-builder has `od`, not `file`):

```bash
verify_elf_linux_x64() {
    local bin="$1"
    local magic="$(od -An -tx1 -N4 "${bin}" | tr -d ' \n')"
    [[ "${magic}" == "7f454c46" ]] || return 1   # ELF
    local elf_class="$(od -An -tu1 -j4 -N1 "${bin}" | tr -d ' ')"
    [[ "${elf_class}" == "2" ]] || return 1      # ELF64
    local machine="$(od -An -tu2 -j18 -N2 "${bin}" | tr -d ' ')"
    [[ "${machine}" == "62" ]] || return 1        # x86_64
}
```

Reference: `npm-registry/packages/better-sqlite3/11.8.1/verify.smoke.sh`

## Helpers

```bash
tgz_has_member() {
    tar -xOf "${tgz}" "${member}" >/dev/null 2>&1
}

dump_tgz_listing() {
    echo "Tarball listing (${tgz}):" >&2
    tar tf "${tgz}" >&2 || true
}
```

## What smoke should not do

- Network calls
- `npm install` from npmjs (optional: local extract + `node -e` require is OK if no registry)
- Mutate `OUT_DIR` beyond temp extract dirs

## Choosing assertions

Pick members that prove **your** entrypoint staged the right layout:

- Tier A: primary module path (`lodash.js`, `dist/async.js`)
- Tier B: install shim + platform binary path
- Tier C: install shim + optionalDeps + native addon path

When unsure of the right file to assert, inspect upstream npm tarball layout or packed output from a local dry-run and document the choice.
