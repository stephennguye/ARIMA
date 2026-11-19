import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from '../events.js';
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
  // The moment an id is issued is when the item is created: lead time starts here (spec 13.3).
  await appendEvent(projectDir, {
    type: 'id.issued',
    actor: 'system',
    run_id: runId,
    ...(/^(US|BUG|INC|CR)-/.test(id) ? { item: id } : {}),
    data: { id },
  });
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

export const engineEntriesFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'engine-entries.json');

function readEngineEntries(projectDir: string): string[] {
  const file = engineEntriesFile(projectDir);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as string[];
}

/**
 * Marks an outbox entry id as made by the engine itself (init, the state machine). Push lets only
 * such entries write `Status`: a file name that merely starts with `init-` or `st-` proves
 * nothing, because an agent may write any top-level outbox file, but it cannot write `.arima/state/`.
 */
export async function registerEngineEntry(projectDir: string, id: string): Promise<void> {
  const file = engineEntriesFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  await withFileLock(`${file}.lock`, () => {
    const all = readEngineEntries(projectDir);
    if (!all.includes(id)) all.push(id);
    writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`);
  });
}

export const isEngineEntry = (projectDir: string, id: string): boolean =>
  readEngineEntries(projectDir).includes(id);
