// Deterministic graders for the Stage 1 scenarios (WP-150, F10 5.2 step 4). Pure functions over the end
// state of a world: each returns the problems it found (empty = pass), so a scenario reads
// `expect(problems(...)).toEqual([])` and a failure says what was wrong. No model, no network.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { findAttribution } from '../../plugins/arima/scripts/src/attribution.js';
import type { ArimaEvent, EventType } from '../../plugins/arima/scripts/src/events.js';
import type { LedgerRow } from '../../plugins/arima/scripts/src/ledger.js';
import { TRANSITIONS } from '../../plugins/arima/scripts/src/state-machine.js';

/** The events' types appear in this order (other events may sit between them). */
export function eventSubsequence(events: readonly ArimaEvent[], want: readonly EventType[]): string[] {
  let i = 0;
  for (const e of events) if (i < want.length && e.type === want[i]) i += 1;
  return i === want.length ? [] : [`missing "${want[i]}" after ${i} of ${want.length} expected events`];
}

/** Every `item.status` edge of the item is a row of the contract table for that actor, in the given order. */
export function stateTrace(events: readonly ArimaEvent[], item: string, path_: readonly string[]): string[] {
  const mine = events.filter((e) => e.type === 'item.status' && e.item === item);
  const out: string[] = [];
  const got = mine.map((e) => String(e.data?.['to']));
  if (JSON.stringify(got) !== JSON.stringify(path_))
    out.push(`${item}: path ${got.join(' > ')} is not ${path_.join(' > ')}`);
  for (const e of mine) {
    const row = TRANSITIONS.find((t) => t.from === e.data?.['from'] && t.to === e.data?.['to']);
    if (row === undefined) out.push(`${item}: ${String(e.data?.['from'])} > ${String(e.data?.['to'])} is not in the table`);
    else if (!(row.actors as readonly string[]).includes(e.actor))
      out.push(`${item}: actor ${e.actor} may not make ${row.from} > ${row.to}`);
  }
  return out;
}

/** One ledger row per run, no run id twice, every row schema-shaped enough to sum. */
export function ledgerRows(rows: readonly LedgerRow[], runsDispatched: number): string[] {
  const out: string[] = [];
  if (rows.length !== runsDispatched) out.push(`${rows.length} ledger rows for ${runsDispatched} runs`);
  if (new Set(rows.map((r) => r.run_id)).size !== rows.length) out.push('a run id appears twice in the ledger');
  for (const r of rows) if (!Number.isFinite(r.cost_usd) || r.cost_usd < 0) out.push(`${r.run_id}: bad cost`);
  return out;
}

/** The sum the cost of an item must equal, however many sources report it. */
export function costEquals(rows: readonly LedgerRow[], item: string, reported: number): string[] {
  const sum = rows.filter((r) => r.item === item).reduce((n, r) => n + r.cost_usd, 0);
  return Math.abs(sum - reported) < 1e-6 ? [] : [`${item}: reported ${reported} but the ledger sums to ${sum}`];
}

/** No AI attribution in any commit message, PR title or PR body that was published. */
export function noAttribution(texts: readonly string[]): string[] {
  return texts.flatMap((t) => (findAttribution(t).length > 0 ? [`attribution in: ${t.slice(0, 60)}`] : []));
}

/** The run-id counter may move on a refusal (a refused run still takes an id, and ids are never reused): it is not part of a snapshot, nor are the event log and the lock. */
/** A hash of everything a refused action must not change: the `.arima` files (not the logs, which record the refusal) and the given refs. */
export function snapshotFiles(projectDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const f = path.join(dir, name);
      const rel = path.relative(projectDir, f).replace(/\\/g, '/');
      if (['.arima/events.jsonl', '.arima/run.lock', '.arima/state/run-seq.json'].includes(rel) || rel.startsWith('.arima/runs')) continue;
      if (statSync(f).isDirectory()) walk(f);
      else out[rel] = createHash('sha256').update(readFileSync(f)).digest('hex');
    }
  };
  walk(path.join(projectDir, '.arima'));
  return out;
}

export const snapshotOf = (projectDir: string, extra: readonly string[] = []): string =>
  createHash('sha256')
    .update(JSON.stringify([snapshotFiles(projectDir), extra]))
    .digest('hex');

/** Which files under .arima changed between two snapshots (the logs of a refusal itself are not part of a snapshot). */
export function snapshotDiff(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}

/** The count of rows per database must not change on a second pass (no duplicates). */
export function noDuplicateRows(before: Record<string, number>, after: Record<string, number>): string[] {
  return Object.keys(before).flatMap((k) => (before[k] === after[k] ? [] : [`${k}: ${before[k]} rows became ${after[k]}`]));
}

/** What a negative control looks like: the same action, in its allowed form, succeeds. */
export interface Controlled<T> {
  /** The action that must be refused. */
  refused: () => Promise<T>;
  /** The same action done properly. */
  allowed: () => Promise<T>;
}

export async function withNegativeControl<T>(
  c: Controlled<T>,
  isRefusal: (r: T) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  if (!isRefusal(await c.refused())) out.push('the action that had to be refused was not refused');
  if (isRefusal(await c.allowed())) out.push('the allowed form was refused too: the harness refuses everything');
  return out;
}
