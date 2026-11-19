// WP-132: delivery metrics (spec 13.3, 13.4), each defined by a test on a fixed fixture.
import { describe, expect, it } from 'vitest';
import type { ArimaEvent, EventType } from '../src/events.js';
import type { LedgerRow } from '../src/ledger.js';
import {
  agentVersusWall,
  delivery,
  describeDelivery,
  dora,
  gateWaitMs,
  itemTimes,
  stat,
} from '../src/metrics.js';

const H = 3_600_000;
const at = (day: number, h: number, m = 0): string =>
  `2026-11-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const ev = (type: EventType, ts: string, over: Partial<ArimaEvent> = {}): ArimaEvent => ({
  type,
  ts,
  actor: 'system',
  ...over,
});
const status = (item: string, to: string, ts: string, reason?: string): ArimaEvent =>
  ev('item.status', ts, { item, data: { to, ...(reason ? { reason } : {}) } });
const issued = (item: string, ts: string): ArimaEvent =>
  ev('id.issued', ts, { item, data: { id: item } });

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  run_id: 'r-20261117-0900-01',
  date: '2026-11-17',
  project: 'TAS',
  phase: 4,
  item: 'US-001',
  role: 'developer',
  attempt: 1,
  is_rework: false,
  subtype: 'success',
  num_turns: 5,
  duration_ms: H,
  tokens: { input: 1, output: 1, cache_read: 1, cache_creation: 1 },
  cost_usd: 1,
  budget_usd: 2,
  result: 'pass',
  ...over,
});

/** US-001 goes all the way to Released; US-002 is blocked on a question, then on a budget, and is still open. */
const EVENTS: ArimaEvent[] = [
  issued('US-001', at(17, 8)),
  status('US-001', 'Ready', at(17, 9)),
  status('US-001', 'In Progress', at(17, 11)),
  status('US-001', 'In Review', at(17, 15)),
  status('US-001', 'In QA', at(17, 16)),
  status('US-001', 'PO Acceptance', at(17, 17)),
  status('US-001', 'Done', at(17, 19)),
  status('US-001', 'Released', at(18, 8)),
  issued('US-002', at(17, 8)),
  status('US-002', 'Ready', at(17, 8, 30)),
  status('US-002', 'In Progress', at(17, 9)),
  status('US-002', 'Blocked', at(17, 10), 'Q-001: Which provider?'),
  status('US-002', 'In Progress', at(17, 12)),
  status('US-002', 'Blocked', at(17, 13), 'story budget used up'),
  status('US-002', 'In Progress', at(17, 14)),
];
const ROWS = [
  row({ item: 'US-001', duration_ms: H, cost_usd: 1.5, started_at: at(17, 10) }),
  row({ item: 'US-001', duration_ms: H / 2, cost_usd: 0.5, started_at: at(17, 12), role: 'qa' }),
  row({ item: 'US-002', duration_ms: H, cost_usd: 2, started_at: at(17, 10, 30) }),
  row({ item: 'none', role: 'orchestrator', duration_ms: 10 * 60_000, cost_usd: 0.25 }),
];
const NOW = new Date(at(18, 12));
const byId = (id: string) => itemTimes(EVENTS, ROWS, NOW).find((i) => i.item === id)!;

describe('time measures (spec 13.3), one definition each', () => {
  it('lead time: the id was issued to Released', () => {
    expect(byId('US-001').leadMs).toBe(24 * H);
    expect(byId('US-001')).toMatchObject({
      createdAt: new Date(at(17, 8)).toISOString(),
      releasedAt: new Date(at(18, 8)).toISOString(),
      closed: true,
      status: 'Released',
    });
    expect(byId('US-002').leadMs).toBeUndefined(); // not released
    expect(byId('US-002').closed).toBe(false);
  });
  it('cycle time: first In Progress to first Done', () => {
    expect(byId('US-001').cycleMs).toBe(8 * H);
    expect(byId('US-002').cycleMs).toBeUndefined();
  });
  it("touch time: the sum of the item's agent run durations; overhead belongs to no item", () => {
    expect(byId('US-001').touchMs).toBe(1.5 * H);
    expect(byId('US-002').touchMs).toBe(H);
    expect(itemTimes(EVENTS, ROWS, NOW).some((i) => i.item === 'none')).toBe(false);
  });
  it('queue time: every stay in Ready before work starts', () => {
    expect(byId('US-001').queueMs).toBe(2 * H);
    expect(byId('US-002').queueMs).toBe(30 * 60_000);
  });
  it('human wait: PO Acceptance, and Blocked only on a question', () => {
    expect(byId('US-001').humanWaitMs).toBe(2 * H);
    expect(byId('US-002').humanWaitMs).toBe(2 * H); // the 10:00-12:00 question block; the 13:00-14:00 budget block does not count
  });
  it('flow efficiency: touch time over lead time', () => {
    expect(byId('US-001').flowEfficiency).toBeCloseTo(1.5 / 24, 10);
    expect(byId('US-002').flowEfficiency).toBeUndefined();
  });
  it('an open stay is counted up to now', () => {
    const open = [issued('US-9', at(17, 8)), status('US-9', 'Ready', at(17, 9))];
    expect(itemTimes(open, [], new Date(at(17, 15)))[0]?.queueMs).toBe(6 * H);
    const wait = [status('US-9', 'PO Acceptance', at(17, 9))];
    expect(itemTimes(wait, [], new Date(at(17, 12)))[0]?.humanWaitMs).toBe(3 * H);
  });
  it('an item with no id.issued event is created at its first status event', () => {
    const e = [
      status('US-8', 'Ready', at(17, 9)),
      status('US-8', 'In Progress', at(17, 10)),
      status('US-8', 'Released', at(17, 20)),
    ];
    expect(itemTimes(e, [], NOW)[0]?.leadMs).toBe(11 * H);
  });
  it('gate wait: gate.opened to gate.decided, and an undecided gate keeps counting', () => {
    const g = [
      ev('gate.opened', at(17, 10), { data: { gate: 'G1' } }),
      ev('gate.decided', at(17, 12), { data: { gate: 'G1' } }),
      ev('gate.opened', at(17, 14), { data: { gate: 'G3' } }),
    ];
    expect(gateWaitMs(g, new Date(at(17, 16)))).toBe(4 * H);
  });
  it('agent time versus wall time: parallel runs make agent time larger', () => {
    const v = agentVersusWall([
      row({ started_at: at(17, 10), duration_ms: H }),
      row({ started_at: at(17, 10, 30), duration_ms: H }),
      row({ started_at: at(17, 14), duration_ms: H / 2 }),
    ]);
    expect(v).toMatchObject({ agentMs: 2.5 * H, wallMs: 2 * H });
    expect(v.parallelism).toBeCloseTo(1.25, 10);
    expect(agentVersusWall([])).toEqual({ agentMs: 0, wallMs: 0, parallelism: undefined });
  });
  it('stat: median and mean, and nothing for no data', () => {
    expect(stat([4, 1, 3])).toEqual({ n: 3, median: 3, mean: 8 / 3 });
    expect(stat([1, 2, 3, 10])).toMatchObject({ median: 2.5 });
    expect(stat([])).toEqual({ n: 0, median: undefined, mean: undefined });
  });
});

describe('delivery summary', () => {
  it('rolls the measures up, with cost per accepted story and budget burn', () => {
    const d = delivery({ events: EVENTS, rows: ROWS, now: NOW, projectCap: 50, humanHours: 2 });
    expect(d.lead).toMatchObject({ n: 1, median: 24 * H });
    expect(d.cycle).toMatchObject({ n: 1, median: 8 * H });
    expect(d.touch.n).toBe(2);
    expect(d.queue).toMatchObject({ n: 2 });
    expect(d.humanWait).toMatchObject({ n: 2, median: 2 * H });
    expect(d.flowEfficiency.n).toBe(1);
    expect(d.costPerAcceptedStory).toEqual({ stories: 1, costUsd: 2 }); // US-001: 1.5 + 0.5
    expect(d.budgetBurn).toBeCloseTo(4.25 / 50, 10);
    expect(d.humanMinutes).toBe(120);
  });
  it('has no numbers when nothing happened, and says so in plain lines', () => {
    const d = delivery({ events: [], rows: [], now: NOW });
    expect(d.lead.n).toBe(0);
    expect(d.costPerAcceptedStory).toEqual({ stories: 0, costUsd: undefined });
    expect(d.budgetBurn).toBeUndefined();
    const lines = describeDelivery(d).join('\n');
    expect(lines).toContain('Lead time');
    expect(lines).toContain('n/a');
    expect(lines).toContain('not yet measurable');
  });
});

describe('DORA: not yet measurable until production releases exist', () => {
  it('returns "not yet measurable" with the reason when there is no production deployment', () => {
    expect(dora([])).toEqual({
      measurable: false,
      reason: 'no production deployment has been recorded yet',
    });
    expect(dora(EVENTS)).toMatchObject({ measurable: false });
  });

  it('computes the five measures from deployment, merge, rollback and incident events', () => {
    const e: ArimaEvent[] = [
      ev('merge.done', at(1, 8), { item: 'US-001' }),
      ev('merge.done', at(2, 8), { item: 'US-002' }),
      ev('deploy.production', at(3, 8), {
        data: { version: 'v0.1.0', ok: true, items: ['US-001', 'US-002'] },
      }),
      ev('deploy.production', at(8, 8), { data: { version: 'v0.2.0', ok: false } }),
      ev('deploy.rollback', at(8, 9), { data: { version: 'v0.2.0' } }),
      ev('deploy.production', at(10, 8), { data: { version: 'v0.2.1', ok: true, hotfix: true } }),
      ev('deploy.production', at(17, 8), { data: { version: 'v0.3.0', ok: true } }),
      ev('incident.opened', at(17, 12), { item: 'INC-001', data: { version: 'v0.3.0' } }),
      ev('incident.closed', at(17, 14), { item: 'INC-001' }),
    ];
    const d = dora(e);
    expect(d).toMatchObject({ measurable: true, deployments: 4 });
    if (!d.measurable) return;
    expect(d.deploymentFrequencyPerWeek).toBeCloseTo(3 / 2, 6); // 3 successful over a 14-day span
    expect(d.changeLeadTimeMs).toBe(((2 * 24 + 0) * H + 1 * 24 * H) / 2); // US-001 2 days, US-002 1 day -> median 1.5 days
    expect(d.changeFailureRate).toBeCloseTo(2 / 4, 6); // v0.2.0 failed and was rolled back; v0.3.0 caused an incident
    expect(d.failedDeploymentRecoveryMs).toBe(2 * H);
    expect(d.deploymentReworkRate).toBeCloseTo(1 / 4, 6);
  });

  it('a single deployment counts over at least one week', () => {
    const d = dora([ev('deploy.production', at(3, 8), { data: { version: 'v1', ok: true } })]);
    expect(d).toMatchObject({
      measurable: true,
      deploymentFrequencyPerWeek: 1,
      changeFailureRate: 0,
      deploymentReworkRate: 0,
    });
  });
});
