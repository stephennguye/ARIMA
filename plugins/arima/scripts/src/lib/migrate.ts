import type { SchemaName } from './schema.js';

/**
 * Forward migration of persisted records (WP-195, spec 15.3). A record written by an earlier ARIMA
 * has no `schema_version`: that means version 1, the first and so far only version. A record from a
 * NEWER ARIMA is refused with a clear message instead of a confusing schema error, because
 * reading it as if it were version 1 could misread it. When a version 2 exists, its upgrade
 * step goes into `STEPS` and old rows are upgraded in memory on read; files are never rewritten.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Record kinds that carry an optional `schema_version`. */
export const VERSIONED: readonly SchemaName[] = ['ledger', 'event', 'outbox'];

/** `STEPS[n]` upgrades a version n record to version n + 1. Empty until version 2 exists. */
const STEPS: Record<number, (record: Record<string, unknown>) => Record<string, unknown>> = {};

export class SchemaVersionError extends Error {}

export function versionOf(record: unknown): number {
  const v = (record as { schema_version?: unknown } | null)?.schema_version;
  return v === undefined ? 1 : typeof v === 'number' ? v : Number.NaN;
}

/** Returns the record at the current version (a copy when it changed). Throws on a newer or invalid version. */
export function migrateRecord(schema: SchemaName, record: unknown): unknown {
  if (!VERSIONED.includes(schema) || record === null || typeof record !== 'object') return record;
  let v = versionOf(record);
  if (!Number.isInteger(v) || v < 1)
    throw new SchemaVersionError(`invalid schema_version in a ${schema} record`);
  if (v > CURRENT_SCHEMA_VERSION)
    throw new SchemaVersionError(
      `a ${schema} record has schema_version ${v}, newer than this ARIMA understands (${CURRENT_SCHEMA_VERSION}); upgrade the plugin`,
    );
  let out = record as Record<string, unknown>;
  while (v < CURRENT_SCHEMA_VERSION) {
    const step = STEPS[v];
    if (step === undefined) throw new SchemaVersionError(`no migration from ${schema} v${v}`);
    out = step(out);
    v += 1;
  }
  return out;
}
