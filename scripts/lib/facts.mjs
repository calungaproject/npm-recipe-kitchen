// Fact-bundle structural validation.
//
// `validateFacts` is the runner-side (Gate 0) structural check that a fact bundle
// carries the authoritative fields a drafted recipe must bind — a valid identity,
// a full commit SHA and git URL for the source association, a native tier, and a
// could_not_verify observation array — before post-validation renders from it.
// Facts themselves are produced only by the on-demand collector
// (scripts/lib/compute-facts.mjs); this module never trusts model-echoed values.

const NAME_VERSION_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+([-+][-a-zA-Z0-9.+]+)?$/;

export function validateFacts(facts) {
  const errors = [];
  if (!facts || typeof facts !== 'object') {
    return { valid: false, errors: [{ path: '/', message: 'facts must be an object' }] };
  }
  if (!facts.identity || !NAME_VERSION_RE.test(facts.identity)) {
    errors.push({ path: '/identity', message: 'missing or invalid identity' });
  }
  if (!facts.source?.commit_sha || !/^[0-9a-f]{40}$/.test(facts.source.commit_sha)) {
    errors.push({ path: '/source/commit_sha', message: 'must be a 40-character lowercase hex SHA' });
  }
  if (!facts.source?.git_url) {
    errors.push({ path: '/source/git_url', message: 'missing git URL' });
  }
  if (typeof facts.native_tier !== 'string' || !['A', 'B', 'C'].includes(facts.native_tier)) {
    errors.push({ path: '/native_tier', message: 'must be A, B, or C' });
  }
  if (!Array.isArray(facts.could_not_verify)) {
    errors.push({ path: '/could_not_verify', message: 'must be an array' });
  }
  return { valid: errors.length === 0, errors };
}
