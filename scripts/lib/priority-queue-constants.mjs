/** Shared defaults for npm-priority-queue (Agent 1). */

export const DEFAULT_TL_REGISTRY_URL =
  'https://packages.redhat.com/api/pulp-content/public-trusted-libraries/javascript';

export const DEFAULT_CLOSURE_INDEX_IMAGE =
  'quay.io/redhat-user-workloads/calunga-tenant/calunga-npm-registry-main:npm-closure-index';

export const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org';

export const DEFAULT_WEIGHT_CLOSURE = 0.6;
export const DEFAULT_WEIGHT_POPULARITY = 0.4;
export const DEFAULT_TOP_N = 5;
export const DEFAULT_SHORTLIST_SIZE = 30;

/** Seed names for popularity leg when closure index has few blockers. */
export const POPULAR_PACKAGE_SEEDS = [
  'axios',
  'chalk',
  'commander',
  'cors',
  'dotenv',
  'helmet',
  'joi',
  'moment',
  'node-fetch',
  'pino',
  'uuid',
  'winston',
  'ws',
  'yargs',
  'zod',
];
