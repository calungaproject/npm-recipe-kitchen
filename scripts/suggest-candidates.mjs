import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { suggestCandidates } from './lib/suggest.mjs';
import { validate } from './lib/validate.mjs';

const { values } = parseArgs({
  options: {
    'output-dir': { type: 'string' },
  },
});

const outputDir = values['output-dir'] || 'demo/output';

const fixturesDir = new URL('../fixtures/', import.meta.url);
const popular = JSON.parse(readFileSync(new URL('popular.json', fixturesDir), 'utf-8'));
const catalogJson = JSON.parse(readFileSync(new URL('catalog-before.json', fixturesDir), 'utf-8'));

const artifact = suggestCandidates({ popular, catalogJson });

const result = validate('suggestions', artifact);
if (!result.valid) {
  console.error('suggestions.json failed schema validation:');
  for (const e of result.errors) {
    console.error(`  ${e.path}: ${e.message}`);
  }
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/suggestions.json`, JSON.stringify(artifact, null, 2) + '\n');

console.log(`Suggested for onboarding (source: ${artifact.source}, captured_at: ${artifact.captured_at}):\n`);
for (const s of artifact.suggestions) {
  const marker = s.in_catalog ? '[in catalog]' : '[new]';
  console.log(
    `  ${s.rank}. ${s.identity}  score=${s.score}  rules=[${s.rules.join(', ')}]  ${marker}`,
  );
}

console.log(`\nWrote and validated ${outputDir}/suggestions.json`);
