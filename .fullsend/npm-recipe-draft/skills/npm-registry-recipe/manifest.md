# manifest.json guide

Schema: `calungaproject/npm-registry` → `docs/manifest.schema.json`

## Minimal Tier A

```json
{
  "name": "lodash",
  "version": "4.18.1",
  "description": "Lodash modular utilities",
  "native_tier": "A",
  "source": {
    "url": "https://github.com/lodash/lodash.git",
    "ref": "4.18.1",
    "ref_type": "tag"
  },
  "upstream_npm": {
    "version": "4.18.1"
  },
  "entrypoint": "build.entrypoint.sh",
  "smoke": "verify.smoke.sh",
  "outputs": [
    {
      "id": "main",
      "type": "npm-package",
      "path": "out/lodash-4.18.1.tgz",
      "pulp_name": "lodash"
    }
  ]
}
```

## Tier B/C additions

Add a second `outputs[]` entry and `optional_dependencies_published`:

```json
{
  "native_tier": "B",
  "outputs": [
    {
      "id": "main",
      "type": "npm-package",
      "path": "out/esbuild-0.28.0.tgz",
      "pulp_name": "esbuild"
    },
    {
      "id": "linux-x64-binary",
      "type": "tl-platform-package",
      "path": "out/@calunga/esbuild-linux-x64-0.28.0.tgz",
      "pulp_name": "@calunga/esbuild-linux-x64",
      "platform": "linux-x64",
      "libc": "glibc"
    }
  ],
  "optional_dependencies_published": [
    "@calunga/esbuild-linux-x64@0.28.0"
  ]
}
```

Tier C uses the same output shape; difference is in **how** `build.entrypoint.sh` produces the platform artifact.

## Field reference

| Field | Rules |
| --- | --- |
| `name` / `version` | Must match npm publish identity; directory is `packages/<name>/<version>/` (scoped names keep `@` in manifest, path encoding follows repo convention) |
| `description` | One line for humans/review |
| `native_tier` | `"A"`, `"B"`, or `"C"` |
| `source.url` | HTTPS git URL |
| `source.ref` | Tag or commit that builds this version — prefer immutable tag matching npm release |
| `source.ref_type` | `"tag"` or `"commit"` (document choice) |
| `upstream_npm.version` | Expected npm version for verification |
| `upstream_npm.integrity` | Optional `sha512-...` from registry for ref↔version checks |
| `entrypoint` / `smoke` | Always `build.entrypoint.sh` and `verify.smoke.sh` in v1 |
| `outputs[].path` | Under `out/`; must match what entrypoint creates |
| `outputs[].pulp_name` | Publish name in Pulp (main = npm name, platform = `@calunga/...`) |
| `outputs[].type` | `npm-package` or `tl-platform-package` |
| `optional_dependencies_published` | Tier B/C only; exact `name@version` of platform package |

## Do not include

- `compliance_level`, `missing_gaps`, `pending_l3_gaps` — pipeline sidecars
- `builder.image` — factory image pinned in Tekton, not per-package manifest (older esbuild sample may show it; omit for new recipes unless repo convention changes)
- Production `dependencies` list — closure assess reads packed `package.json`

## Path conventions

- Main tarball: `out/<name>-<version>.tgz` (unscoped) or follow existing packages for scoped names
- Platform tarball: `out/@calunga/<unscoped-name>-linux-x64-<version>.tgz`
- `id` values: stable short names (`main`, `linux-x64-binary`, `linux-x64-addon`)

## Validation

```bash
check-jsonschema --schemafile docs/manifest.schema.json packages/*/*/manifest.json
# or in npm-registry repo:
./hack/lint-manifest.sh origin/main
```
