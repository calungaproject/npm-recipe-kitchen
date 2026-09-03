# npm-builder factory image

Recipes run in the **npm-builder** image built from `calungaproject/plumbing/npm-builder/Containerfile` (Konflux image `quay.io/redhat-user-workloads/calunga-tenant/npm-builder`).

Before writing `build.entrypoint.sh` or `verify.smoke.sh`, derive which commands are available **from the Containerfile** — do not guess tools that are not installed there.

## How to build the inventory (same as CI)

1. Read `plumbing/npm-builder/Containerfile`, or the kitchen snapshot at `registry-contract/npm-builder/Containerfile` (pinned in `registry-contract/npm-builder/provenance.json`).
2. Collect commands from:
   - **UBI8 base** (`FROM registry.access.redhat.com/ubi8/ubi`) — coreutils always present (`rm`, `mkdir`, `cp`, `mv`, …).
   - **`dnf -y install`** package list → map to binaries (`nodejs` → `node`, `golang` → `go`, …).
   - **`COPY --chmod=755 scripts/... /usr/local/bin/`** → factory script names (`build-npm-package`, `shasum`, …).
   - **`COPY --from=syft-bin ... syft`** → `syft`.
   - **gcc-toolset / rust-toolset** install comments → `gcc`, `g++`, `cargo`, `rustc` on PATH.
3. Do **not** assume `pnpm`, `yarn`, `deno`, `bun`, `curl`, `cmake`, or other tools unless they appear in that Containerfile.

Kitchen helper (prints the derived list):

```bash
node scripts/format-npm-builder-inventory.mjs
```

Post-validation parses the same snapshot and rejects scripts that call unknown commands. **Konflux on-pr** is the real build gate — a bad recipe will fail there if static checks miss something.

## Typical Tier A commands

`git`, `npm`, `node`, `jq`, `tar`, `mkdir`, `cp`, `mv`, `rm`, `chmod`

## Typical Tier B/C additions

`make`, `go`, `gcc`, `g++`, `cargo`, `rustc`, `python3`, `patch`

## When unsure

Emit `needs_human` with the gap documented in `reason`, or use only commands you verified in the Containerfile inventory.
