// WP-131: cost roll-up per story, role and phase; estimate accuracy; alerts; TCO; the Cost log.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCostCli } from '../src/cli/cost-cli.js';
import {
  MIN_RUNS_FOR_REWORK_ALERT,
  costAlerts,
  costLogRows,
  estimateAccuracy,
  filterRows,
  metrics,
  readManualCosts,
  recordCostAlerts,
  rollup,
  storyMetas,
  syncCostLog,
  totalCostOfOwnership,
  usd,
} from '../src/cost.js';
import type { StoryMeta } from '../src/cost.js';
import { appendEvent, readEvents } from '../src/events.js';
import { appendLedgerRow } from '../src/ledger.js';
import type { LedgerRow, Role } from '../src/ledger.js';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { pullMirror } from '../src/notion/mirror.js';
import { outboxDir, pushOutbox } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { FakeNotion } from './fake-notion.js';
import { example, tempDir } from './helpers.js';

let seq = 0;
const row = (over: Partial<LedgerRow> = {}): LedgerRow => {
  seq += 1;
  return {
    run_id: `r-20261119-${String(1000 + Math.floor(seq / 100)).padStart(4, '0')}-${String(seq % 100).padStart(2, '0')}`,
    date: '2026-11-19',
    project: 'TAS',
    phase: 4,
    item: 'US-001',
    role: 'developer',
    attempt: 1,
    is_rework: false,
    subtype: 'success',
    num_turns: 10,
    duration_ms: 60_000,
    tokens: { input: 100, output: 50, cache_read: 300, cache_creation: 100 },
    cost_usd: 0.5,
    budget_usd: 2,
    result: 'pass',
    ...over,
  };
};

/** A small seeded generator so the "property" test is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
function randomLedger(seed: number, n: number): LedgerRow[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  return Array.from({ length: n }, () =>
    row({
      item: pick(['US-001', 'US-002', 'US-003', 'BUG-001', 'none']),
      role: pick<Role>(['developer', 'qa', 'tech-lead', 'orchestrator', 'ba']),
      phase: pick([0, 1, 2, 4, 5]),
      date: pick(['2026-11-17', '2026-11-18', '2026-11-19']),
      cost_usd: Math.round(r() * 3_000_000) / 1e6 + (r() < 0.2 ? 0.1 + 0.2 : 0), // awkward floats on purpose
      is_rework: r() < 0.3,
      model_tier: pick(['strong', 'standard', 'fast']),
      result: pick(['pass', 'fail', 'error', 'blocked']),
      milestone: r() < 0.5 ? pick(['MS-01', 'MS-02']) : null,
    }),
  );
}

describe('rollup: every partition adds up to the ledger exactly', () => {
  it('per-story cost equals the ledger sum, and role, phase, day, tier and item each partition the total (property test)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rows = randomLedger(seed, 5 + (seed % 37));
      const r = rollup(rows);
      const ledgerMicro = rows.reduce((a, x) => a + Math.round(x.cost_usd * 1e6), 0);
      expect(r.total.cost_micro, `seed ${seed}`).toBe(ledgerMicro);
      for (const part of [r.byItem, r.byRole, r.byPhase, r.byDay, r.byTier] as Map<
        unknown,
        { cost_micro: number; runs: number }
      >[]) {
        expect(
          [...part.values()].reduce((a, t) => a + t.cost_micro, 0),
          `seed ${seed}`,
        ).toBe(ledgerMicro);
        expect([...part.values()].reduce((a, t) => a + t.runs, 0)).toBe(rows.length);
      }
      for (const [item, t] of r.byItem)
        expect(t.cost_micro).toBe(
          rows.filter((x) => x.item === item).reduce((a, x) => a + Math.round(x.cost_usd * 1e6), 0),
        );
    }
  });

  it('orchestrator rows with no item are overhead: reported apart, never allocated to a story', () => {
    const rows = [
      row({ item: 'US-001', cost_usd: 1 }),
      row({ item: 'none', role: 'orchestrator', cost_usd: 0.25 }),
    ];
    const r = rollup(rows);
    expect(usd(r.overhead.cost_micro)).toBe(0.25);
    expect(usd(r.byItem.get('US-001')!.cost_micro)).toBe(1);
    expect(usd(r.total.cost_micro)).toBe(1.25);
  });

  it('sums cost_usd as stored: a resumed session row (already a difference) is not double counted', () => {
    const r = rollup([
      row({ cost_usd: 0.5, session_id: 's1' }),
      row({ cost_usd: 0.3, session_id: 's1' }),
    ]);
    expect(usd(r.total.cost_micro)).toBe(0.8);
  });

  it('totals add tokens, turns, minutes, rework and failures', () => {
    const r = rollup([
      row({ is_rework: true, cost_usd: 0.4, result: 'fail' }),
      row({ cost_usd: 0.6 }),
    ]).total;
    expect(r).toMatchObject({
      runs: 2,
      turns: 20,
      input: 200,
      output: 100,
      cache_read: 600,
      cache_creation: 200,
      duration_ms: 120_000,
      rework_runs: 1,
      failed_runs: 1,
    });
    expect(usd(r.rework_micro)).toBe(0.4);
  });

  it('filters by date, milestone, phase, item and role', () => {
    const rows = [
      row({ date: '2026-11-17', milestone: 'MS-01' }),
      row({ date: '2026-11-18', phase: 5 }),
      row({ date: '2026-11-19', item: 'US-002', role: 'qa', milestone: 'MS-02' }),
    ];
    expect(filterRows(rows, { from: '2026-11-18' })).toHaveLength(2);
    expect(filterRows(rows, { to: '2026-11-17' })).toHaveLength(1);
    expect(filterRows(rows, { milestone: 'MS-02' })).toHaveLength(1);
    expect(filterRows(rows, { phase: 5 })).toHaveLength(1);
    expect(filterRows(rows, { item: 'US-002', role: 'qa' })).toHaveLength(1);
    expect(rollup(rows, { from: '2026-11-18' }).total.runs).toBe(2);
  });
});

describe('metrics (spec 13.4)', () => {
  it('rework share, cache efficiency, turns per run, failure rate and first-pass QA', () => {
    const rows = [
      row({ cost_usd: 1, is_rework: true }),
      row({ cost_usd: 3, result: 'fail' }),
      row({ role: 'qa', attempt: 1, result: 'pass', item: 'US-001' }),
      row({ role: 'qa', attempt: 1, result: 'fail', item: 'US-002' }),
      row({ role: 'qa', attempt: 2, result: 'pass', item: 'US-002' }),
      row({ role: 'qa', attempt: 1, result: 'pass', item: 'none' }),
    ];
    const m = metrics(rows);
    expect(m.reworkShare).toBeCloseTo(1 / 6, 6);
    expect(m.cacheEfficiency).toBeCloseTo(300 / 500, 6);
    expect(m.turnsPerRun).toBe(10);
    expect(m.runFailureRate).toBeCloseTo(2 / 6, 6);
    expect(m.firstPassQa).toEqual({ passed: 1, of: 2, rate: 0.5 });
  });
  it('nothing spent gives undefined, not NaN', () => {
    expect(metrics([])).toEqual({
      reworkShare: undefined,
      cacheEfficiency: undefined,
      turnsPerRun: undefined,
      runFailureRate: undefined,
      firstPassQa: { passed: 0, of: 0, rate: undefined },
    });
  });
});

const story = (id: string, size: string, budget: number): StoryMeta => ({ id, size, budget });

describe('estimate accuracy by size', () => {
  it('actual over budget per size; fewer than three stories is "too few", not a number', () => {
    const rows = [
      row({ item: 'US-001', cost_usd: 1.5 }),
      row({ item: 'US-002', cost_usd: 0.5 }),
      row({ item: 'US-003', cost_usd: 1 }),
      row({ item: 'US-004', cost_usd: 4 }),
      row({ item: 'US-005', cost_usd: 9 }),
      row({ item: 'US-006', cost_usd: 0 }),
    ];
    const stories = [
      story('US-001', 'S', 1),
      story('US-002', 'S', 1),
      story('US-003', 'S', 1),
      story('US-004', 'M', 3),
      story('US-005', 'L', 6),
      story('US-006', 'S', 1),
    ];
    const [s, m, l] = estimateAccuracy(rows, stories);
    expect(s).toMatchObject({ size: 'S', n: 3, actual: 3, budget: 3, ratio: 1, tooFew: false }); // US-006 has no cost: not counted
    expect(m).toMatchObject({ size: 'M', n: 1, ratio: undefined, tooFew: true });
    expect(l).toMatchObject({ size: 'L', n: 1, tooFew: true });
  });
});

describe('alerts (spec 13.5 item 4)', () => {
  const stories = ['US-001', 'US-002', 'US-003', 'US-004'].map((id) => story(id, 'S', 1));
  const costs = (c: number[]): LedgerRow[] =>
    c.map((v, i) => row({ item: `US-00${i + 1}`, cost_usd: v }));

  it('a story above three times the median of its size raises an alert; at exactly three times it does not', () => {
    const a = costAlerts(costs([1, 1, 1, 3.5]), stories);
    expect(a).toEqual([expect.objectContaining({ kind: 'story_over_median', subject: 'US-004' })]);
    expect(costAlerts(costs([1, 1, 1, 3]), stories)).toEqual([]);
  });
  it('needs three stories of the size to have a median at all', () => {
    expect(costAlerts(costs([1, 9]), stories)).toEqual([]);
  });
  it('rework above 30% of a milestone raises an alert; 30% exactly and tiny samples do not', () => {
    const ms = (rework: number, total: number, runs: number): LedgerRow[] =>
      Array.from({ length: runs }, (_, i) =>
        row({
          milestone: 'MS-01',
          cost_usd: total / runs,
          is_rework: i < Math.round((rework / total) * runs),
        }),
      );
    expect(costAlerts(ms(4, 10, 10), [])).toEqual([
      expect.objectContaining({ kind: 'rework_share', subject: 'MS-01' }),
    ]);
    expect(costAlerts(ms(3, 10, 10), [])).toEqual([]);
    expect(MIN_RUNS_FOR_REWORK_ALERT).toBe(3);
    expect(
      costAlerts(
        [
          row({ milestone: 'MS-01', is_rework: true }),
          row({ milestone: 'MS-01', is_rework: true }),
        ],
        [],
      ),
    ).toEqual([]);
  });
  it('each alert is recorded once as a budget.alert event', async () => {
    const dir = tempDir();
    const alerts = costAlerts(costs([1, 1, 1, 5]), stories);
    expect(await recordCostAlerts(dir, alerts)).toHaveLength(1);
    expect(await recordCostAlerts(dir, alerts)).toEqual([]);
    expect(readEvents(dir).filter((e) => e.type === 'budget.alert')).toHaveLength(1);
    expect(readEvents(dir)[0]?.data).toMatchObject({
      cost_alert: 'story_over_median',
      subject: 'US-004',
    });
  });
});

describe('total cost of ownership: agents + infrastructure + human hours x rate', () => {
  const rows = [
    row({ cost_usd: 10, date: '2026-11-18' }),
    row({ cost_usd: 5, date: '2026-11-19' }),
  ];
  it('adds the manual bills and hours', () => {
    const t = totalCostOfOwnership(rows, {
      schema_version: 1,
      hourly_rate_usd: 80,
      infrastructure: [{ date: '2026-11-18', description: 'CI minutes', usd: 12.5 }],
      human_hours: [
        { date: '2026-11-18', who: 'owner', hours: 2.5 },
        { date: '2026-11-19', who: 'owner', hours: 1 },
      ],
    });
    expect(t).toEqual({
      agents: 15,
      infrastructure: 12.5,
      humanHours: 3.5,
      humanCost: 280,
      total: 307.5,
      rateMissing: false,
    });
  });
  it('respects the period, and says when hours have no rate', () => {
    const manual = {
      schema_version: 1 as const,
      infrastructure: [{ date: '2026-11-18', description: 'x', usd: 4 }],
      human_hours: [{ date: '2026-11-19', who: 'o', hours: 2 }],
    };
    expect(totalCostOfOwnership(rows, manual, { from: '2026-11-19' })).toMatchObject({
      agents: 5,
      infrastructure: 0,
      humanHours: 2,
      humanCost: 0,
      rateMissing: true,
      total: 5,
    });
    expect(totalCostOfOwnership(rows, undefined)).toMatchObject({
      agents: 15,
      infrastructure: 0,
      total: 15,
      rateMissing: false,
    });
  });
  it('reads and validates the bills file', () => {
    const dir = tempDir();
    expect(readManualCosts(dir)).toBeUndefined();
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'manual-costs.json'),
      JSON.stringify({ schema_version: 1, hourly_rate_usd: 50 }),
    );
    expect(readManualCosts(dir)).toMatchObject({ hourly_rate_usd: 50 });
    writeFileSync(
      path.join(dir, '.arima', 'manual-costs.json'),
      JSON.stringify({
        schema_version: 1,
        infrastructure: [{ date: 'x', description: '', usd: -1 }],
      }),
    );
    expect(() => readManualCosts(dir)).toThrow(/manual-costs\.json/);
  });
});

describe('the Notion Cost log', () => {
  const RUN = 'r-20261119-1700-01';
  async function world() {
    const fake = new FakeNotion();
    const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
    await bootstrapTemplate(port, fake.rootId);
    const map = (await mapWorkspace(port, fake.rootId)).map!;
    const dir = tempDir('arima-cost-');
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
    await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
    return { fake, port, map, dir };
  }
  const rows = [
    row({ item: 'US-001', cost_usd: 0.4, duration_ms: 90_000 }),
    row({ item: 'US-001', cost_usd: 0.6, is_rework: true }),
    row({ item: 'US-001', role: 'qa', cost_usd: 0.2 }),
    row({ item: 'none', role: 'orchestrator', cost_usd: 0.1 }),
  ];

  it('one row per (date, role, phase, item), keyed by a title that makes a re-sync an update', () => {
    const l = costLogRows(rows);
    expect(l.map((r) => r.key)).toEqual([
      '2026-11-19|developer|4|US-001',
      '2026-11-19|orchestrator|4|none',
      '2026-11-19|qa|4|US-001',
    ]);
    expect(l[0]?.totals).toMatchObject({ runs: 2 });
    expect(usd(l[0]!.totals.cost_micro)).toBe(1);
    expect(usd(l.reduce((a, r) => a + r.totals.cost_micro, 0))).toBe(1.3);
  });

  it('creates the rows, pushes them, and a second sync changes nothing; a changed total is an update', async () => {
    const w = await world();
    const first = await syncCostLog({ projectDir: w.dir, runId: RUN, rows });
    expect(first).toMatchObject({ created: 3, updated: 0, unchanged: 0 });
    // before the push, a second sync must not queue duplicates
    expect(await syncCostLog({ projectDir: w.dir, runId: RUN, rows })).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 3,
    });
    expect(readdirSync(outboxDir(w.dir)).filter((f) => f.endsWith('.json'))).toHaveLength(3);

    const pushed = await pushOutbox(w.dir, w.port, w.map);
    expect(pushed.rejected).toEqual([]);
    expect(pushed.applied).toHaveLength(3);
    const dev = w.fake.rowByTitle('Cost log', '2026-11-19|developer|4|US-001')!;
    expect(dev.properties['Cost USD']).toMatchObject({ number: 1 });
    expect(dev.properties['Runs']).toMatchObject({ number: 2 });
    expect(dev.properties['Rework']).toMatchObject({ number: 0.6 });
    expect(dev.properties['Agent minutes']).toMatchObject({ number: 2.5 });

    await pullMirror(w.dir, w.port, w.map);
    expect(await syncCostLog({ projectDir: w.dir, runId: RUN, rows })).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 3,
    });
    const more = [...rows, row({ item: 'US-001', cost_usd: 0.5 })];
    const again = await syncCostLog({ projectDir: w.dir, runId: RUN, rows: more });
    expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    expect((await pushOutbox(w.dir, w.port, w.map)).applied).toHaveLength(1);
    expect(
      w.fake.rowByTitle('Cost log', '2026-11-19|developer|4|US-001')!.properties['Cost USD'],
    ).toMatchObject({ number: 1.5 });
    expect(w.fake.rowsByTitle('Cost log', '2026-11-19|developer|4|US-001')).toHaveLength(1);
  });

  it('storyMetas reads size and budget from the mirror', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.arima', 'mirror'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'mirror', 'stories.json'),
      JSON.stringify({
        database: 'stories',
        rows: [
          {
            page_id: 'a',
            last_edited_time: 't',
            id: 'US-001',
            properties: { Complexity: 'M', 'Budget USD': 4 },
          },
          { page_id: 'b', last_edited_time: 't', id: 'US-002', properties: { Complexity: 'L' } },
          { page_id: 'c', last_edited_time: 't', id: 'XX-1', properties: {} },
        ],
      }),
    );
    expect(storyMetas(dir, { perStoryDefault: 2, bySize: { M: 3, L: 6 } })).toEqual([
      { id: 'US-001', size: 'M', budget: 4 },
      { id: 'US-002', size: 'L', budget: 6 },
    ]);
  });
});

describe('arima-cost', () => {
  const setup = async () => {
    const dir = tempDir('arima-costcli-');
    writeFileSync(path.join(dir, 'arima.yaml'), example('arima.yaml'));
    writeFileSync(path.join(dir, 'team.yaml'), example('team.yaml'));
    return dir;
  };
  const run = async (argv: string[], dir: string) => {
    const r = { out: '', err: '' };
    const code = await runCostCli(argv, {
      out: (s) => (r.out += s),
      err: (s) => (r.err += s),
      cwd: dir,
    });
    return { code, ...r };
  };

  it('says "no runs yet" on an empty ledger', async () => {
    const dir = await setup();
    expect(await run([], dir)).toMatchObject({
      code: 0,
      out: 'no runs yet: nothing has been spent\n',
    });
  });

  it('prints the tables, states that amounts are estimates, and supports --by and --json', async () => {
    const dir = await setup();
    for (const r of [
      row({ cost_usd: 1.25 }),
      row({ role: 'qa', item: 'US-002', cost_usd: 0.75, is_rework: true }),
    ])
      await appendLedgerRow(dir, r);
    const all = await run([], dir);
    expect(all.code).toBe(0);
    expect(all.out).toContain('estimated USD: consumption, not spend on a seat plan');
    expect(all.out).toContain('Total $2.00 over 2 runs');
    for (const h of [
      'By role',
      'By phase',
      'By item',
      'Rework share 38%',
      'Estimate accuracy',
      'Total cost of ownership',
      'Delivery',
      'Lead time',
      'not yet measurable',
    ])
      expect(all.out).toContain(h);
    const item = await run(['--by', 'item'], dir);
    expect(item.out).toContain('By item');
    expect(item.out).not.toContain('By role');
    const j = JSON.parse((await run(['--json'], dir)).out);
    expect(j).toMatchObject({
      estimated: true,
      total_usd: 2,
      runs: 2,
      by_item: { 'US-001': { cost_usd: 1.25 } },
    });
    expect(JSON.parse((await run(['--json', '--milestone', 'MS-09'], dir)).out).runs).toBe(0);
  });

  it('exit codes: 2 usage, 10 invalid config, 1 corrupt ledger naming the line', async () => {
    const dir = await setup();
    expect((await run(['--by', 'colour'], dir)).code).toBe(2);
    expect((await run(['--from', 'yesterday'], dir)).code).toBe(2);
    expect((await run(['--milestone', 'x'], dir)).code).toBe(2);
    expect((await run(['--nope'], dir)).code).toBe(2);
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(path.join(dir, '.arima', 'ledger.jsonl'), 'not json\n');
    const bad = await run([], dir);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/ledger\.jsonl:1/);
    const empty = tempDir();
    expect((await run([], empty)).code).toBe(10);
  });

  it('--sync queues the Cost log, records alerts once, and writes no ledger row', async () => {
    const dir = await setup();
    await appendLedgerRow(dir, row({ cost_usd: 1 }));
    const before = readFileSync(path.join(dir, '.arima', 'ledger.jsonl'), 'utf8');
    const s = await run(['--sync', '--json'], dir);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.out)).toMatchObject({ created: 1, updated: 0 });
    expect(readFileSync(path.join(dir, '.arima', 'ledger.jsonl'), 'utf8')).toBe(before);
    expect(readdirSync(outboxDir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(JSON.parse((await run(['--sync', '--json'], dir)).out)).toMatchObject({
      created: 0,
      unchanged: 1,
    });
  });
});
