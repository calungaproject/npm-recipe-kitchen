#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(
  readFileSync(join(repoRoot, 'schemas/priority-result.schema.json'), 'utf-8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const resultPath = process.argv[2];
if (!resultPath) {
  console.error('usage: validate-priority-result.mjs <priority-result.json> [priority-input.json]');
  process.exit(1);
}

const inputPath =
  process.argv[3] ??
  process.env.PRIORITY_INPUT_FILE ??
  '/tmp/fullsend-npm-priority-queue/priority-input.json';

const doc = JSON.parse(readFileSync(resultPath, 'utf-8'));
if (!validate(doc)) {
  console.error('priority-result validation failed:', validate.errors);
  process.exit(1);
}

const topN = Number(process.env.PRIORITY_QUEUE_TOP_N ?? doc.top_n ?? 5);
let expectedCount = topN;
if (existsSync(inputPath)) {
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const shortlistLen = Array.isArray(input.shortlist) ? input.shortlist.length : 0;
  const inputTopN = Number(input.top_n ?? topN);
  expectedCount = shortlistLen === 0 ? 1 : Math.min(inputTopN, shortlistLen);
}

if (doc.entries.length > topN) {
  console.error(`priority-result has ${doc.entries.length} entries; max top_n is ${topN}`);
  process.exit(1);
}

if (doc.entries.length !== expectedCount) {
  console.error(
    `priority-result has ${doc.entries.length} entries; expected ${expectedCount} ` +
      `(min(top_n=${topN}, shortlist.length))`,
  );
  process.exit(1);
}

console.log(`priority-result ok (${doc.entries.length} entries)`);
