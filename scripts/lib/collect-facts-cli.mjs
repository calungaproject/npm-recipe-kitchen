// Thin CLI wrapper the pre-script invokes to produce the agent's recipe-input.json.
//
// Orchestration only: it loads the pinned registry-contract SHA, calls the
// on-demand collector (with the default real adapters), and writes the resulting
// agent input file. It enforces the failure contract at the process boundary:
//
//   - OperationalError (retryable infra: timeout, DNS/TLS, 429, 5xx, truncation,
//     oversize, invalid JSON, unrelated child failure) -> exit 1, FAIL THE RUN.
//   - Every package/policy/input/blocked outcome -> write failure details to the
//     input file and exit 1 (fail the run; pre-script comments on the issue).
//
// Env:
//   IDENTITY                      name@version to onboard ('' -> input_error)
//   INPUT_FILE                    where to write recipe-input.json (required)
//   REGISTRY_CONTRACT_PROVENANCE  path to the pinned Gate A provenance.json (optional)
//   REGISTRY_URL                  registry base (default https://registry.npmjs.org)

import { writeFileSync } from 'node:fs';

import { computeFacts, toAgentInput, OperationalError } from './compute-facts.mjs';
import { defaultAdapters } from './adapters/npm-adapters.mjs';
import { loadRegistryContract, RegistryContractError } from './registry-contract.mjs';

async function main() {
  const identity = process.env.IDENTITY || '';
  const inputFile = process.env.INPUT_FILE;
  if (!inputFile) {
    console.error('[collect-facts] INPUT_FILE is required');
    process.exit(1);
  }

  const registryUrl = process.env.REGISTRY_URL || 'https://registry.npmjs.org';

  // The registry contract SHA is a pinned Gate A input, never derived from npm.
  // Its absence blocks the collector path.
  let registryContractSha;
  const provenancePath = process.env.REGISTRY_CONTRACT_PROVENANCE;
  if (provenancePath) {
    try {
      registryContractSha = loadRegistryContract(provenancePath).commit_sha;
    } catch (err) {
      if (err instanceof RegistryContractError) {
        console.error(`[collect-facts] registry contract unavailable: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  let outcome;
  try {
    outcome = await computeFacts(identity, {
      registryContractSha,
      adapters: defaultAdapters,
      registryUrl,
    });
  } catch (err) {
    if (err instanceof OperationalError) {
      // Retryable infrastructure fault: fail the run rather than masquerade as
      // a human-review case.
      console.error(`[collect-facts] OPERATIONAL FAILURE (${err.reason_code}): ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (outcome.status !== 'ok') {
    const payload = toAgentInput(identity, outcome);
    writeFileSync(inputFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    console.error(
      `[collect-facts] FACT COLLECTION FAILED (${payload.reason_code ?? 'UNKNOWN'}): ${payload.reason ?? 'no reason'}`,
    );
    process.exit(1);
  }

  const payload = toAgentInput(identity, outcome);
  writeFileSync(inputFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  console.log(`[collect-facts] wrote ${inputFile} (facts_available=true)`);
}

main().catch((err) => {
  console.error(`[collect-facts] UNEXPECTED ERROR: ${err.stack || err.message}`);
  process.exit(1);
});
