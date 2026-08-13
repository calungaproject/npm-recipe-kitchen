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
Pinned npm-registry contract SHA: pending — complete Gate A steps 1–3 (pin a read-only
registry checkout and create the test/fixtures/registry-contract/ snapshot) before
filling this field.
Factory builder ownership: external pipeline pin; no per-package builder field
Declared output path: out/semver-7.7.2.tgz (factory convention)
Builder assumption still unresolved after reading the pinned contract: pending —
requires reading .tekton/ pipeline definitions in the pinned registry checkout to
determine whether the builder image/digest is externally pinned or per-recipe.

Upstream npm provenance state: SLSA v1 provenance attestation present
Evidence source and retrieval date: npm view semver@7.7.2 --json, 2026-08-13
Could not verify: did not independently verify the SLSA attestation signature chain

Tag vs commit SHA decision: source.ref uses the tag v7.7.2 rather than the commit
SHA. The factory considers tags immutable within the npm-registry workflow. The build
entrypoint independently verifies that the cloned HEAD matches the expected commit SHA
281055e7716ef0415a8826972471331989ede58c, so a moved or deleted tag would cause a
build failure. Revisit whether source.ref should carry the commit SHA directly once the
registry contract compatibility question is resolved.

Refusal/stop conditions:
- source commit does not equal the pinned SHA;
- package.json version is not 7.7.2;
- npm pack would run an unexpected lifecycle script;
- packed tarball does not expose the documented module API and CLI;
- the pinned npm-registry contract cannot be inspected or the factory input/output contract remains ambiguous.

