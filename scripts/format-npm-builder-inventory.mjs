#!/usr/bin/env node
// Print npm-builder command inventory derived from the pinned Containerfile snapshot.
// Recipe agent: run this (or read the Containerfile with the same rules) before drafting scripts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { formatNpmBuilderInventoryMarkdown } from './lib/parse-npm-builder-containerfile.mjs';

const defaultPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../registry-contract/npm-builder/Containerfile',
);

const path = process.argv[2] ?? defaultPath;
const content = readFileSync(path, 'utf-8');
process.stdout.write(formatNpmBuilderInventoryMarkdown(content));
