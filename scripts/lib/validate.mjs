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

  return { valid: errors.length === 0, errors };
}

export { CONTRACT_NAMES };
