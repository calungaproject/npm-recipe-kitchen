Package identity: semver@7.7.2
Native tier: A

Source repository: https://github.com/npm/node-semver
Version tag: v7.7.2
Pinned commit: 281055e7716ef0415a8826972471331989ede58c
How tag-to-version was checked:
git rev-parse 'v7.7.2^{commit}' to print the commit hash for both annotated and lightweight tags (direct pointers to a commit) and its subsequent test that asserts that the commit the tag points to is exactly the expected SHA. This is the proof: the tag v7.7.2 resolves to the known-good commit. If someone moved the tag (tags are mutable in git), this would fail.

Runtime language/module form: CommonJS, executable JavaScript
Runtime dependencies: None (no dependencies field in package.json)
Install-time lifecycle scripts: None
Published CLI: semver

Compile/build step required: no
Evidence for that answer: There is no `build`, `prepare`, `prepack`, or `prepublishOnly` script. The `scripts` field has no build/compile steps.
Packaging command tested: `npm pack --ignore-scripts --pack-destination ./out-local`
Output artefact path: ./out-local/semver-7.7.2.tgz
Published-file selection evidence: The `files` field in `package.json` allowlists: `bin/`, `lib/`, `classes/`, `functions/`, `internal/`, `ranges/`, `index.js`, `preload.js`, `range.bnf`. npm also auto-includes `package.json`, `LICENSE`, `README.md`. That's the mechanism preventing arbitrary repo files from entering the tarball.

Upstream install command: npm install --ignore-scripts --no-audit --no-fund
Upstream test command: npm test --ignore-scripts
Upstream lint command: npm run lint --ignore-scripts; npm run postlint --ignore-scripts
Local result and environment: Node v22.22.3, npm 10.9.8; all passed

Smoke-test behaviour 1: semver.satisfies("7.7.2","^7.0.0") returns true; semver.valid("7.7.2") returns "7.7.2"
Smoke-test behaviour 2: CLI `semver -r '^7.0.0' 6.0.0 7.7.2` prints 7.7.2, filters out 6.0.0
Smoke-test command tested against packed tarball: install the packed tarball into a
throwaway `mktemp -d` prefix with `npm install --ignore-scripts --no-audit --no-fund`,
then verify both the module API (`semver.satisfies`, `semver.valid`) and the CLI
(`semver -r '^7.0.0' 6.0.0 7.7.2`) against the installed copy. See verify.smoke.sh.

Network required while packaging: No
Network required while smoke-testing: Yes (npm install fetches tarball into the temp prefix)
Pinned npm-registry contract SHA: 017ebd5a3c5fef6d595f7c852fd584a7d5fae255
Factory builder ownership: external pipeline pin; no per-package builder field
Declared output path: out/semver-7.7.2.tgz (factory convention)
Builder assumption still unresolved after reading the pinned contract: confirmed resolved.
The builder image is pinned externally in .tekton/calunga-npm-registry-main-pull-request.yaml
via the builder-image param (quay.io/redhat-user-workloads/calunga-tenant/npm-builder@sha256:c3511cd1e8cd4f1845be52ebe1e938e9e08d2fc802036793b1afae4fec82c834).
Per-package manifests do not carry a builder field. This matches the golden recipe design.

Upstream npm provenance state: SLSA v1 provenance attestation present
Evidence source and retrieval date: npm view semver@7.7.2 --json, 2026-08-13
Could not verify: did not independently verify the SLSA attestation signature chain

Tag vs commit SHA decision: source.ref now carries the immutable commit SHA
281055e7716ef0415a8826972471331989ede58c with ref_type "commit". The tag v7.7.2 is
retained only in this evidence document. Existing Express recipes in npm-registry use
tags (ref_type "tag"), so this is a conscious compatibility divergence: the PoC
prioritizes immutability over convention. The registry schema accepts both forms
(source.ref is a free string, ref_type is optional). The build entrypoint uses
git clone --no-checkout followed by git checkout of the exact SHA.

Refusal/stop conditions:
- source commit does not equal the pinned SHA;
- package.json version is not 7.7.2;
- npm pack would run an unexpected lifecycle script;
- packed tarball does not expose the documented module API and CLI;
- the pinned npm-registry contract cannot be inspected or the factory input/output contract remains ambiguous.

