import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { nextId } from '../ids.js';
import type { IdPrefix } from '../ids.js';
import { writeFileAtomic } from '../lib/atomic-file.js';
import { withFileLock } from '../lib/filelock.js';
import { dbByKey } from './schema.js';
import type { DbKey } from './schema.js';

/** Databases whose title is an engine-issued id, and the counter that issues it (spec 2). */
export const ID_PREFIX_BY_DB: Partial<Record<DbKey, IdPrefix>> = {
  requirements: 'REQ',
  epics: 'EP',
  stories: 'US',
  test_cases: 'TC',
  bugs: 'BUG',
  milestones: 'MS',
  decisions: 'DEC',
  questions: 'Q',
  change_requests: 'CR',
  incidents: 'INC',
  risks: 'RISK',
  lessons: 'LES',
};

export const allocationsFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'allocations.json');

function readAllocations(projectDir: string): Record<string, string> {
  const file = allocationsFile(projectDir);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
}

/** Which run an issued id was allocated to, if any. Push uses this to tell an issued id from a made-up one. */
export function allocatedTo(projectDir: string, id: string): string | undefined {
  return readAllocations(projectDir)[id];
}

/** Issues the next id for `prefix` and records which run it belongs to. */
export async function allocateId(
  projectDir: string,
  prefix: IdPrefix,
  runId: string,
): Promise<string> {
  const id = await nextId(projectDir, prefix);
  const file = allocationsFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  await withFileLock(`${file}.lock`, () => {
    const all = readAllocations(projectDir);
    all[id] = runId;
    writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`);
  });
  return id;
}

export const titleProperty = (db: DbKey): string =>
  dbByKey(db).props.find((p) => p.type === 'title')?.name as string;
