# Scenario: semver promotion unlocks two of three consumers

This file describes the expected outcome of the checked-in fixture data.
It was written by hand so a human reader can verify the algorithms produce the right answer.
No code generated this file.

## Environment

- Node v22.22.3, npm 10.9.8
- Lockfiles generated with: `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --save-exact <deps>`

## Consumer production closures (from npm-generated lockfiles)

| Consumer | Direct dependencies | Full production closure |
|----------|-------------------|----------------------|
| app-a@1.0.0 | commander@13.1.0, debug@4.4.1, semver@7.7.2 | commander@13.1.0, debug@4.4.1, ms@2.1.3, semver@7.7.2 |
| app-b@1.0.0 | ms@2.1.3, semver@7.7.2 | ms@2.1.3, semver@7.7.2 |
| app-c@1.0.0 | chalk@5.4.1, commander@13.1.0, semver@7.7.2 | chalk@5.4.1, commander@13.1.0, semver@7.7.2 |

Note: ms@2.1.3 appears in app-a's closure as a transitive dependency of debug@4.4.1.
chalk@5.4.1 (v5) is pure ESM with zero runtime dependencies.

## Before promotion (catalog-before.json)

Available: commander@13.1.0, debug@4.4.1, ms@2.1.3.
Unavailable: semver@7.7.2, chalk@5.4.1.

| Consumer | Closure gaps | Gap count |
|----------|-------------|-----------|
| app-a@1.0.0 | semver@7.7.2 | 1 |
| app-b@1.0.0 | semver@7.7.2 | 1 |
| app-c@1.0.0 | semver@7.7.2, chalk@5.4.1 | 2 |

All three consumers are blocked from L3.

## After semver@7.7.2 promotion (catalog-after.json)

Available: commander@13.1.0, debug@4.4.1, ms@2.1.3, semver@7.7.2.
Unavailable: chalk@5.4.1.

| Consumer | Closure gaps | Gap count |
|----------|-------------|-----------|
| app-a@1.0.0 | (none) | 0 |
| app-b@1.0.0 | (none) | 0 |
| app-c@1.0.0 | chalk@5.4.1 | 1 |

- app-a and app-b reach L3 (zero gaps).
- app-c's gap count drops from 2 to 1 but it does not reach L3.

## Expected queue entries before promotion

Two candidates appear in the queue: semver@7.7.2 and chalk@5.4.1.

### semver@7.7.2

- immediate_l3_unlocks: [app-a@1.0.0, app-b@1.0.0]
- gap_reductions: { "app-c@1.0.0": 1 }
- affected_packages: [app-a@1.0.0, app-b@1.0.0, app-c@1.0.0]

### chalk@5.4.1

- immediate_l3_unlocks: []
- gap_reductions: { "app-c@1.0.0": 1 }
- affected_packages: [app-c@1.0.0]

## Expected queue entries after semver promotion

Only one candidate remains: chalk@5.4.1.

### chalk@5.4.1

- immediate_l3_unlocks: [app-c@1.0.0]
- gap_reductions: (empty, since it is app-c's last gap)
- affected_packages: [app-c@1.0.0]

After semver leaves the queue, chalk becomes app-c's sole remaining blocker and would unlock L3 for app-c if promoted.

## Demand data

The demand.json file contains small illustrative PoC values, not real download counts.
Demand values do not affect gap analysis; they influence queue priority ranking only.
