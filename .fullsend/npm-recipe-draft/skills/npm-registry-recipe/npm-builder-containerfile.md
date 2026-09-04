# npm-builder factory image

Recipes run in the **npm-builder** image built from `calungaproject/plumbing/npm-builder/Containerfile` (Konflux image `quay.io/redhat-user-workloads/calunga-tenant/npm-builder`).

Before writing `build.entrypoint.sh` or `verify.smoke.sh`, derive which commands are available **from the Containerfile** — do not guess tools that are not installed there.

## Factory runtime (not just PATH commands)

The Containerfile sets environment that changes how **allowed** commands behave:

| Setting | Effect on recipes |
| --- | --- |
| `NODE_ENV=production` | `npm install` **omits devDependencies** unless you pass `--include=dev` or `--production=false` |
| No `pnpm` / `yarn` | Monorepos with `packageManager: pnpm@…` or `workspace:*` deps **cannot** use root `npm install` |
| No `file(1)` | Use `tar tf` for tarball diagnostics only |

When `facts.upstream.has_build_step` is true, the trusted install line is:

```bash
npm install --include=dev --ignore-scripts
```

Then run the upstream build (`npm run build`, etc.), then `npm pack`.

When `facts.source.package_dir` is not `"."`, clone the repo root, then **`cd` into that subdirectory** before install/pack.

## How to build the command inventory (same as CI)

1. Read `plumbing/npm-builder/Containerfile`, or the kitchen snapshot at `registry-contract/npm-builder/Containerfile` (pinned in `registry-contract/npm-builder/provenance.json`).
2. Collect commands from:
   - **UBI8 base** (`FROM registry.access.redhat.com/ubi8/ubi`) — coreutils always present (`rm`, `mkdir`, `cp`, `mv`, …).
   - **`dnf -y install`** package list → map to binaries (`nodejs` → `node`, `golang` → `go`, …).
   - **`COPY --chmod=755 scripts/... /usr/local/bin/`** → factory script names (`build-npm-package`, `shasum`, …).
   - **`COPY --from=syft-bin ... syft`** → `syft`.
   - **gcc-toolset / rust-toolset** install comments → `gcc`, `g++`, `cargo`, `rustc` on PATH.
3. Do **not** assume `pnpm`, `yarn`, `deno`, `bun`, `curl`, `cmake`, `file`, or other tools unless they appear in that Containerfile.

Kitchen helper (prints the derived list):

```bash
node scripts/format-npm-builder-inventory.mjs
```

Post-validation parses the same snapshot and rejects scripts that call unknown commands. It also checks `facts.factory` (install line, package dir, blockers).

## Typical Tier A commands

`git`, `npm`, `node`, `jq`, `tar`, `mkdir`, `cp`, `mv`, `rm`, `chmod`

## Typical Tier B/C additions

`make`, `go`, `gcc`, `g++`, `cargo`, `rustc`, `python3`, `patch`

## `facts.factory.blockers` — must escalate

If `recipe-input.json` includes any of these, emit **`needs_human`** (full recipe still required):

| Blocker | Meaning |
| --- | --- |
| `pnpm-workspace` | Root `packageManager` is pnpm; factory has no pnpm |
| `yarn-workspace` | Root `packageManager` is yarn; factory has no yarn |
| `workspace-protocol` | `workspace:*` dependencies; npm cannot install the monorepo |

Post-validation **rejects `drafted`** when blockers are present.

## When unsure

Emit `needs_human` with the gap documented in `reason`, or use only commands you verified in the Containerfile inventory.
