const NAME_AT_VERSION = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+([-+][-a-zA-Z0-9.+]+)?$/;

export class PromotionError extends Error {
  constructor(message, { candidate, reason }) {
    super(message);
    this.name = 'PromotionError';
    this.candidate = candidate;
    this.reason = reason;
  }
}

export function promote({ catalogJson, candidate, promotedAt }) {
  if (!NAME_AT_VERSION.test(candidate)) {
    throw new PromotionError(
      `Invalid candidate format: "${candidate}"`,
      { candidate, reason: 'invalid_format' },
    );
  }

  const entry = catalogJson.entries[candidate];

  if (!entry) {
    throw new PromotionError(
      `Candidate "${candidate}" is not tracked in the catalog`,
      { candidate, reason: 'not_tracked' },
    );
  }

  if (entry.available) {
    throw new PromotionError(
      `Candidate "${candidate}" is already available`,
      { candidate, reason: 'already_available' },
    );
  }

  return {
    schema_version: catalogJson.schema_version,
    entries: {
      ...catalogJson.entries,
      [candidate]: {
        available: true,
        source: 'poc_mock_promotion',
        promoted_at: promotedAt,
      },
    },
  };
}
