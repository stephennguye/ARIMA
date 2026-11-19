import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { pluginRoot } from './paths.js';

export type SchemaName =
  | 'arima'
  | 'team'
  | 'profile'
  | 'event'
  | 'ledger'
  | 'outbox'
  | 'notion-map'
  | 'ids'
  | 'agent-report'
  | 'question'
  | 'finding'
  | 'decision'
  | 'work-unit'
  | 'item'
  | 'manual-costs'
  | 'questions-state';

const cache = new Map<string, ValidateFunction>();
const instances = new Map<string, Ajv2020>();

/** One Ajv per plugin root with every schema loaded, so schemas can `$ref` each other by file name. */
function ajvFor(root: string): Ajv2020 {
  const hit = instances.get(root);
  if (hit) return hit;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const dir = path.join(root, 'schemas');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as object, f);
  }
  instances.set(root, ajv);
  return ajv;
}

/** Compiles plugins/arima/schemas/<name>.schema.json (JSON Schema 2020-12). */
export function getValidator(name: SchemaName, root: string = pluginRoot()): ValidateFunction {
  const key = `${root}::${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const validate = ajvFor(root).getSchema(`${name}.schema.json`);
  if (!validate) throw new Error(`schema not found: schemas/${name}.schema.json`);
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
