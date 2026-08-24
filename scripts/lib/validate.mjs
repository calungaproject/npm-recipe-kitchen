import Ajv from 'ajv';
import { readFileSync } from 'node:fs';

const ajv = new Ajv({ allErrors: true });

const CONTRACT_NAMES = ['recipe-result'];

const validators = new Map();
for (const name of CONTRACT_NAMES) {
  const schemaPath = new URL(`../../schemas/${name}.schema.json`, import.meta.url);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  validators.set(name, ajv.compile(schema));
}

// Semantic invariant JSON Schema can't express: each parameter value's JS type
// must match its declared `type` field.
const PARAM_TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
};

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
