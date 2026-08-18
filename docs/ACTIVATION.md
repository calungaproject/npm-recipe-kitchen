# Activation readiness

This document describes what must change to activate the hosted Fullsend recipe builder.
Nothing here is applied automatically.
Each step below requires separate, explicit authorization.

Throughout preparation, `kill_switch: true` stays set in `.fullsend/config.yaml`.

## Required `main` ruleset changes

The active **Main** ruleset currently enforces:

- block deletion,
- block non-fast-forward (force-push),
- require a pull request, but with `required_approving_review_count: 0` and no required status checks.

Before `main` can change during activation, the ruleset must additionally require:

- **A pull request** (already present) — keep the `pull_request` rule.
- **At least one approving review** — set `required_approving_review_count: 1` on the `pull_request` rule.
- **Passing status checks** — add a `required_status_checks` rule referencing the CI check, and require branches to be up to date:
  - required check context: `validate` (the job in `.github/workflows/ci.yaml`, workflow `ci`),
  - `strict_required_status_checks_policy: true`.

These are describe-only until the owner authorizes the ruleset update.

## CI

`.github/workflows/ci.yaml` runs on every pull request to `main`:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm test`
- `npm run check`

It uses a read-only token (`contents: read`), does not persist git credentials, and pins third-party Actions to full commit SHAs.
It is independent of the Fullsend shim workflow and does not touch GCP or any registry.

## Fullsend workflow

`.github/workflows/fullsend.yaml` is managed by Fullsend and is pinned to `fullsend-ai/fullsend/.github/workflows/reusable-dispatch.yml@65ceb961020290e43b008daa380765b44f35c5df` (v0.36.0).
Do not edit or delete it by hand.
The installed CLI is `fullsend 0.36.0`, matching the pin.

## Activation sequence (performed only under separate authorization)

1. Publish and merge the focused recipe-builder and CI changes with `kill_switch: true`.
2. Apply the approved `main` ruleset protections above.
3. Use a separate, minimal, reviewed change to set `kill_switch: false`.
   The activation diff should ideally be exactly `kill_switch: true` → `kill_switch: false`.
4. On a disposable issue, an authorized write-level collaborator comments the onboarding command for the first candidate:

   ```
   /fs-onboard semver@7.7.2
   ```

5. Capture the evidence below and confirm that no registry mutation or publication occurred.
6. Re-enable `kill_switch: true` after the experiment unless the owner explicitly authorizes continued operation.

## First-run evidence checklist

Capture all of the following for the first genuine hosted run:

- disposable issue URL,
- workflow run URL and run ID,
- exact input (`semver@7.7.2`),
- exact output (`drafted` or `needs_human`),
- validator result,
- generated files (the four fixed recipe files for `drafted`, or evidence-only for `needs_human`),
- run duration,
- any cost or usage signal,
- confirmation that no registry PR, promotion, build, sign, or publish occurred.
