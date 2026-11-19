import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { appendEvent, readEvents } from './events.js';
import type { LedgerRow } from './ledger.js';
import { describeError, getValidator } from './lib/schema.js';
import { findRow, readMirror } from './notion/mirror.js';
import { enqueue, outboxDir } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';
import { registerEngineEntry } from './notion/allocations.js';
import { storyBudget } from './story-budget.js';

/**
 * Cost roll-up (spec 13.1 to 13.6; F05 5.2; WP-131). Pure functions over the run ledger. Costs are
 * summed in whole micro-dollars, so every partition (by item, role, phase, day) adds up to the
 * total EXACTLY: the per-story cost is the ledger sum, not an estimate of it. `cost_usd` is summed
 * as stored; it is already the per-run difference for resumed sessions (spec 13.6), never
 * recomputed from tokens. All numbers are estimated consumption, not money spent on a seat plan.
 */

const MICRO = 1_000_000;
const micro = (usd: number): number => Math.round(usd * MICRO);
export const usd = (m: number): number => m / MICRO;

export interface Totals {
  runs: number;
  /** Micro-USD; use `usd()` to show. */
  cost_micro: number;
  turns: number;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  duration_ms: number;
  rework_micro: number;
  rework_runs: number;
  failed_runs: number;
}

const zero = (): Totals => ({
  runs: 0,
  cost_micro: 0,
  turns: 0,
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
  duration_ms: 0,
  rework_micro: 0,
  rework_runs: 0,
  failed_runs: 0,
});

function add(t: Totals, r: LedgerRow): void {
  t.runs += 1;
  t.cost_micro += micro(r.cost_usd);
  t.turns += r.num_turns;
  t.input += r.tokens.input;
  t.output += r.tokens.output;
  t.cache_read += r.tokens.cache_read;
  t.cache_creation += r.tokens.cache_creation;
  t.duration_ms += r.duration_ms;
  if (r.is_rework) {
    t.rework_micro += micro(r.cost_usd);
    t.rework_runs += 1;
  }
  if (r.result === 'fail' || r.result === 'error') t.failed_runs += 1;
}

export interface Filter {
  from?: string;
  to?: string;
  milestone?: string;
  phase?: number;
  item?: string;
  role?: string;
}

export const filterRows = (rows: readonly LedgerRow[], f: Filter): LedgerRow[] =>
  rows.filter(
    (r) =>
      (f.from === undefined || r.date >= f.from) &&
      (f.to === undefined || r.date <= f.to) &&
      (f.milestone === undefined || r.milestone === f.milestone) &&
      (f.phase === undefined || r.phase === f.phase) &&
      (f.item === undefined || r.item === f.item) &&
      (f.role === undefined || r.role === f.role),
  );

export interface Rollup {
  total: Totals;
  byItem: Map<string, Totals>;
  byRole: Map<string, Totals>;
  byPhase: Map<number, Totals>;
  byDay: Map<string, Totals>;
  byTier: Map<string, Totals>;
  byMilestone: Map<string, Totals>;
  /** Orchestrator and other runs with no item: reported, never spread over stories. */
  overhead: Totals;
}

const bump = <K>(m: Map<K, Totals>, k: K, r: LedgerRow): void => {
  let t = m.get(k);
  if (t === undefined) m.set(k, (t = zero()));
  add(t, r);
};

export function rollup(rows: readonly LedgerRow[], filter: Filter = {}): Rollup {
  const out: Rollup = {
    total: zero(),
    byItem: new Map(),
    byRole: new Map(),
    byPhase: new Map(),
    byDay: new Map(),
    byTier: new Map(),
    byMilestone: new Map(),
    overhead: zero(),
  };
  for (const r of filterRows(rows, filter)) {
    add(out.total, r);
    bump(out.byItem, r.item, r);
    bump(out.byRole, r.role, r);
    bump(out.byPhase, r.phase, r);
    bump(out.byDay, r.date, r);
    bump(out.byTier, r.model_tier ?? 'unknown', r);
    if (r.milestone) bump(out.byMilestone, r.milestone, r);
    if (r.item === 'none') add(out.overhead, r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Metrics (spec 13.4) that the ledger alone can give

export interface Metrics {
  /** rework cost / total cost (RD-F05-2); undefined when nothing was spent. */
  reworkShare: number | undefined;
  /** cache_read / (input + cache_read + cache_creation). */
  cacheEfficiency: number | undefined;
  turnsPerRun: number | undefined;
  runFailureRate: number | undefined;
  /** QA runs at attempt 1 that passed / QA runs at attempt 1. */
  firstPassQa: { passed: number; of: number; rate: number | undefined };
}

export function metrics(rows: readonly LedgerRow[], filter: Filter = {}): Metrics {
  const r = filterRows(rows, filter);
  const t = rollup(rows, filter).total;
  const qa = r.filter((x) => x.role === 'qa' && x.attempt === 1 && x.item !== 'none');
  const passed = qa.filter((x) => x.result === 'pass').length;
  const denom = t.input + t.cache_read + t.cache_creation;
  return {
    reworkShare: t.cost_micro > 0 ? t.rework_micro / t.cost_micro : undefined,
    cacheEfficiency: denom > 0 ? t.cache_read / denom : undefined,
    turnsPerRun: t.runs > 0 ? t.turns / t.runs : undefined,
    runFailureRate: t.runs > 0 ? t.failed_runs / t.runs : undefined,
    firstPassQa: { passed, of: qa.length, rate: qa.length > 0 ? passed / qa.length : undefined },
  };
}

// ---------------------------------------------------------------------------------------------
// Estimate accuracy by size (spec 13.4, RD-F05-3)

export interface StoryMeta {
  id: string;
  size?: string | undefined;
  /** The story budget: `Budget USD` on the row, else the size default (see `storyBudget`). */
  budget: number;
}

/** Stories from the Notion mirror, with their budgets (RD-F05-4). */
export function storyMetas(
  projectDir: string,
  cfg: { perStoryDefault: number; bySize?: Partial<Record<'S' | 'M' | 'L', number>> },
): StoryMeta[] {
  const m = readMirror(projectDir, 'stories');
  return (m?.rows ?? [])
    .filter((r) => /^US-\d+$/.test(r.id))
    .map((r) => {
      const size =
        typeof r.properties['Complexity'] === 'string' ? r.properties['Complexity'] : undefined;
      const b = r.properties['Budget USD'];
      return {
        id: r.id,
        size,
        budget: storyBudget(cfg, { size, budget: typeof b === 'number' ? b : undefined }),
      };
    });
}

export interface Accuracy {
  size: string;
  /** Stories of this size that have cost. */
  n: number;
  actual: number;
  budget: number;
  /** actual / budget; undefined when n is below 3 ("too few"). */
  ratio: number | undefined;
  tooFew: boolean;
}

export const MIN_STORIES_FOR_ACCURACY = 3;

export function estimateAccuracy(
  rows: readonly LedgerRow[],
  stories: readonly StoryMeta[],
): Accuracy[] {
  const byItem = rollup(rows).byItem;
  const out: Accuracy[] = [];
  for (const size of ['S', 'M', 'L']) {
    const mine = stories.filter((s) => s.size === size && (byItem.get(s.id)?.cost_micro ?? 0) > 0);
    const actual = mine.reduce((a, s) => a + usd(byItem.get(s.id)?.cost_micro ?? 0), 0);
    const budget = mine.reduce((a, s) => a + s.budget, 0);
    const tooFew = mine.length < MIN_STORIES_FOR_ACCURACY;
    out.push({
      size,
      n: mine.length,
      actual,
      budget,
      ratio: tooFew || budget === 0 ? undefined : actual / budget,
      tooFew,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Alerts (spec 13.5 item 4): a story above 3x the median for its size; rework share above 30%

export interface CostAlert {
  kind: 'story_over_median' | 'rework_share';
  /** Item id or milestone id. */
  subject: string;
  detail: string;
  value: number;
}

export const STORY_MEDIAN_FACTOR = 3;
export const REWORK_SHARE_LIMIT = 0.3;
/** A milestone needs this many runs before its rework share can raise an alert (one rework run in a tiny sample is noise). */
export const MIN_RUNS_FOR_REWORK_ALERT = 3;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2;
};

export function costAlerts(rows: readonly LedgerRow[], stories: readonly StoryMeta[]): CostAlert[] {
  const out: CostAlert[] = [];
  const r = rollup(rows);
  for (const size of ['S', 'M', 'L']) {
    const mine = stories
      .filter((s) => s.size === size && (r.byItem.get(s.id)?.cost_micro ?? 0) > 0)
      .map((s) => ({ id: s.id, cost: usd(r.byItem.get(s.id)?.cost_micro ?? 0) }));
    if (mine.length < MIN_STORIES_FOR_ACCURACY) continue;
    const med = median(mine.map((m) => m.cost));
    for (const m of mine)
      if (m.cost > STORY_MEDIAN_FACTOR * med)
        out.push({
          kind: 'story_over_median',
          subject: m.id,
          value: m.cost,
          detail: `${m.id} cost ${m.cost.toFixed(2)}, more than ${STORY_MEDIAN_FACTOR}x the median ${med.toFixed(2)} of size ${size} stories`,
        });
  }
  for (const [ms, t] of r.byMilestone) {
    if (t.runs < MIN_RUNS_FOR_REWORK_ALERT || t.cost_micro === 0) continue;
    const share = t.rework_micro / t.cost_micro;
    if (share > REWORK_SHARE_LIMIT)
      out.push({
        kind: 'rework_share',
        subject: ms,
        value: share,
        detail: `${ms}: ${(share * 100).toFixed(0)}% of its cost is rework (limit ${REWORK_SHARE_LIMIT * 100}%)`,
      });
  }
  return out;
}

/** Records alerts not yet logged as `budget.alert` events (once per subject and kind). Returns the new ones. */
export async function recordCostAlerts(
  projectDir: string,
  alerts: readonly CostAlert[],
): Promise<CostAlert[]> {
  const seen = new Set(
    readEvents(projectDir)
      .filter((e) => e.type === 'budget.alert' && typeof e.data?.['cost_alert'] === 'string')
      .map((e) => `${e.data?.['cost_alert'] as string}|${e.data?.['subject'] as string}`),
  );
  const fresh = alerts.filter((a) => !seen.has(`${a.kind}|${a.subject}`));
  for (const a of fresh)
    await appendEvent(projectDir, {
      type: 'budget.alert',
      actor: 'system',
      data: { cost_alert: a.kind, subject: a.subject, value: a.value, detail: a.detail },
    });
  return fresh;
}

// ---------------------------------------------------------------------------------------------
// Total cost of ownership (spec 13.4): agents + infrastructure + human hours x rate

export interface ManualCosts {
  schema_version: 1;
  hourly_rate_usd?: number;
  infrastructure?: { date: string; description: string; usd: number }[];
  human_hours?: { date: string; who: string; hours: number; note?: string }[];
}

export const manualCostsFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'manual-costs.json');

/** The human-written bills file (hosting, CI minutes, hours worked). Absent means none. */
export function readManualCosts(projectDir: string): ManualCosts | undefined {
  const file = manualCostsFile(projectDir);
  if (!existsSync(file)) return undefined;
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const validate = getValidator('manual-costs');
  if (!validate(data))
    throw new Error(`${file}: ${(validate.errors ?? []).map(describeError).join('; ')}`);
  return data as ManualCosts;
}

export interface Tco {
  agents: number;
  infrastructure: number;
  humanHours: number;
  humanCost: number;
  total: number;
  /** True when a human-hours figure exists but no rate does: the human part is then not priced. */
  rateMissing: boolean;
}

export function totalCostOfOwnership(
  rows: readonly LedgerRow[],
  manual: ManualCosts | undefined,
  filter: Filter = {},
): Tco {
  const agents = usd(rollup(rows, filter).total.cost_micro);
  const inRange = (d: string): boolean =>
    (filter.from === undefined || d >= filter.from) && (filter.to === undefined || d <= filter.to);
  const infrastructure =
    (manual?.infrastructure ?? [])
      .filter((b) => inRange(b.date))
      .reduce((a, b) => a + micro(b.usd), 0) / MICRO;
  const humanHours = (manual?.human_hours ?? [])
    .filter((h) => inRange(h.date))
    .reduce((a, h) => a + h.hours, 0);
  const rate = manual?.hourly_rate_usd;
  const humanCost = rate === undefined ? 0 : Math.round(humanHours * rate * 100) / 100;
  return {
    agents,
    infrastructure,
    humanHours,
    humanCost,
    total: Math.round((agents + infrastructure + humanCost) * 1e6) / 1e6,
    rateMissing: rate === undefined && humanHours > 0,
  };
}

// ---------------------------------------------------------------------------------------------
// The Notion Cost log: one row per (date, role, phase, item); a re-sync updates, never duplicates

export interface CostLogRow {
  key: string;
  date: string;
  role: string;
  phase: number;
  item: string;
  milestone?: string | undefined;
  totals: Totals;
}

export const costLogKey = (date: string, role: string, phase: number, item: string): string =>
  `${date}|${role}|${phase}|${item}`;

export function costLogRows(rows: readonly LedgerRow[]): CostLogRow[] {
  const map = new Map<string, CostLogRow>();
  for (const r of rows) {
    const key = costLogKey(r.date, r.role, r.phase, r.item);
    let row = map.get(key);
    if (row === undefined)
      map.set(
        key,
        (row = {
          key,
          date: r.date,
          role: r.role,
          phase: r.phase,
          item: r.item,
          milestone: r.milestone ?? undefined,
          totals: zero(),
        }),
      );
    add(row.totals, r);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const properties = (r: CostLogRow): Record<string, unknown> => ({
  Role: r.role,
  Phase: r.phase,
  Runs: r.totals.runs,
  'Input tokens': r.totals.input,
  'Output tokens': r.totals.output,
  'Cache-read tokens': r.totals.cache_read,
  'Cost USD': usd(r.totals.cost_micro),
  'Agent minutes': Math.round((r.totals.duration_ms / 60000) * 100) / 100,
  Rework: usd(r.totals.rework_micro),
  Item: r.item,
});

/**
 * Queues the Cost log rows (title `date|role|phase|item`). A row already in the mirror with the
 * same values is left alone; with other values it is updated; otherwise it is created. Returns the
 * entry ids. Needs a `run.start` event for `runId` (push binds entries to runs).
 */
/** Cost log keys that already have an entry waiting in the outbox (a second sync before the push must not queue a duplicate). */
function pendingCostLogKeys(projectDir: string): Set<string> {
  const dir = outboxDir(projectDir);
  const keys = new Set<string>();
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const e = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as OutboxEntry;
      if (e.database !== 'cost_log') continue;
      const k = e.op === 'create' ? e.properties?.['Date'] : e.item_id;
      if (typeof k === 'string') keys.add(k);
    } catch {
      /* a broken file is push's problem */
    }
  }
  return keys;
}

export async function syncCostLog(o: {
  projectDir: string;
  runId: string;
  rows: readonly LedgerRow[];
  now?: Date;
}): Promise<{ created: number; updated: number; unchanged: number; entries: string[] }> {
  const log = readMirror(o.projectDir, 'cost_log');
  const milestones = readMirror(o.projectDir, 'milestones');
  const now = o.now ?? new Date();
  const pending = pendingCostLogKeys(o.projectDir);
  const res = { created: 0, updated: 0, unchanged: 0, entries: [] as string[] };
  let n = 0;
  for (const r of costLogRows(o.rows)) {
    if (pending.has(r.key)) {
      res.unchanged += 1;
      continue;
    }
    const props = properties(r);
    const existing = findRow(log, r.key);
    if (
      existing !== undefined &&
      Object.entries(props).every(
        ([k, v]) => JSON.stringify(existing.properties[k] ?? null) === JSON.stringify(v),
      )
    ) {
      res.unchanged += 1;
      continue;
    }
    n += 1;
    const withMs =
      r.milestone !== undefined && findRow(milestones, r.milestone) !== undefined
        ? { Milestone: [r.milestone] }
        : {};
    const id = `cost-${o.runId}-${String(n).padStart(4, '0')}`;
    await registerEngineEntry(o.projectDir, id);
    const entry: OutboxEntry =
      existing === undefined
        ? {
            id,
            created_at: new Date(now.getTime() + n).toISOString(),
            run_id: o.runId,
            role: 'orchestrator',
            op: 'create',
            database: 'cost_log',
            properties: { Date: r.key, ...props, ...withMs },
          }
        : {
            id,
            created_at: new Date(now.getTime() + n).toISOString(),
            run_id: o.runId,
            role: 'orchestrator',
            op: 'update',
            database: 'cost_log',
            item_id: r.key,
            properties: { ...props, ...withMs },
          };
    enqueue(o.projectDir, entry);
    res.entries.push(id);
    if (existing === undefined) res.created += 1;
    else res.updated += 1;
  }
  return res;
}
