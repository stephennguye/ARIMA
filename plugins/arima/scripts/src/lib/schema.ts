import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { pluginRoot } from './paths.js';

export type SchemaName =
  'arima' | 'team' | 'profile' | 'event' | 'ledger' | 'outbox' | 'notion-map' | 'ids';

const cache = new Map<string, ValidateFunction>();

/** Compiles plugins/arima/schemas/<name>.schema.json (JSON Schema 2020-12). */
export function getValidator(name: SchemaName, root: string = pluginRoot()): ValidateFunction {
  const key = `${root}::${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = path.join(root, 'schemas', `${name}.schema.json`);
  const schema = JSON.parse(readFileSync(file, 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const validate = ajv.compile(schema);
  cache.set(key, validate);
  return validate;
}

/** "/roles/po/type" style pointer -> readable "roles.po.type". */
export function pointerToPath(pointer: string): string {
  return pointer.split('/').filter(Boolean).join('.') || '(root)';
}

export function describeError(e: ErrorObject): string {
  const where = pointerToPath(e.instancePath);
  switch (e.keyword) {
    case 'additionalProperties':
      return `${where}: unknown property "${String((e.params as { additionalProperty: string }).additionalProperty)}"`;
    case 'required':
      return `${where}: missing required property "${String((e.params as { missingProperty: string }).missingProperty)}"`;
    case 'enum':
      return `${where}: must be one of ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}`;
    default:
      return `${where}: ${e.message ?? 'invalid'}`;
  }
}
