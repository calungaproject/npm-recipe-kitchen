import { createCatalog } from './catalog.mjs';

/**
 * Candidate suggestion source.
 *
 * This stage runs conceptually *upstream* of the queue (scripts/lib/queue.mjs):
 * it proposes packages for onboarding from an explicit signal (popularity),
 * independently of the consumer closure gaps that seed the queue's candidate set.
 * The queue still owns impact scoring; this only proposes candidates.
 *
 * Ranking-rules interface (pluggable):
 *
 *   rule = {
 *     name: string,                 // stable identifier recorded on each suggestion
 *     weight?: number,              // multiplier for this rule's contribution (default 1)
 *     score(candidate) -> number,   // non-negative contribution for this candidate
 *   }
 *
 *   candidate = { identity, ...fields }
 *     where `fields` are the per-package fields from the popularity fixture
 *     (e.g. { score }). `identity` is a canonical `name@version` string.
 *
 * The engine multiplies each rule's score by its weight and sums across rules to
 * form the combined score. A rule that returns 0 did not surface the candidate.
 * Adding a second rule is purely additive: push another rule object onto the
 * `rules` array — the core loop below does not change.
 */

export const popularityRule = {
  name: 'popularity',
  weight: 1,
  score(candidate) {
    return typeof candidate.score === 'number' ? candidate.score : 0;
  },
};

export const DEFAULT_RULES = [popularityRule];

/**
 * Pure function: produce a ranked, deterministic list of suggested candidates.
 *
 * @param {object}  args
 * @param {object}  args.popular      Parsed popularity fixture (see fixtures/popular.json).
 * @param {object}  args.catalogJson  Parsed catalog document (see schemas/catalog.schema.json).
 * @param {Array}   [args.rules]      Ranking rules (see interface above); defaults to DEFAULT_RULES.
 * @returns {object} A suggestions artifact matching schemas/suggestions.schema.json.
 */
export function suggestCandidates({ popular, catalogJson, rules = DEFAULT_RULES }) {
  const catalog = createCatalog(catalogJson);
  const packages = (popular && popular.packages) || {};

  const scored = [];
  for (const [identity, fields] of Object.entries(packages)) {
    const candidate = { identity, ...fields };

    let combined = 0;
    const surfacedBy = [];
    for (const rule of rules) {
      const weight = typeof rule.weight === 'number' ? rule.weight : 1;
      const raw = rule.score(candidate) || 0;
      if (raw > 0) surfacedBy.push(rule.name);
      combined += weight * raw;
    }

    scored.push({
      identity,
      score: combined,
      rules: surfacedBy,
      in_catalog: catalog.isAvailable(identity),
    });
  }

  // Deterministic, stable order: combined score descending, then identity ascending.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.identity < b.identity) return -1;
    if (a.identity > b.identity) return 1;
    return 0;
  });

  const suggestions = scored.map((s, i) => ({
    identity: s.identity,
    rank: i + 1,
    score: s.score,
    rules: s.rules,
    in_catalog: s.in_catalog,
  }));

  return {
    schema_version: 1,
    source: (popular && popular.source) || 'unknown',
    captured_at: (popular && popular.captured_at) || 'unknown',
    suggestions,
  };
}
