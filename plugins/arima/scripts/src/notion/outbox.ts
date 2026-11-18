import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { appendEvent } from '../events.js';
import { writeFileAtomic } from '../lib/atomic-file.js';
import { describeError, getValidator } from '../lib/schema.js';
import { findSecrets } from '../lib/secrets.js';
import { findRow, pullMirror, readMirror, writeMirror } from './mirror.js';
import type { MirrorFile, MirrorRow } from './mirror.js';
import type { MapDatabase, NotionMap } from './mapper.js';
import type { NotionPort } from './port.js';
import { LAST_WRITTEN_BY_RUN, NON_UNIQUE_TITLES, RETIRE_STATUS } from './schema.js';
import type { DbKey } from './schema.js';
import { ValueError, markdownToBlocks, toNotionValue } from './values.js';

export interface OutboxEntry {
  id: string;
  created_at: string;
  run_id: string;
  role: string;
  op: 'create' | 'update' | 'append_content' | 'retire';
  database: DbKey;
  item_id?: string;
  properties?: Record<string, unknown>;
  content_markdown?: string;
  base_last_edited?: string;
}

export const outboxDir = (projectDir: string): string => path.join(projectDir, '.arima', 'outbox');

/** Kinds of secret found in the parts of an entry that would be written to Notion. */
function secretsIn(entry: OutboxEntry): string[] {
  return findSecrets(
    JSON.stringify({ p: entry.properties ?? {}, c: entry.content_markdown ?? '' }),
  );
}

export interface PushReport {
  applied: string[];
  rejected: { id: string; reason: string }[];
  conflicts: string[];
  /** Left in the outbox because Notion could not be reached or errored; retried next run. */
  deferred: string[];
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Writes a validated outbox entry (what an agent or script does to propose a Notion change). */
export function enqueue(projectDir: string, entry: OutboxEntry): string {
  const validate = getValidator('outbox');
  if (!validate(entry)) {
    throw new Error(
      `Invalid outbox entry: ${(validate.errors ?? []).map(describeError).join('; ')}`,
    );
  }
  const leaked = secretsIn(entry);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing outbox entry ${entry.id}: it looks like it contains a secret (${leaked.join(', ')})`,
    );
  }
  const dir = outboxDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.id}.json`);
  if (existsSync(file)) throw new Error(`outbox entry ${entry.id} already exists`);
  writeFileAtomic(file, `${JSON.stringify(entry, null, 2)}\n`);
  return file;
}

interface Pending {
  file: string;
  entry: OutboxEntry;
}

type Settled =
  | { kind: 'applied'; pageId: string }
  | { kind: 'rejected'; reason: string; refused?: boolean }
  | { kind: 'conflict'; humanEditedAt: string }
  | { kind: 'deferred'; reason: string };

function listPending(projectDir: string, report: PushReport): Pending[] {
  const dir = outboxDir(projectDir);
  if (!existsSync(dir)) return [];
  const validate = getValidator('outbox');
  const out: Pending[] = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const file = path.join(dir, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      settle(
        projectDir,
        file,
        name.replace(/\.json$/, ''),
        { kind: 'rejected', reason: 'not valid JSON' },
        report,
      );
      continue;
    }
    if (!validate(data)) {
      const reason = `invalid outbox entry: ${(validate.errors ?? []).map(describeError).join('; ')}`;
      settle(projectDir, file, name.replace(/\.json$/, ''), { kind: 'rejected', reason }, report);
      continue;
    }
    out.push({ file, entry: data as OutboxEntry });
  }
  return out.sort(
    (a, b) =>
      a.entry.created_at.localeCompare(b.entry.created_at) || a.entry.id.localeCompare(b.entry.id),
  );
}

/** Moves a processed entry out of the outbox root and records its outcome beside it. */
function settle(
  projectDir: string,
  file: string,
  id: string,
  result: Settled,
  report: PushReport,
): void {
  const bucket =
    result.kind === 'applied'
      ? 'applied'
      : result.kind === 'conflict'
        ? 'conflicts'
        : result.kind === 'rejected'
          ? 'rejected'
          : undefined;
  if (result.kind === 'applied') report.applied.push(id);
  else if (result.kind === 'conflict') report.conflicts.push(id);
  else if (result.kind === 'rejected') report.rejected.push({ id, reason: result.reason });
  else report.deferred.push(id);
  if (bucket === undefined) return; // deferred: stays where it is
  const dir = path.join(outboxDir(projectDir), bucket);
  mkdirSync(dir, { recursive: true });
  renameSync(file, path.join(dir, `${id}.json`));
  writeFileSync(
    path.join(dir, `${id}.result.json`),
    `${JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** A thrown API error is permanent (4xx other than 429) or transient (anything else). */
function classify(e: unknown): 'permanent' | 'transient' {
  const status = (e as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429
    ? 'permanent'
    : 'transient';
}

function plainOf(v: unknown): unknown {
  return v;
}

/**
 * Applies the outbox to Notion (spec §3.3, §9.3). Per entry: validate, refuse human-only fields,
 * refuse anything that is not a create/update/append/retire (there is no delete), detect a human
 * edit made since the agent last looked and keep it, then write with the run id stamped on the
 * row. Entries Notion cannot take right now stay in the outbox for the next run.
 */
export async function pushOutbox(
  projectDir: string,
  port: NotionPort,
  map: NotionMap,
  opts: {
    now?: Date;
    /**
     * Let entries write the Status property. Off by default: until the ticket state machine
     * exists, an agent's outbox entry must not be able to mark a story Done. Only a human-run
     * command (init, or `arima-notion push --allow-status-writes`) turns this on.
     */
    allowStatusWrites?: boolean;
  } = {},
): Promise<PushReport> {
  const report: PushReport = { applied: [], rejected: [], conflicts: [], deferred: [] };
  const pending = listPending(projectDir, report);
  if (pending.length === 0) return report;

  // The mirror as the agents saw it is the baseline for conflict detection; then refresh it.
  const baseline = new Map<string, MirrorFile | undefined>(
    Object.keys(map.databases).map((db) => [db, readMirror(projectDir, db)]),
  );
  let mirrors: Map<string, MirrorFile>;
  try {
    mirrors = await pullMirror(projectDir, port, map, opts.now ? { now: opts.now } : {});
  } catch (e) {
    for (const p of pending) report.deferred.push(p.entry.id);
    await appendEvent(projectDir, {
      type: 'notion.push',
      actor: 'system',
      data: { deferred: pending.length, reason: errText(e) },
    });
    return report;
  }

  const ownWrites = new Map<string, string>();
  const resolveAnywhere = (id: string): string => {
    if (UUID.test(id)) return id;
    const hits: string[] = [];
    for (const m of mirrors.values()) for (const r of m.rows) if (r.id === id) hits.push(r.page_id);
    if (hits.length !== 1)
      throw new ValueError(
        hits.length === 0
          ? `relation target "${id}" does not exist`
          : `relation target "${id}" is ambiguous`,
      );
    return hits[0] as string;
  };

  for (const { file, entry } of pending) {
    let result: Settled;
    try {
      result = await applyEntry(entry);
    } catch (e) {
      result =
        e instanceof ValueError
          ? { kind: 'rejected', reason: e.message }
          : classify(e) === 'permanent'
            ? { kind: 'rejected', reason: `Notion refused the change: ${errText(e)}` }
            : { kind: 'deferred', reason: errText(e) };
    }
    settle(projectDir, file, entry.id, result, report);
    const base = { actor: entry.role, run_id: entry.run_id, item: entry.item_id ?? '' };
    const common = { entry: entry.id, op: entry.op, database: entry.database };
    if (result.kind === 'applied') {
      await appendEvent(projectDir, {
        type: 'notion.push',
        actor: 'system',
        run_id: entry.run_id,
        ...(entry.item_id ? { item: entry.item_id } : {}),
        data: { ...common, page_id: result.pageId },
      });
    } else if (result.kind === 'conflict') {
      await appendEvent(projectDir, {
        type: 'notion.conflict',
        actor: 'system',
        run_id: entry.run_id,
        ...(entry.item_id ? { item: entry.item_id } : {}),
        data: { ...common, human_edited_at: result.humanEditedAt },
      });
    } else if (result.kind === 'rejected') {
      await appendEvent(projectDir, {
        type: 'notion.refused',
        actor: 'system',
        run_id: entry.run_id,
        ...(base.item ? { item: base.item } : {}),
        data: { ...common, reason: result.reason },
      });
    }
    if (result.kind === 'deferred') break; // Notion is struggling: stop, retry next run
  }
  for (const m of mirrors.values()) writeMirror(projectDir, m);
  return report;

  async function applyEntry(entry: OutboxEntry): Promise<Settled> {
    const db = map.databases[entry.database] as MapDatabase | undefined;
    if (db === undefined)
      return { kind: 'rejected', reason: `database "${entry.database}" is not in notion-map.json` };
    const mirror = mirrors.get(entry.database) as MirrorFile;

    // Secrets never go to Notion (spec §11.3), whoever wrote the entry.
    const leaked = secretsIn(entry);
    if (leaked.length > 0) {
      return {
        kind: 'rejected',
        refused: true,
        reason: `the entry looks like it contains a secret (${leaked.join(', ')}); secrets must never be written to Notion (spec §11.3)`,
      };
    }

    // Property checks: known, writable, not human-only.
    const props = entry.properties ?? {};
    for (const [name, value] of Object.entries(props)) {
      const def = db.properties[name];
      if (def === undefined)
        return { kind: 'rejected', reason: `unknown property "${name}" on ${db.title}` };
      if (name === LAST_WRITTEN_BY_RUN)
        return { kind: 'rejected', reason: `"${name}" is stamped by ARIMA and cannot be set` };
      if (name === 'Status' && opts.allowStatusWrites !== true) {
        return {
          kind: 'rejected',
          refused: true,
          reason: `"Status" on ${db.title} cannot be written from the outbox until the ticket state machine exists (pass --allow-status-writes, which only a human may do)`,
        };
      }
      if (def.human_only === true) {
        return {
          kind: 'rejected',
          refused: true,
          reason: `"${name}" on ${db.title} is a human-only field; agents must not write it (spec §9.3)`,
        };
      }
      const flagged = def.human_only_values;
      if (flagged !== undefined) {
        const values = Array.isArray(value) ? value : [value];
        const hit = values.find((v) => typeof v === 'string' && flagged.includes(v));
        if (hit !== undefined) {
          return {
            kind: 'rejected',
            refused: true,
            reason: `"${String(hit)}" is a human-only value of "${name}" on ${db.title} (spec §9.3)`,
          };
        }
      }
    }

    const notionProps = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(props)) {
        out[name] = toNotionValue(
          (db.properties[name] as { type: string }).type,
          name,
          value,
          resolveAnywhere,
        );
      }
      out[LAST_WRITTEN_BY_RUN] = { rich_text: [{ type: 'text', text: { content: entry.run_id } }] };
      return out;
    };
    const titleName = Object.entries(db.properties).find(
      ([, p]) => p.type === 'title',
    )?.[0] as string;

    if (entry.op === 'create') {
      if (typeof props[titleName] !== 'string' || props[titleName] === '') {
        return { kind: 'rejected', reason: `create needs the title property "${titleName}"` };
      }
      const title = props[titleName] as string;
      const same = mirror.rows.filter((r) => r.id === title);
      const mine = same.find((r) => r.properties[LAST_WRITTEN_BY_RUN] === entry.run_id);
      if (mine !== undefined) return { kind: 'applied', pageId: mine.page_id }; // already applied (retry)
      if (same.length > 0 && !NON_UNIQUE_TITLES.has(entry.database)) {
        return { kind: 'rejected', reason: `${db.title} already has a row "${title}"; use update` };
      }
      const created = await port.createPage(
        db.data_source_id,
        notionProps(),
        entry.content_markdown ? markdownToBlocks(entry.content_markdown) : undefined,
      );
      ownWrites.set(created.pageId, created.lastEdited);
      const row: MirrorRow = {
        page_id: created.pageId,
        last_edited_time: created.lastEdited,
        id: title,
        properties: { ...(props as MirrorRow['properties']), [LAST_WRITTEN_BY_RUN]: entry.run_id },
      };
      mirror.rows.push(row);
      return { kind: 'applied', pageId: created.pageId };
    }

    // update / append_content / retire all target an existing row
    const itemId = entry.item_id as string;
    const row = findRow(mirror, itemId);
    if (row === undefined) return { kind: 'rejected', reason: `no row "${itemId}" in ${db.title}` };

    const status = RETIRE_STATUS[entry.database];
    if (entry.op === 'retire') {
      if (status === undefined)
        return {
          kind: 'rejected',
          reason: `${db.title} has no retired status; its rows cannot be retired`,
        };
      if (!('Status' in db.properties))
        return { kind: 'rejected', reason: `${db.title} has no Status property` };
      if (row.properties['Status'] === status) return { kind: 'applied', pageId: row.page_id };
    }

    // A human edit since the agent looked wins.
    // The mirror the orchestrator itself holds is the baseline; an entry may only make the check
    // STRICTER (an earlier base), never looser, so an agent cannot hide a human edit by claiming a
    // late "last seen" time.
    const mirrored = baseline
      .get(entry.database)
      ?.rows.find((r) => r.page_id === row.page_id)?.last_edited_time;
    const claimed = entry.base_last_edited;
    const basis =
      mirrored !== undefined && claimed !== undefined
        ? Date.parse(claimed) < Date.parse(mirrored)
          ? claimed
          : mirrored
        : (mirrored ?? claimed);
    const current = await port.getPageLastEdited(row.page_id);
    if (
      basis !== undefined &&
      Date.parse(current) > Date.parse(basis) &&
      current !== ownWrites.get(row.page_id)
    ) {
      return { kind: 'conflict', humanEditedAt: current };
    }

    let written: { lastEdited: string };
    if (entry.op === 'update') {
      written = await port.updatePage(row.page_id, notionProps());
      Object.assign(row.properties, props);
    } else if (entry.op === 'append_content') {
      if (!entry.content_markdown)
        return { kind: 'rejected', reason: 'append_content needs content_markdown' };
      await port.appendChildren(row.page_id, markdownToBlocks(entry.content_markdown));
      written = await port.updatePage(row.page_id, {
        [LAST_WRITTEN_BY_RUN]: { rich_text: [{ type: 'text', text: { content: entry.run_id } }] },
      });
    } else {
      const statusType = (db.properties['Status'] as { type: string }).type;
      written = await port.updatePage(row.page_id, {
        ...notionProps(),
        Status: toNotionValue(statusType, 'Status', status, resolveAnywhere),
      });
      row.properties['Status'] = plainOf(status) as string;
    }
    row.properties[LAST_WRITTEN_BY_RUN] = entry.run_id;
    row.last_edited_time = written.lastEdited;
    ownWrites.set(row.page_id, written.lastEdited);
    return { kind: 'applied', pageId: row.page_id };
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
