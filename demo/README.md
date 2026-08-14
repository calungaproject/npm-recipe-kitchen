# PoC promotion demo

This demo runs the full deterministic loop: compliance check, queue scoring, package promotion, then compliance and queue re-evaluation.
All inputs are checked-in fixtures with fixed clocks, so every run produces byte-for-byte identical output.

## One-command walkthrough

```bash
npm run demo
```

This writes validated JSON artifacts to `demo/output/`:

| Artifact | Description |
|----------|-------------|
| `compliance-before-app-{a,b,c}.json` | Per-consumer compliance reports before promotion |
| `queue-before.json` | Prioritised candidate queue before promotion |
| `catalog-after.json` | Catalog state after promoting semver@7.7.2 |
| `compliance-after-app-{a,b,c}.json` | Per-consumer compliance reports after promotion |
| `queue-after.json` | Prioritised candidate queue after promotion |

## What the demo shows

1. Before promotion, semver@7.7.2 ranks first in the queue because it unlocks L3 for two consumers (app-a, app-b) and reduces gaps for a third (app-c).
2. Promoting semver@7.7.2 adds it to the catalog with `available: true`, `source: "poc_mock_promotion"`, and a fixed `promoted_at` timestamp.
3. After promotion, app-a and app-b reach L3 (zero closure gaps).
4. app-c retains only its chalk@5.4.1 gap and chalk becomes the sole remaining queue candidate.
5. Promotion is separate from recipe existence, recipe approval, or recipe merge.

## Verify determinism

Run the demo twice and diff:

```bash
npm run demo
cp -r demo/output demo/output-first
npm run demo
diff -r demo/output-first demo/output
```

No differences means byte-for-byte stable output.

## Join a Fullsend result to a read-only registry handoff bundle

This is the no-bot join path: it reads recipe facts from an exact, read-only checkout of `calungaproject/npm-registry` and turns a validated Fullsend recipe result into a reviewable local bundle plus an unapplied `apply.patch`.
It never modifies the registry checkout, opens a PR, promotes, or applies anything.

Use a fresh sibling checkout pinned to an exact commit SHA (see the pinning guide in the PoC note).
The registry checkout must be clean and detached at the exact SHA you pass.

```bash
# 1. Snapshot recipe presence at the exact registry SHA (read-only; makes no network calls).
registry_sha="$(git -C ../npm-registry-pinned rev-parse HEAD)"
node scripts/snapshot-registry.mjs \
  --registry-dir ../npm-registry-pinned \
  --registry-ref "$registry_sha" \
  --out demo/output/registry-snapshot.json

# 2. Render the handoff bundle from a validated Fullsend recipe result.
node scripts/render-draft-bundle.mjs \
  --recipe-result test/fixtures/contracts/recipe-result/valid-drafted-tier-a.json \
  --registry-snapshot demo/output/registry-snapshot.json
```

A `drafted` result writes `demo/output/draft-bundle/<name>/<version>/` containing:

| Artifact | Description |
|----------|-------------|
| `packages/<name>/<version>/manifest.json` | Deterministically rendered from the allowlisted template |
| `packages/<name>/<version>/build.entrypoint.sh` | Rendered build entrypoint (template owns all shell text) |
| `packages/<name>/<version>/verify.smoke.sh` | Rendered smoke test |
| `packages/<name>/<version>/evidence.md` | Evidence and `could_not_verify` items |
| `bundle.json` | Provenance: target repo/commit, `generated_at`, evidence summary, per-file SHA-256, and a "not applied" note |
| `apply.patch` | A git-applyable new-file diff targeting `packages/<name>/<version>/` — **proposed, not applied** |

A `needs_human` result writes only `bundle.json` with the refusal reason and escalation target: no invented recipe files and no patch.

The bundle is a proposal only.
To preview the patch against a real registry checkout without changing it:

```bash
git -C ../npm-registry-pinned apply --check "$(pwd)/demo/output/draft-bundle/semver/7.7.2/apply.patch"
```

Inputs and clock are fixed, so repeated runs are byte-for-byte stable.

## Run the tests

```bash
npm test
```

The test suite includes promotion precondition tests and a full deterministic-loop integration test that verifies schema validation, expected compliance levels, queue rankings, and cross-run stability.
