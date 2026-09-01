#!/usr/bin/env node
/** Runner pre-script entry: collect priority-queue shortlist for Agent 1. */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_TOP_N,
  DEFAULT_WEIGHT_CLOSURE,
  DEFAULT_WEIGHT_POPULARITY,
} from './priority-queue-constants.mjs';
import { createDefaultPriorityAdapters } from './adapters/priority-adapters.mjs';
import { computePriorityQueue } from './compute-priority-queue.mjs';

const runExecFile = promisify(execFile);

function resolveTopN() {
  if (process.env.PRIORITY_QUEUE_TOP_N) return Number(process.env.PRIORITY_QUEUE_TOP_N);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return DEFAULT_TOP_N;
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
    const fromInputs = event?.inputs?.top_n ?? event?.workflow_dispatch?.inputs?.top_n;
    if (fromInputs) return Number(fromInputs);
  } catch {
    // ignore
  }
  return DEFAULT_TOP_N;
}

async function main() {
  const inputFile =
    process.env.PRIORITY_INPUT_FILE ?? '/tmp/fullsend-npm-priority-queue/priority-input.json';
  const topN = resolveTopN();
  const closureWeight = Number(process.env.PRIORITY_WEIGHT_CLOSURE ?? DEFAULT_WEIGHT_CLOSURE);
  const popularityWeight = Number(
    process.env.PRIORITY_WEIGHT_POPULARITY ?? DEFAULT_WEIGHT_POPULARITY,
  );

  const adapters = createDefaultPriorityAdapters({
    execFile: runExecFile,
  });

  const payload = await computePriorityQueue({
    adapters,
    topN,
    closureWeight,
    popularityWeight,
  });

  mkdirSync(dirname(inputFile), { recursive: true });
  writeFileSync(inputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log(`[collect-priority] wrote ${inputFile} (${payload.shortlist.length} candidates)`);
}

main().catch((err) => {
  console.error(`[collect-priority] ${err.message}`);
  process.exit(1);
});
