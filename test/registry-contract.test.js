import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadRegistryContract,
  loadRegistryContractFromDir,
  isValidRegistryContractSha,
  RegistryContractError,
} from '../scripts/lib/registry-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(here, 'fixtures', 'registry-contract', '017ebd5a3c5fef6d595f7c852fd584a7d5fae255');

describe('registry-contract (pinned Gate A input)', () => {
  it('loads a valid pinned contract SHA from provenance.json', () => {
    const c = loadRegistryContractFromDir(CONTRACT_DIR);
    assert.equal(c.commit_sha, '017ebd5a3c5fef6d595f7c852fd584a7d5fae255');
    assert.equal(c.repository, 'calungaproject/npm-registry');
  });

  it('is unavailable (not invented) when the file is missing', () => {
    assert.throws(
      () => loadRegistryContract(join(CONTRACT_DIR, 'nope.json')),
      (err) => err instanceof RegistryContractError && err.reason_code === 'REGISTRY_CONTRACT_UNAVAILABLE',
    );
  });

  it('validates that the SHA is a full 40-hex commit SHA', () => {
    assert.equal(isValidRegistryContractSha('017ebd5a3c5fef6d595f7c852fd584a7d5fae255'), true);
    assert.equal(isValidRegistryContractSha('017ebd5a'), false);
    assert.equal(isValidRegistryContractSha('ZZZ'), false);
    assert.equal(isValidRegistryContractSha(undefined), false);
  });
});
