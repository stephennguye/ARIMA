import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './lib/atomic-file.js';
import { withFileLock } from './lib/filelock.js';
import { describeError, getValidator } from './lib/schema.js';

/** Counter-based ID prefixes and their minimum zero-padding width (spec §2). */
export const ID_WIDTHS = {
  REQ: 3,
  NFR: 3,
  EP: 2,
  US: 3,
  TC: 4,
  BUG: 3,
  ADR: 4,
  RISK: 3,
  DEC: 4,
  Q: 3,
  MS: 2,
  CR: 3,
  INC: 3,
  LES: 3,
} as const;

export type IdPrefix = keyof typeof ID_WIDTHS;

export const ID_PREFIXES = Object.keys(ID_WIDTHS) as IdPrefix[];

export function isIdPrefix(value: string): value is IdPrefix {
  return Object.prototype.hasOwnProperty.call(ID_WIDTHS, value);
}

export interface IdState {
  schema_version: 1;
  counters: Partial<Record<IdPrefix, number>>;
}

export function formatId(prefix: IdPrefix, n: number): string {
  return `${prefix}-${String(n).padStart(ID_WIDTHS[prefix], '0')}`;
}

export function idsFile(projectDir: string): string {
  return path.join(projectDir, '.arima', 'state', 'ids.json');
}

function readState(file: string): IdState {
  if (!existsSync(file)) return { schema_version: 1, counters: {} };
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const validate = getValidator('ids');
  if (!validate(data)) {
    // Never silently reset: a reset could reissue an old ID.
    throw new Error(`Corrupt ${file}: ${(validate.errors ?? []).map(describeError).join('; ')}`);
  }
  return data as IdState;
}

export function readCounters(projectDir: string): IdState['counters'] {
  return readState(idsFile(projectDir)).counters;
}

/**
 * Issues the next ID for `prefix`, e.g. REQ-014. The read-increment-write happens under a file
 * lock, so concurrent processes get distinct, gap-free numbers. Counters never decrease.
 */
export async function nextId(projectDir: string, prefix: string): Promise<string> {
  if (!isIdPrefix(prefix)) {
    throw new Error(`Unknown ID prefix "${prefix}". Expected one of: ${ID_PREFIXES.join(', ')}`);
  }
  const file = idsFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const state = readState(file);
    const n = (state.counters[prefix] ?? 0) + 1;
    state.counters[prefix] = n;
    writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    return formatId(prefix, n);
  });
}
