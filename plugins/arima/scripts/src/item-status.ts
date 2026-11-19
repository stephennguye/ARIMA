import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvent, readEvents } from './events.js';
import { ITEM_STATUSES, readItem, updateItem } from './item.js';
import type { ItemRecord, ItemStatus } from './item.js';
import { registerEngineEntry } from './notion/allocations.js';
import { findRow, readMirror } from './notion/mirror.js';
import { enqueue, outboxDir } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';
import { transition } from './state-machine.js';
import type { Actor, Applied, Facts, ItemState, Refusal } from './state-machine.js';

/**
 * Status ownership (spec 7.1, 9.3; WP-108). The engine is the only writer of a story's `Status`:
 * `moveItem` asks the state machine, and only an accepted transition updates the counters, logs
 * `item.status` and enqueues the Notion write. The write is an engine entry (registered, so push
 * lets it carry `Status`); an agent's outbox entry with `Status` is still refused, whatever its
 * file name. A human who edits `Status` in Notion wins: `reconcileStatuses` adopts the edit from
 * the mirror and logs it, instead of fighting it (spec 3.3).
 *
 * Scope: the stories database (types Story, Bug fix, Tech task, Spike). Bugs, incidents and change
 * requests have their own status lists and are handled by the packages that own them.
 */

/** Prefix of the outbox entries the state machine writes; the dispatcher pushes with `{ idPrefix: ENGINE_STATUS_PREFIX }`. */
export const ENGINE_STATUS_PREFIX = 'st-';

const isStatus = (v: unknown): v is ItemStatus =>
  typeof v === 'string' && (ITEM_STATUSES as readonly string[]).includes(v);

type BlockedFrom = Exclude<ItemRecord['blocked_from'], undefined>;

const isStory = (id: string): boolean => /^US-\d+$/.test(id);

export interface MoveInput {
  projectDir: string;
  /** A story id (US-nnn). */
  item: string;
  to: ItemStatus;
  actor: Actor;
  facts: Facts;
  /** The engine run making the move (it needs a `run.start` event so push can bind the entry). */
  runId: string;
  now?: Date;
}

export type MoveResult =
  | { ok: true; applied: Applied; entry: string }
  | Refusal
  | { ok: false; code: 'unknown_item'; message: string };

/** The status Notion holds for a story, from the mirror. */
export function mirrorStatus(projectDir: string, item: string): ItemStatus | undefined {
  const s = findRow(readMirror(projectDir, 'stories'), item)?.properties['Status'];
  return isStatus(s) ? s : undefined;
}

const stateOf = (status: ItemStatus, c: ItemRecord): ItemState => ({
  status,
  attempt: c.attempt,
  run_failures: c.run_failures,
  blocked_from: c.blocked_from ?? null,
  blocked_reason: c.blocked_reason ?? null,
});

function nextEntryId(projectDir: string, runId: string, item: string): string {
  const dirs = [
    outboxDir(projectDir),
    path.join(outboxDir(projectDir), 'applied'),
    path.join(outboxDir(projectDir), 'rejected'),
    path.join(outboxDir(projectDir), 'conflicts'),
  ];
  const taken = new Set(dirs.filter(existsSync).flatMap((d) => readdirSync(d)));
  for (let n = 1; ; n += 1) {
    const id = `${ENGINE_STATUS_PREFIX}${runId}-${item}-${n}`;
    if (!taken.has(`${id}.json`)) return id;
  }
}

/**
 * Moves a story through the state machine and, when accepted, applies it: counters, `item.status`
 * event, and the engine-made `Status` write in the outbox. A refusal changes nothing. The caller
 * raises the question when `applied.question` is set (WP-141).
 */
export async function moveItem(i: MoveInput): Promise<MoveResult> {
  if (!isStory(i.item))
    return { ok: false, code: 'unknown_item', message: `${i.item} is not a story id (US-nnn)` };
  const status = mirrorStatus(i.projectDir, i.item);
  if (status === undefined)
    return {
      ok: false,
      code: 'unknown_item',
      message: `${i.item} has no Status in the stories mirror (run arima-notion pull)`,
    };
  const counters = readItem(i.projectDir, i.item);
  const r = transition(stateOf(status, counters), { to: i.to, actor: i.actor, facts: i.facts });
  if (!r.ok) return r;

  await updateItem(i.projectDir, i.item, (c) => ({
    ...c,
    attempt: r.next.attempt,
    run_failures: r.next.run_failures,
    blocked_from: (r.next.blocked_from ?? null) as BlockedFrom,
    blocked_reason: r.next.blocked_reason ?? null,
  }));
  await appendEvent(i.projectDir, { ...r.event, run_id: i.runId, item: i.item });

  const now = i.now ?? new Date();
  const id = nextEntryId(i.projectDir, i.runId, i.item);
  await registerEngineEntry(i.projectDir, id);
  const entry: OutboxEntry = {
    id,
    created_at: now.toISOString(),
    run_id: i.runId,
    role: 'orchestrator',
    op: 'update',
    database: 'stories',
    item_id: i.item,
    properties: {
      Status: r.notion.value,
      Attempt: r.next.attempt,
      'Blocked reason': r.next.blocked_reason ?? '',
    },
  };
  enqueue(i.projectDir, entry);
  return { ok: true, applied: r, entry: id };
}

export interface Adopted {
  item: string;
  from: ItemStatus;
  to: ItemStatus;
}

/** The status the engine last knew for an item: the `to` of its latest `item.status` event. */
function lastKnown(projectDir: string, item: string): ItemStatus | undefined {
  let last: ItemStatus | undefined;
  for (const e of readEvents(projectDir))
    if (e.type === 'item.status' && e.item === item && isStatus(e.data?.['to']))
      last = e.data['to'];
  return last;
}

/** Items with an engine Status write still waiting in the outbox: the mirror lags behind them, so they are not human edits. */
function pendingStatusItems(projectDir: string): Set<string> {
  const dir = outboxDir(projectDir);
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const e = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as OutboxEntry;
      if (
        e.database === 'stories' &&
        e.item_id !== undefined &&
        e.properties?.['Status'] !== undefined
      )
        out.add(e.item_id);
    } catch {
      /* a broken file is push's problem */
    }
  }
  return out;
}

/**
 * Finds stories whose `Status` in the mirror is not what the engine last set: a human edited it in
 * Notion, and the human wins (spec 3.3). The edit is adopted: counters follow (leaving or entering
 * Blocked, run failures reset) and `item.status` is logged with actor `human`. Stories with an
 * engine write still pending, stories the engine never moved, and values that are not a status are
 * left alone. Idempotent: a second call with the same mirror adopts nothing.
 */
export async function reconcileStatuses(projectDir: string): Promise<Adopted[]> {
  const mirror = readMirror(projectDir, 'stories');
  if (mirror === undefined) return [];
  const pending = pendingStatusItems(projectDir);
  const adopted: Adopted[] = [];
  for (const row of mirror.rows) {
    const item = row.id;
    if (!isStory(item) || pending.has(item)) continue;
    const seen = row.properties['Status'];
    if (!isStatus(seen)) continue;
    const known = lastKnown(projectDir, item);
    if (known === undefined || known === seen) continue;
    await updateItem(projectDir, item, (c) => ({
      ...c,
      run_failures: 0,
      blocked_from:
        seen === 'Blocked'
          ? (((known === 'Blocked' ? c.blocked_from : known) as BlockedFrom | undefined) ?? null)
          : null,
      blocked_reason: seen === 'Blocked' ? (c.blocked_reason ?? 'set in Notion') : null,
    }));
    await appendEvent(projectDir, {
      type: 'item.status',
      actor: 'human',
      item,
      data: { from: known, to: seen, source: 'notion' },
    });
    adopted.push({ item, from: known, to: seen });
  }
  return adopted;
}
