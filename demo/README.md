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

## Run the tests

```bash
npm test
```

The test suite includes promotion precondition tests and a full deterministic-loop integration test that verifies schema validation, expected compliance levels, queue rankings, and cross-run stability.
