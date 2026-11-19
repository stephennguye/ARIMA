import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withFileLock } from './filelock.js';
import { assertNoSecrets } from './secrets.js';
import { describeError, getValidator } from './schema.js';
import type { SchemaName } from './schema.js';
import { CURRENT_SCHEMA_VERSION, VERSIONED, migrateRecord } from './migrate.js';

/**
 * Appends one validated record to a JSON Lines file. Append-only: there is intentionally no
 * update or delete. Runs under a lock so lines from concurrent processes never interleave.
 */
export async function appendJsonl(
  file: string,
  schema: SchemaName,
  record: unknown,
): Promise<void> {
  const validate = getValidator(schema);
  if (VERSIONED.includes(schema) && typeof record === 'object' && record !== null)
    record = { schema_version: CURRENT_SCHEMA_VERSION, ...record };
  if (!validate(record)) {
    throw new Error(
      `Invalid ${schema} record: ${(validate.errors ?? []).map(describeError).join('; ')}`,
    );
  }
  const line = JSON.stringify(record);
  assertNoSecrets(line, path.basename(file));
  mkdirSync(path.dirname(file), { recursive: true });
  await withFileLock(`${file}.lock`, () => {
    appendFileSync(file, `${line}\n`, 'utf8');
  });
}

/** Reads and validates every line; a malformed or invalid line is an error naming its number. */
export function readJsonl<T>(file: string, schema: SchemaName): T[] {
  if (!existsSync(file)) return [];
  const validate = getValidator(schema);
  const out: T[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${file}:${i + 1}: not valid JSON`, { cause: e });
    }
    try {
      parsed = migrateRecord(schema, parsed);
    } catch (e) {
      throw new Error(`${file}:${i + 1}: ${(e as Error).message}`, { cause: e });
    }
    if (!validate(parsed)) {
      throw new Error(
        `${file}:${i + 1}: invalid ${schema} record: ${(validate.errors ?? []).map(describeError).join('; ')}`,
      );
    }
    out.push(parsed as T);
  });
  return out;
}
