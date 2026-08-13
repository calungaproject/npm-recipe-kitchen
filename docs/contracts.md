# Contracts

## canonical `name@version`

The unique identity of a package in the catalogue, e.g. `semver@7.7.2`. Immutable once assigned; the version component is the upstream npm version.

## catalogue availability

Whether a `name@version` is present in the internal catalogue and eligible for installation. A merged recipe does not imply availability.

## direct_required

The set of `name@version` entries explicitly needed by a consumer's package.json dependencies (not transitive).

## production_closure

The full transitive dependency tree resolved for a consumer's production install — every `name@version` that `npm install --omit=dev` would fetch.

## closure_gaps

Entries in a consumer's `production_closure` that are not yet available in the catalogue. Each gap blocks the consumer's install.

## immediate_l3_unlocks

Consumers whose `closure_gaps` would drop to zero if a given `name@version` were added to the catalogue — i.e., the last missing piece.

## gap_reductions

For each consumer, the count of `closure_gaps` removed by adding a given `name@version` to the catalogue, even if gaps remain.
