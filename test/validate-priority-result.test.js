import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const validator = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../scripts/lib/validate-priority-result.mjs',
);

function runValidator(resultDoc, inputDoc) {
  const dir = mkdtempSync(join(tmpdir(), 'nrk-priority-val-'));
  const resultPath = join(dir, 'priority-result.json');
  const inputPath = join(dir, 'priority-input.json');
  writeFileSync(resultPath, `${JSON.stringify(resultDoc, null, 2)}\n`);
  writeFileSync(inputPath, `${JSON.stringify(inputDoc, null, 2)}\n`);
  const proc = spawnSync('node', [validator, resultPath, inputPath], {
    encoding: 'utf-8',
  });
  rmSync(dir, { recursive: true, force: true });
  return proc;
}

const baseEntry = {
  candidate: 'chalk@5.3.0',
  immediate_l3_unlocks: [],
  gap_reductions: {},
  affected_packages: [],
  native_tier: 'unknown',
  demand: 1000,
  rationale: 'popular and not on TL',
};

describe('validate-priority-result.mjs', () => {
  it('accepts a full top_n selection', () => {
    const proc = runValidator(
      {
        schema_version: 1,
        top_n: 2,
        weights: { closure: 0.6, popularity: 0.4 },
        reasoning: 'ok',
        entries: [baseEntry, { ...baseEntry, candidate: 'axios@1.7.0' }],
      },
      { schema_version: 1, top_n: 2, shortlist: [{}, {}, {}] },
    );
    assert.equal(proc.status, 0, proc.stderr);
  });

  it('rejects under-filled results when shortlist has enough rows', () => {
    const proc = runValidator(
      {
        schema_version: 1,
        top_n: 3,
        weights: { closure: 0.6, popularity: 0.4 },
        reasoning: 'partial',
        entries: [baseEntry],
      },
      { schema_version: 1, top_n: 3, shortlist: [{}, {}, {}, {}] },
    );
    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /expected 3/);
  });
});
