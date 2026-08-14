import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { promote } from './lib/promote.mjs';
import { validate } from './lib/validate.mjs';

const { values } = parseArgs({
  options: {
    candidate: { type: 'string' },
    catalog: { type: 'string' },
    'promoted-at': { type: 'string' },
    output: { type: 'string' },
  },
});

if (!values.candidate || !values.catalog || !values['promoted-at']) {
  console.error(
    'Usage: promote-poc-package --candidate <name@version> --catalog <path> ' +
    '--promoted-at <iso> [--output <path>]',
  );
  process.exit(1);
}

const catalogJson = JSON.parse(readFileSync(values.catalog, 'utf-8'));

const result = promote({
  catalogJson,
  candidate: values.candidate,
  promotedAt: values['promoted-at'],
});

const validation = validate('catalog', result);
if (!validation.valid) {
  console.error('Promotion result failed schema validation:');
  for (const e of validation.errors) {
    console.error(`  ${e.path}: ${e.message}`);
  }
  process.exit(1);
}

const output = JSON.stringify(result, null, 2) + '\n';

if (values.output) {
  if (existsSync(values.output)) {
    const existing = readFileSync(values.output, 'utf-8');
    if (existing === output) {
      process.exit(0);
    }
  }
  writeFileSync(values.output, output);
} else {
  process.stdout.write(output);
}
