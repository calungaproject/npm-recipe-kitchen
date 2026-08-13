import Ajv from 'ajv';
import { readFileSync } from 'node:fs';

const ajv = new Ajv({ allErrors: true });

const CONTRACT_NAMES = [
  'catalog',
  'compliance',
  'queue',
  'recipe-result',
  'registry-input',
];

const validators = new Map();
for (const name of CONTRACT_NAMES) {
  const schemaPath = new URL(`../../schemas/${name}.schema.json`, import.meta.url);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  validators.set(name, ajv.compile(schema));
}

/**
 * Semantic invariants that JSON Schema cannot express cleanly.
 *
 * compliance:
 *   - closure_gaps ⊆ production_closure
 *   - direct_required ⊆ production_closure
 *
 * queue:
 *   - immediate_l3_unlocks ⊆ affected_packages  (per entry)
 *   - keys of gap_reductions ⊆ affected_packages (per entry)
 *
 * recipe-result:
 *   - each parameter value's JS type must match its declared type field
 */

const PARAM_TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
};

function subsetErrors(child, parent, childPath, parentName) {
  const parentSet = new Set(parent);
  const errors = [];
  for (let i = 0; i < child.length; i++) {
    if (!parentSet.has(child[i])) {
      errors.push({
        path: `${childPath}/${i}`,
        message: `"${child[i]}" must appear in ${parentName}`,
      });
    }
  }
  return errors;
}

function validateComplianceSemantics(data) {
  return [
    ...subsetErrors(data.closure_gaps, data.production_closure, '/closure_gaps', 'production_closure'),
    ...subsetErrors(data.direct_required, data.production_closure, '/direct_required', 'production_closure'),
  ];
}

function validateQueueSemantics(data) {
  const errors = [];
  for (let i = 0; i < data.entries.length; i++) {
    const entry = data.entries[i];
    errors.push(
      ...subsetErrors(entry.immediate_l3_unlocks, entry.affected_packages, `/entries/${i}/immediate_l3_unlocks`, 'affected_packages'),
    );
    for (const key of Object.keys(entry.gap_reductions)) {
      if (!entry.affected_packages.includes(key)) {
        errors.push({
          path: `/entries/${i}/gap_reductions/${key}`,
          message: `gap_reductions key "${key}" must appear in affected_packages`,
        });
      }
    }
  }
  return errors;
}

function validateRecipeResultSemantics(data) {
  if (data.status !== 'drafted' || !data.parameters) return [];
  const errors = [];
  for (const [name, param] of Object.entries(data.parameters)) {
    const check = PARAM_TYPE_CHECKS[param.type];
    if (check && !check(param.value)) {
      errors.push({
        path: `/parameters/${name}/value`,
        message: `value must be a ${param.type}, got ${typeof param.value}`,
      });
    }
  }
  return errors;
}

const semanticValidators = new Map([
  ['compliance', validateComplianceSemantics],
  ['queue', validateQueueSemantics],
  ['recipe-result', validateRecipeResultSemantics],
]);

export function validate(contractName, data) {
  const schemaValidator = validators.get(contractName);
  if (!schemaValidator) {
    throw new Error(`Unknown contract: ${contractName}`);
  }

  const valid = schemaValidator(data);
  const errors = [];

  if (!valid) {
    for (const e of schemaValidator.errors) {
      errors.push({
        path: e.instancePath || '/',
        message: e.message,
        params: e.params,
      });
    }
  }

  if (valid) {
    const semanticFn = semanticValidators.get(contractName);
    if (semanticFn) {
      errors.push(...semanticFn(data));
    }
  }

  return { valid: errors.length === 0, errors };
}

export { CONTRACT_NAMES };
