import type { ArimaEvent } from './events.js';
import type { LedgerRow } from './ledger.js';

/**
 * Delivery metrics (spec 13.3 time measures, 13.4; F05 5.2; WP-132), computed from the run
 * ledger and the event log, so nothing is kept twice. Every definition below is the spec's.
 * Time is in milliseconds; an interval that is still open is counted up to `now` for the time
 * spent in a state (queue, human wait), but lead and cycle time exist only once the item got there.
 *
 * - Lead time: item created (its id was issued) to Released.
 * - Cycle time: first In Progress to first Done.
 * - Touch time: sum of the item's agent run durations.
 * - Queue time: time in Ready before work starts (every stay in Ready).
 * - Human wait: time in PO Acceptance, and Blocked on a question (a Blocked stay whose reason
 *   starts with a Q id), plus the time gates waited for a decision.
 * - Flow efficiency: touch time over lead time.
 * - Agent time versus wall time: summed run durations versus the span they happened in.
 */

export interface ItemTimes {
  item: string;
  createdAt?: string;
  releasedAt?: string;
  leadMs?: number;
  cycleMs?: number;
  touchMs: number;
  queueMs: number;
  humanWaitMs: number;
  flowEfficiency?: number;
  /** True once the item is Released or Cancelled. */
  closed: boolean;
  status?: string;
}

const t = (ts: string): number => Date.parse(ts);

interface Stay {
  status: string;
  from: number;
  to: number;
  reason?: string;
}

/** Per-item times. `now` closes an open interval. */
export function itemTimes(
  events: readonly ArimaEvent[],
  rows: readonly LedgerRow[],
  now: Date,
): ItemTimes[] {
  const byItem = new Map<string, ArimaEvent[]>();
  const created = new Map<string, number>();
  const push = (id: string, e: ArimaEvent): void =>
    void byItem.set(id, [...(byItem.get(id) ?? []), e]);
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (e.type === 'id.issued' && e.item !== undefined && !created.has(e.item))
      created.set(e.item, t(e.ts));
    if (e.type === 'item.status' && e.item !== undefined && typeof e.data?.['to'] === 'string')
      push(e.item, e);
  }
  const touch = new Map<string, number>();
  for (const r of rows)
    if (r.item !== 'none') touch.set(r.item, (touch.get(r.item) ?? 0) + r.duration_ms);

  const out: ItemTimes[] = [];
  for (const item of new Set([...byItem.keys(), ...created.keys(), ...touch.keys()])) {
    const evs = byItem.get(item) ?? [];
    const stays: Stay[] = evs.map((e, i) => ({
      status: e.data?.['to'] as string,
      from: t(e.ts),
      to: i + 1 < evs.length ? t((evs[i + 1] as ArimaEvent).ts) : now.getTime(),
      ...(typeof e.data?.['reason'] === 'string' ? { reason: e.data['reason'] } : {}),
    }));
    const createdAt = created.get(item) ?? (evs[0] ? t(evs[0].ts) : undefined);
    const released = stays.find((s) => s.status === 'Released');
    const firstProgress = stays.find((s) => s.status === 'In Progress');
    const firstDone = stays.find(
      (s) => s.status === 'Done' && (firstProgress === undefined || s.from >= firstProgress.from),
    );
    const sum = (pred: (s: Stay) => boolean): number =>
      stays.filter(pred).reduce((a, s) => a + Math.max(0, s.to - s.from), 0);
    const leadMs =
      createdAt !== undefined && released !== undefined ? released.from - createdAt : undefined;
    const touchMs = touch.get(item) ?? 0;
    const last = stays.at(-1);
    out.push({
      item,
      ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
      ...(released ? { releasedAt: new Date(released.from).toISOString() } : {}),
      ...(leadMs !== undefined ? { leadMs } : {}),
      ...(firstProgress && firstDone ? { cycleMs: firstDone.from - firstProgress.from } : {}),
      touchMs,
      queueMs: sum((s) => s.status === 'Ready'),
      humanWaitMs: sum(
        (s) =>
          s.status === 'PO Acceptance' || (s.status === 'Blocked' && /^Q-\d+/.test(s.reason ?? '')),
      ),
      ...(leadMs !== undefined && leadMs > 0 ? { flowEfficiency: touchMs / leadMs } : {}),
      closed: last?.status === 'Released' || last?.status === 'Cancelled',
      ...(last ? { status: last.status } : {}),
    });
  }
  return out.sort((a, b) => a.item.localeCompare(b.item));
}

/** Hours the gates waited for a decision: `gate.opened` to the next `gate.decided` of the same gate. */
export function gateWaitMs(events: readonly ArimaEvent[], now: Date): number {
  const open = new Map<string, number>();
  let total = 0;
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const gate = typeof e.data?.['gate'] === 'string' ? e.data['gate'] : undefined;
    if (gate === undefined) continue;
    if (e.type === 'gate.opened' && !open.has(gate)) open.set(gate, t(e.ts));
    if (e.type === 'gate.decided' && open.has(gate)) {
      total += t(e.ts) - (open.get(gate) as number);
      open.delete(gate);
    }
  }
  for (const from of open.values()) total += Math.max(0, now.getTime() - from);
  return total;
}

/** Agent time (summed run durations) against wall time (the span they happened in); parallel runs make the first larger. */
export function agentVersusWall(rows: readonly LedgerRow[]): {
  agentMs: number;
  wallMs: number;
  parallelism: number | undefined;
} {
  const spans = rows
    .filter((r) => r.started_at !== undefined)
    .map((r) => ({
      from: t(r.started_at as string),
      to: t(r.started_at as string) + r.duration_ms,
    }));
  const agentMs = rows.reduce((a, r) => a + r.duration_ms, 0);
  const merged = spans
    .sort((a, b) => a.from - b.from)
    .reduce<{ from: number; to: number }[]>((acc, s) => {
      const last = acc.at(-1);
      if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
      else acc.push({ ...s });
      return acc;
    }, []);
  const wallMs = merged.reduce((a, s) => a + (s.to - s.from), 0);
  return { agentMs, wallMs, parallelism: wallMs > 0 ? agentMs / wallMs : undefined };
}

export interface Stat {
  n: number;
  median: number | undefined;
  mean: number | undefined;
}

export function stat(xs: readonly number[]): Stat {
  if (xs.length === 0) return { n: 0, median: undefined, mean: undefined };
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return {
    n: s.length,
    median: s.length % 2 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

// ---------------------------------------------------------------------------------------------
// DORA (spec 13.4): measurable only once production releases and incidents are recorded

export type Dora =
  | { measurable: false; reason: string }
  | {
      measurable: true;
      deployments: number;
      /** Successful production deployments per week over the span between the first and last one (at least one week). */
      deploymentFrequencyPerWeek: number;
      /** Median ms from `merge.done` of an item to the deployment that carried it; undefined if none is linked. */
      changeLeadTimeMs: number | undefined;
      /** Failed deployments (ok false, rolled back, or tied to an incident) over all. */
      changeFailureRate: number;
      /** Median ms from an incident opening to its closing. */
      failedDeploymentRecoveryMs: number | undefined;
      /** Unplanned (hotfix) deployments over all: the deployment rework rate. */
      deploymentReworkRate: number;
    };

/**
 * The five DORA measures from `deploy.production` (`data.ok`, `data.hotfix`, `data.items`,
 * `data.version`), `deploy.rollback`, `merge.done` and `incident.opened/closed` events. Until a
 * production deployment exists they are "not yet measurable" (WP-402/WP-403 write the events).
 */
export function dora(events: readonly ArimaEvent[]): Dora {
  const deploys = events.filter((e) => e.type === 'deploy.production');
  if (deploys.length === 0)
    return { measurable: false, reason: 'no production deployment has been recorded yet' };
  const ok = deploys.filter((e) => e.data?.['ok'] !== false);
  const first = Math.min(...deploys.map((e) => t(e.ts)));
  const last = Math.max(...deploys.map((e) => t(e.ts)));
  const weeks = Math.max(1, (last - first) / (7 * 86_400_000));
  const merges = new Map<string, number>();
  for (const e of events) if (e.type === 'merge.done' && e.item) merges.set(e.item, t(e.ts));
  const leads: number[] = [];
  for (const d of ok)
    for (const item of Array.isArray(d.data?.['items']) ? (d.data['items'] as string[]) : [])
      if (merges.has(item)) leads.push(t(d.ts) - (merges.get(item) as number));
  const rolled = new Set(
    events
      .filter((e) => e.type === 'deploy.rollback')
      .map((e) => String(e.data?.['version'] ?? '')),
  );
  const incidentVersions = new Set(
    events
      .filter((e) => e.type === 'incident.opened')
      .map((e) => String(e.data?.['version'] ?? ''))
      .filter(Boolean),
  );
  const failed = deploys.filter(
    (d) =>
      d.data?.['ok'] === false ||
      rolled.has(String(d.data?.['version'] ?? '')) ||
      incidentVersions.has(String(d.data?.['version'] ?? '')),
  ).length;
  const opened = new Map<string, number>();
  const recov: number[] = [];
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (e.type === 'incident.opened' && e.item) opened.set(e.item, t(e.ts));
    if (e.type === 'incident.closed' && e.item && opened.has(e.item))
      recov.push(t(e.ts) - (opened.get(e.item) as number));
  }
  return {
    measurable: true,
    deployments: deploys.length,
    deploymentFrequencyPerWeek: ok.length / weeks,
    changeLeadTimeMs: stat(leads).median,
    changeFailureRate: failed / deploys.length,
    failedDeploymentRecoveryMs: stat(recov).median,
    deploymentReworkRate:
      deploys.filter((d) => d.data?.['hotfix'] === true).length / deploys.length,
  };
}

// ---------------------------------------------------------------------------------------------

export interface Delivery {
  items: ItemTimes[];
  lead: Stat;
  cycle: Stat;
  touch: Stat;
  queue: Stat;
  humanWait: Stat;
  flowEfficiency: Stat;
  gateWaitMs: number;
  agentVsWall: ReturnType<typeof agentVersusWall>;
  /** Total cost of stories that reached Done (rework included) over how many did: cost per accepted story. */
  costPerAcceptedStory: { stories: number; costUsd: number | undefined };
  /** Spent over the project cap. */
  budgetBurn: number | undefined;
  /** Human minutes from the hours in the bills file. */
  humanMinutes: number;
  dora: Dora;
}

export function delivery(o: {
  events: readonly ArimaEvent[];
  rows: readonly LedgerRow[];
  now?: Date;
  projectCap?: number;
  humanHours?: number;
}): Delivery {
  const now = o.now ?? new Date();
  const items = itemTimes(o.events, o.rows, now);
  const stories = items.filter((i) => /^US-/.test(i.item));
  const accepted = new Set(
    o.events
      .filter(
        (e) =>
          e.type === 'item.status' &&
          (e.data?.['to'] === 'Done' || e.data?.['to'] === 'Released') &&
          e.item !== undefined,
      )
      .map((e) => e.item as string),
  );
  const cost = (id: string): number =>
    Math.round(o.rows.filter((r) => r.item === id).reduce((a, r) => a + r.cost_usd * 1e6, 0)) / 1e6;
  const acceptedStories = [...accepted].filter((id) => /^US-/.test(id));
  const spent = Math.round(o.rows.reduce((a, r) => a + r.cost_usd * 1e6, 0)) / 1e6;
  return {
    items,
    lead: stat(items.flatMap((i) => (i.leadMs !== undefined ? [i.leadMs] : []))),
    cycle: stat(items.flatMap((i) => (i.cycleMs !== undefined ? [i.cycleMs] : []))),
    touch: stat(stories.filter((i) => i.touchMs > 0).map((i) => i.touchMs)),
    queue: stat(stories.filter((i) => i.queueMs > 0).map((i) => i.queueMs)),
    humanWait: stat(stories.filter((i) => i.humanWaitMs > 0).map((i) => i.humanWaitMs)),
    flowEfficiency: stat(
      items.flatMap((i) => (i.flowEfficiency !== undefined ? [i.flowEfficiency] : [])),
    ),
    gateWaitMs: gateWaitMs(o.events, now),
    agentVsWall: agentVersusWall(o.rows),
    costPerAcceptedStory: {
      stories: acceptedStories.length,
      costUsd:
        acceptedStories.length > 0
          ? Math.round(
              (acceptedStories.reduce((a, id) => a + cost(id), 0) / acceptedStories.length) * 1e6,
            ) / 1e6
          : undefined,
    },
    budgetBurn: o.projectCap !== undefined && o.projectCap > 0 ? spent / o.projectCap : undefined,
    humanMinutes: Math.round((o.humanHours ?? 0) * 60),
    dora: dora(o.events),
  };
}

const hours = (ms: number | undefined): string =>
  ms === undefined ? 'n/a' : `${(ms / 3_600_000).toFixed(1)}h`;

/** Lines for `/arima:cost` and the digest. */
export function describeDelivery(d: Delivery): string[] {
  const line = (name: string, s: Stat): string =>
    `  ${name.padEnd(16)} ${s.n === 0 ? 'n/a' : `median ${hours(s.median)}, mean ${hours(s.mean)} (n=${s.n})`}`;
  return [
    'Delivery',
    line('Lead time', d.lead),
    line('Cycle time', d.cycle),
    line('Touch time', d.touch),
    line('Queue time', d.queue),
    line('Human wait', d.humanWait),
    `  ${'Flow efficiency'.padEnd(16)} ${d.flowEfficiency.n === 0 ? 'n/a' : `${((d.flowEfficiency.median ?? 0) * 100).toFixed(0)}% median (n=${d.flowEfficiency.n})`}`,
    `  ${'Gate wait'.padEnd(16)} ${hours(d.gateWaitMs)}`,
    `  ${'Agent vs wall'.padEnd(16)} ${hours(d.agentVsWall.agentMs)} of agent time in ${hours(d.agentVsWall.wallMs)} of wall time${d.agentVsWall.parallelism ? ` (${d.agentVsWall.parallelism.toFixed(1)}x parallel)` : ''}`,
    `  ${'Cost / accepted'.padEnd(16)} ${d.costPerAcceptedStory.costUsd === undefined ? 'n/a' : `$${d.costPerAcceptedStory.costUsd.toFixed(2)} over ${d.costPerAcceptedStory.stories} stories`}`,
    `  ${'Budget burn'.padEnd(16)} ${d.budgetBurn === undefined ? 'n/a' : `${(d.budgetBurn * 100).toFixed(0)}% of the project cap`}`,
    `  ${'DORA'.padEnd(16)} ${d.dora.measurable ? `${d.dora.deployments} deployments, ${d.dora.deploymentFrequencyPerWeek.toFixed(1)}/week, change failure ${(d.dora.changeFailureRate * 100).toFixed(0)}%, rework ${(d.dora.deploymentReworkRate * 100).toFixed(0)}%, lead ${hours(d.dora.changeLeadTimeMs)}, recovery ${hours(d.dora.failedDeploymentRecoveryMs)}` : `not yet measurable (${d.dora.reason})`}`,
  ];
}
