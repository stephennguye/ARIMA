import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from '../events.js';
import { writeFileAtomic } from '../lib/atomic-file.js';
import { describeError, getValidator } from '../lib/schema.js';
import type { NotionMap } from './mapper.js';
import type { NotionPort, RawRow } from './port.js';
import { fromNotionValue } from './values.js';
import type { Plain } from './values.js';

export interface MirrorRow {
  page_id: string;
  last_edited_time: string;
  /** The ARIMA ID: the text of the row's title property (US-112, G1, a document title...). */
  id: string;
  properties: Record<string, Plain | { id: string; name?: string }[]>;
}

export interface MirrorFile {
  schema_version: 1;
  database: string;
  fetched_at: string;
  rows: MirrorRow[];
}

export const mirrorDir = (projectDir: string): string => path.join(projectDir, '.arima', 'mirror');
export const mirrorFile = (projectDir: string, db: string): string =>
  path.join(mirrorDir(projectDir), `${db}.json`);
export const notionMapFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'notion-map.json');

export function readNotionMap(projectDir: string): NotionMap {
  const file = notionMapFile(projectDir);
  if (!existsSync(file)) throw new Error(`${file} not found; run arima-notion map first`);
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const validate = getValidator('notion-map');
  if (!validate(data)) {
    throw new Error(`Invalid ${file}: ${(validate.errors ?? []).map(describeError).join('; ')}`);
  }
  return data as NotionMap;
}

export function toMirrorRow(raw: RawRow): MirrorRow {
  const properties: MirrorRow['properties'] = {};
  let id = '';
  for (const [name, value] of Object.entries(raw.properties)) {
    properties[name] = fromNotionValue(value);
    if (value.type === 'title') id = String(properties[name] ?? '');
  }
  return { page_id: raw.pageId, last_edited_time: raw.lastEdited, id, properties };
}

export function readMirror(projectDir: string, db: string): MirrorFile | undefined {
  const file = mirrorFile(projectDir, db);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as MirrorFile;
}

export function writeMirror(projectDir: string, m: MirrorFile): void {
  mkdirSync(mirrorDir(projectDir), { recursive: true });
  writeFileAtomic(mirrorFile(projectDir, m.database), `${JSON.stringify(m, null, 2)}\n`);
}

/**
 * Mirrors every mapped database to .arima/mirror/<db>.json. The mirror is read-only for agents:
 * they propose changes through the outbox (spec §3.3). Returns the mirrors it wrote.
 */
export async function pullMirror(
  projectDir: string,
  port: NotionPort,
  map: NotionMap,
  opts: { now?: Date; runId?: string } = {},
): Promise<Map<string, MirrorFile>> {
  const out = new Map<string, MirrorFile>();
  const fetchedAt = (opts.now ?? new Date()).toISOString();
  for (const [db, info] of Object.entries(map.databases)) {
    const rows = (await port.queryRows(info.data_source_id)).map(toMirrorRow);
    const file: MirrorFile = { schema_version: 1, database: db, fetched_at: fetchedAt, rows };
    writeMirror(projectDir, file);
    out.set(db, file);
    await appendEvent(projectDir, {
      type: 'notion.pull',
      actor: 'system',
      ...(opts.runId !== undefined ? { run_id: opts.runId } : {}),
      data: { database: db, rows: rows.length },
    });
  }
  return out;
}

/** The row whose ARIMA ID (title) equals `id`, or whose page id does. Undefined if none; throws if ambiguous. */
export function findRow(m: MirrorFile | undefined, id: string): MirrorRow | undefined {
  if (m === undefined) return undefined;
  const byId = m.rows.filter((r) => r.id === id);
  if (byId.length > 1) throw new Error(`${byId.length} rows in ${m.database} have the ID "${id}"`);
  if (byId[0] !== undefined) return byId[0];
  return m.rows.find((r) => r.page_id === id);
}
