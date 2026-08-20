// Registry contract SHA: the pinned, read-only identifier of the npm-registry
// manifest contract this kitchen drafts against.
//
// This value is NOT a package fact and must never be derived from npm metadata.
// It is established out-of-band (Gate A) as an explicit, reviewed snapshot of
// the target registry's manifest schema, recorded in a provenance file:
//
//   <contract_dir>/provenance.json
//     { "repository": "...", "commit_sha": "<40-hex>", "schema_path": "...",
//       "schema_sha256": "...", "retrieved_at": "..." }
//
// The kitchen only READS this input; it never writes to npm-registry. When the
// contract input is missing or malformed the caller must surface a blocked /
// needs_human outcome rather than inventing a SHA.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEX40_RE = /^[0-9a-f]{40}$/;

export class RegistryContractError extends Error {
  constructor(message, reasonCode) {
    super(message);
    this.name = 'RegistryContractError';
    this.reason_code = reasonCode;
  }
}

/**
 * Load and validate the pinned registry-contract SHA from a provenance file.
 *
 * @param {string} provenancePath absolute path to provenance.json
 * @returns {{ commit_sha: string, repository: string, schema_path?: string, schema_sha256?: string }}
 * @throws {RegistryContractError} REGISTRY_CONTRACT_UNAVAILABLE when the file is
 *         missing/unreadable/invalid JSON, or REGISTRY_CONTRACT_INVALID when the
 *         recorded commit_sha is not a full 40-char lowercase hex SHA.
 */
export function loadRegistryContract(provenancePath) {
  let raw;
  try {
    raw = readFileSync(provenancePath, 'utf-8');
  } catch (err) {
    throw new RegistryContractError(
      `registry contract provenance not readable at ${provenancePath}: ${err.message}`,
      'REGISTRY_CONTRACT_UNAVAILABLE',
    );
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new RegistryContractError(
      `registry contract provenance is not valid JSON: ${err.message}`,
      'REGISTRY_CONTRACT_UNAVAILABLE',
    );
  }

  const sha = doc?.commit_sha;
  if (typeof sha !== 'string' || !HEX40_RE.test(sha)) {
    throw new RegistryContractError(
      `registry contract commit_sha "${sha}" is not a full 40-char lowercase hex SHA`,
      'REGISTRY_CONTRACT_INVALID',
    );
  }

  return {
    commit_sha: sha,
    repository: typeof doc.repository === 'string' ? doc.repository : undefined,
    schema_path: typeof doc.schema_path === 'string' ? doc.schema_path : undefined,
    schema_sha256: typeof doc.schema_sha256 === 'string' ? doc.schema_sha256 : undefined,
  };
}

/**
 * Convenience: resolve the provenance path from a contract directory and load it.
 */
export function loadRegistryContractFromDir(contractDir) {
  return loadRegistryContract(join(contractDir, 'provenance.json'));
}

export function isValidRegistryContractSha(sha) {
  return typeof sha === 'string' && HEX40_RE.test(sha);
}
