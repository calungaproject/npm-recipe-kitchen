import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../scripts/lib/validate.mjs';

const script = new URL('../scripts/run-demo-loop.mjs', import.meta.url).pathname;

const ARTIFACTS = [
  'compliance-before-app-a.json',
  'compliance-before-app-b.json',
  'compliance-before-app-c.json',
  'queue-before.json',
  'catalog-after.json',
  'compliance-after-app-a.json',
  'compliance-after-app-b.json',
  'compliance-after-app-c.json',
  'queue-after.json',
];

function runLoop() {
  const dir = mkdtempSync(join(tmpdir(), 'demo-loop-'));
  execFileSync('node', [script, '--output-dir', dir], { encoding: 'utf-8' });
  const files = {};
  for (const name of ARTIFACTS) {
    files[name] = readFileSync(join(dir, name), 'utf-8');
  }
  return { dir, files };
}

describe('demo loop', () => {
  let run;

  it('produces all expected artifacts', () => {
    run = runLoop();
    for (const name of ARTIFACTS) {
      assert.ok(run.files[name], `${name} must exist`);
    }
  });

  it('all compliance artifacts validate against compliance schema', () => {
    for (const name of ARTIFACTS.filter(n => n.startsWith('compliance-'))) {
      const data = JSON.parse(run.files[name]);
      const result = validate('compliance', data);
      assert.strictEqual(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
    }
  });

  it('queue artifacts validate against queue schema', () => {
    for (const name of ['queue-before.json', 'queue-after.json']) {
      const data = JSON.parse(run.files[name]);
      const result = validate('queue', data);
      assert.strictEqual(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
    }
  });

  it('catalog-after validates against catalog schema', () => {
    const data = JSON.parse(run.files['catalog-after.json']);
    const result = validate('catalog', data);
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  });

  describe('before promotion', () => {
    it('semver@7.7.2 is first in queue-before', () => {
      const queue = JSON.parse(run.files['queue-before.json']);
      assert.strictEqual(queue.entries[0].candidate, 'semver@7.7.2');
    });

    it('all three consumers are below L3', () => {
      for (const name of ['app-a', 'app-b', 'app-c']) {
        const report = JSON.parse(run.files[`compliance-before-${name}.json`]);
        assert.ok(report.closure_gaps.length > 0, `${name} must have gaps before promotion`);
      }
    });

    it('semver appears in every consumer\'s gaps', () => {
      for (const name of ['app-a', 'app-b', 'app-c']) {
        const report = JSON.parse(run.files[`compliance-before-${name}.json`]);
        assert.ok(
          report.closure_gaps.includes('semver@7.7.2'),
          `${name} must list semver@7.7.2 as a gap`,
        );
      }
    });
  });

  describe('after promotion', () => {
    it('semver@7.7.2 is absent from queue-after', () => {
      const queue = JSON.parse(run.files['queue-after.json']);
      const candidates = queue.entries.map(e => e.candidate);
      assert.ok(!candidates.includes('semver@7.7.2'), 'semver must not appear after promotion');
    });

    it('app-a reaches L3 (zero gaps)', () => {
      const report = JSON.parse(run.files['compliance-after-app-a.json']);
      assert.deepStrictEqual(report.closure_gaps, []);
    });

    it('app-b reaches L3 (zero gaps)', () => {
      const report = JSON.parse(run.files['compliance-after-app-b.json']);
      assert.deepStrictEqual(report.closure_gaps, []);
    });

    it('app-c retains only its chalk gap', () => {
      const report = JSON.parse(run.files['compliance-after-app-c.json']);
      assert.deepStrictEqual(report.closure_gaps, ['chalk@5.4.1']);
    });

    it('queue-after identifies chalk as the remaining relevant candidate', () => {
      const queue = JSON.parse(run.files['queue-after.json']);
      assert.strictEqual(queue.entries.length, 1);
      assert.strictEqual(queue.entries[0].candidate, 'chalk@5.4.1');
    });

    it('chalk would unlock L3 for app-c', () => {
      const queue = JSON.parse(run.files['queue-after.json']);
      const chalk = queue.entries[0];
      assert.deepStrictEqual(chalk.immediate_l3_unlocks, ['app-c@1.0.0']);
    });

    it('catalog-after records promotion metadata', () => {
      const catalog = JSON.parse(run.files['catalog-after.json']);
      const entry = catalog.entries['semver@7.7.2'];
      assert.strictEqual(entry.available, true);
      assert.strictEqual(entry.source, 'poc_mock_promotion');
      assert.strictEqual(entry.promoted_at, '2026-08-14T00:00:00Z');
    });
  });

  describe('determinism', () => {
    it('two runs produce byte-for-byte identical output', () => {
      const second = runLoop();
      for (const name of ARTIFACTS) {
        assert.strictEqual(
          run.files[name],
          second.files[name],
          `${name} must be identical across runs`,
        );
      }
      rmSync(second.dir, { recursive: true });
    });
  });

  it('cleanup', () => {
    rmSync(run.dir, { recursive: true });
  });
});
