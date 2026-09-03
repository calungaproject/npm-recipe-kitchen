// Load npm-builder command inventory by parsing the pinned Containerfile snapshot.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseNpmBuilderContainerfile } from './parse-npm-builder-containerfile.mjs';

const CONTRACT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../registry-contract/npm-builder',
);

const DEFAULT_CONTAINERFILE = join(CONTRACT_DIR, 'Containerfile');
const PROVENANCE_PATH = join(CONTRACT_DIR, 'provenance.json');

let cached;

/**
 * @param {string} [containerfilePath]
 * @returns {{ commands: Set<string>, packages: string[], scripts: string[], source: object }}
 */
export function loadNpmBuilderInventory(containerfilePath = DEFAULT_CONTAINERFILE) {
  if (cached && containerfilePath === DEFAULT_CONTAINERFILE) return cached;

  const content = readFileSync(containerfilePath, 'utf-8');
  let provenance = {};
  try {
    provenance = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf-8'));
  } catch {
    provenance = {};
  }

  const parsed = parseNpmBuilderContainerfile(
    content,
    provenance.containerfile_path ?? 'npm-builder/Containerfile',
  );

  const result = {
    commands: parsed.commands,
    packages: parsed.packages,
    scripts: parsed.scripts,
    source: {
      repository: provenance.repository,
      commit_sha: provenance.commit_sha,
      containerfile_path: provenance.containerfile_path,
      image: provenance.image,
      local_snapshot: containerfilePath,
    },
  };

  if (containerfilePath === DEFAULT_CONTAINERFILE) cached = result;
  return result;
}
