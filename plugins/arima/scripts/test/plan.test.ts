// WP-216: /arima:plan. A milestone holds 8 to 12 points (S 1, M 2, L 4), filled by priority; a story
// is never split, and never lands in two milestones. Pure planner first, then the CLI on a mirror.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_EXIT, runPlanCli } from '../src/cli/plan-cli.js';
import { appendLedgerRow } from '../src/ledger.js';
import type { LedgerRow } from '../src/ledger.js';
import { setPauseFile } from '../src/killswitch.js';
import { outboxDir } from '../src/notion/outbox.js';
import {
  MILESTONE_MAX_POINTS,
  MILESTONE_MIN_POINTS,
  planMilestone,
  storiesForPlan,
} from '../src/plan.js';
import type { PlanStory } from '../src/plan.js';
import { acquireRunLock } from '../src/runlock.js';
import { project } from './helpers.js';

let n = 0;
const story = (over: Partial<PlanStory>): PlanStory => {
  n += 1;
  return {
    id: `US-${String(n).padStart(3, '0')}`,
    status: 'Ready',
    size: 'S',
    priority: n,
    type: 'Story',
    budget: 1,
    milestones: [],
    dependsOn: [],
    ...over,
  };
};
const plan = (stories: PlanStory[], extra: { revise?: string; remainingBudget?: number } = {}) =>
  planMilestone({
    stories,
    remainingBudget: extra.remainingBudget ?? 1000,
    ...(extra.revise ? { revise: extra.revise } : {}),
  });
const ids = (p: ReturnType<typeof plan>): string[] => p.stories.map((s) => s.id);

describe('the points (D-27)', () => {
  it('weights S 1, M 2, L 4 and stops at 12', () => {
    const a = [
      story({ size: 'L' }),
      story({ size: 'L' }),
      story({ size: 'L' }),
      story({ size: 'S' }),
    ];
    const p = plan(a);
    expect(p.points).toBe(12);
    expect(ids(p)).toEqual([a[0]!.id, a[1]!.id, a[2]!.id]);
    expect(MILESTONE_MAX_POINTS).toBe(12);
    expect(MILESTONE_MIN_POINTS).toBe(8);
  });

  it('fills by priority (lower number first, none last, then id)', () => {
    const a = story({ priority: 3 });
    const b = story({ priority: 1 });
    const c = story({ priority: undefined });
    const d = story({ priority: 2 });
    expect(ids(plan([a, b, c, d]))).toEqual([b.id, d.id, a.id, c.id]);
  });
});

describe('no story is split across milestones', () => {
  it('a story that would pass 12 is skipped whole and smaller ones that fit are still taken (RD-F07-2)', () => {
    const big = [story({ size: 'L' }), story({ size: 'L' }), story({ size: 'M' })]; // 4 + 4 + 2 = 10
    const l = story({ size: 'L' }); // 14: does not fit
    const s1 = story({ size: 'S' }); // 11
    const s2 = story({ size: 'S' }); // 12
    const s3 = story({ size: 'S' }); // would be 13
    const p = plan([...big, l, s1, s2, s3]);
    expect(p.points).toBe(12);
    expect(ids(p)).toEqual([...big.map((x) => x.id), s1.id, s2.id]);
    expect(p.skipped.map((s) => s.id)).toEqual([l.id, s3.id]);
    expect(p.skipped[0]?.reason).toMatch(/never split/);
  });

  it('planning again with the first plan applied puts every story in exactly one milestone, none dropped or doubled (property, 60 random backlogs)', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 60; round++) {
      const total = 3 + Math.floor(rnd() * 25);
      const all: PlanStory[] = Array.from({ length: total }, (_, i) =>
        story({
          id: `US-${String(900 + i)}`,
          size: (['S', 'M', 'L'] as const)[Math.floor(rnd() * 3)] as 'S' | 'M' | 'L',
          priority: Math.floor(rnd() * 10),
        }),
      );
      const seen = new Map<string, string>();
      for (let m = 1; m <= total; m++) {
        const p = plan(all);
        if (p.stories.length === 0) break;
        expect(p.points).toBeLessThanOrEqual(12);
        for (const s of p.stories) {
          expect(seen.has(s.id), `${s.id} already in ${seen.get(s.id)}`).toBe(false);
          seen.set(s.id, `MS-${m}`);
          all.find((x) => x.id === s.id)!.milestones = [`MS-0${m}`];
        }
      }
      // every sized story ended in a milestone, whole
      expect(seen.size).toBe(total);
    }
  });

  it('a story already in another milestone is never offered again', () => {
    const a = story({ milestones: ['MS-01'] });
    const b = story({});
    const p = plan([a, b]);
    expect(ids(p)).toEqual([b.id]);
    expect(p.skipped).toEqual([{ id: a.id, reason: 'already in MS-01' }]);
  });
});

describe('who can be planned', () => {
  it('an unsized story cannot (D-25), and says so', () => {
    const a = story({ size: undefined });
    const b = story({});
    const p = plan([a, b]);
    expect(ids(p)).toEqual([b.id]);
    expect(p.skipped[0]?.reason).toMatch(/not sized/);
  });

  it('only Backlog and Ready stories are candidates', () => {
    const a = story({ status: 'In Progress' });
    const b = story({ status: 'Done' });
    const c = story({ status: 'Cancelled' });
    const d = story({ status: 'Backlog' });
    expect(ids(plan([a, b, c, d]))).toEqual([d.id]);
  });
});

describe('dependencies', () => {
  it('a story follows the stories it depends on, even at a better priority', () => {
    const base = story({ priority: 5 });
    const dep = story({ priority: 1, dependsOn: ['US-DEP'] });
    dep.dependsOn = [base.id];
    const p = plan([dep, base]);
    expect(ids(p)).toEqual([base.id, dep.id]);
  });

  it('a dependency that is neither done, earlier nor planned keeps the story out, with the reason', () => {
    const filler = [
      story({ size: 'L', priority: 1 }),
      story({ size: 'L', priority: 2 }),
      story({ size: 'L', priority: 3 }),
    ]; // 12 points: full
    const blocker = story({ size: 'L', priority: 9 }); // does not fit
    const dep = story({ priority: 0, dependsOn: [blocker.id] });
    const p = plan([dep, ...filler, blocker]);
    expect(ids(p)).toEqual(filler.map((f) => f.id));
    expect(p.skipped.find((s) => s.id === dep.id)?.reason).toMatch(
      new RegExp(`waits for ${blocker.id}`),
    );
  });

  it('a finished dependency, or one in an earlier milestone, is met; an unknown one is not', () => {
    const done = story({ status: 'Done' });
    const earlier = story({ milestones: ['MS-01'] });
    const ok = story({ dependsOn: [done.id, earlier.id] });
    const lost = story({ dependsOn: ['US-999'] });
    const p = plan([done, earlier, ok, lost]);
    expect(ids(p)).toEqual([ok.id]);
    expect(p.skipped.find((s) => s.id === lost.id)?.reason).toMatch(/US-999/);
  });
});

describe('short milestones, tech debt, budget', () => {
  it('under 8 points with nothing more that fits: allowed, and says so', () => {
    const p = plan([story({ size: 'M' }), story({ size: 'S' })]);
    expect(p.points).toBe(3);
    expect(p.short).toBe(true);
    expect(p.warnings.join(' ')).toMatch(/short milestone/);
  });

  it('warns when tech debt is under about 15% of the points, and not at 18%', () => {
    expect(plan([story({ size: 'L' }), story({ size: 'L' })]).warnings.join(' ')).toMatch(
      /tech debt is 0%/,
    );
    const ok = plan([
      story({ size: 'L' }),
      story({ size: 'L' }),
      story({ size: 'M', type: 'Tech task' }),
      story({ size: 'S' }),
    ]); // 2 of 11 points
    expect(ok.warnings.join(' ')).not.toMatch(/tech debt/);
  });

  it('flags a plan whose story budgets exceed the remaining project budget', () => {
    const p = plan([story({ budget: 6, size: 'L' }), story({ budget: 6, size: 'L' })], {
      remainingBudget: 10,
    });
    expect(p.overBudget).toEqual({ remaining: 10, needed: 12 });
    expect(
      plan([story({ budget: 6, size: 'L' })], { remainingBudget: 6 }).overBudget,
    ).toBeUndefined();
  });
});

describe('revising a milestone', () => {
  it('keeps the stories that already started, and refills the rest by priority', () => {
    const started = story({ status: 'In Progress', size: 'L', milestones: ['MS-02'] });
    const unstarted = story({ status: 'Ready', size: 'M', milestones: ['MS-02'], priority: 50 });
    const better = story({ status: 'Ready', size: 'M', priority: 1 });
    const other = story({ status: 'Ready', size: 'L', milestones: ['MS-03'] });
    const p = plan([started, unstarted, better, other], { revise: 'MS-02' });
    expect(p.revise).toBe('MS-02');
    expect(p.stories[0]).toMatchObject({ id: started.id, pinned: true });
    expect(ids(p)).toEqual([started.id, better.id, unstarted.id]);
    expect(ids(p)).not.toContain(other.id);
  });

  it('a started story is never dropped even when the milestone is over 12 (warning only)', () => {
    const started = ['In Progress', 'In QA', 'Done', 'In Review'].map((status) =>
      story({ status, size: 'L', milestones: ['MS-02'] }),
    );
    const p = plan([...started, story({ size: 'S' })], { revise: 'MS-02' });
    expect(ids(p)).toEqual(started.map((x) => x.id));
    expect(p.warnings.join(' ')).toMatch(/above 12/);
  });
});

// ---- the CLI on a mirror -------------------------------------------------------------------------------------

function world(
  rows: Record<string, Record<string, unknown>>,
  milestones: Record<string, Record<string, unknown>> = {},
) {
  const dir = project();
  const mirror = path.join(dir, '.arima', 'mirror');
  mkdirSync(mirror, { recursive: true });
  const mk = (db: string, r: Record<string, Record<string, unknown>>): void =>
    writeFileSync(
      path.join(mirror, `${db}.json`),
      JSON.stringify({
        database: db,
        rows: Object.entries(r).map(([id, properties]) => ({
          page_id: `p-${id}`,
          last_edited_time: 't',
          id,
          properties,
        })),
      }),
    );
  mk('stories', rows);
  mk('milestones', milestones);
  mkdirSync(path.join(dir, '.arima', 'state'), { recursive: true });
  return dir;
}
const cli = async (dir: string, args: string[]) => {
  let out = '';
  let err = '';
  const code = await runPlanCli(
    [...args, '--project', dir],
    { out: (s) => (out += s), err: (s) => (err += s), cwd: dir },
    { lock: { sleep: () => Promise.resolve(), maxWaitMs: 0 } },
  );
  return { code, out, err };
};
const queued = (dir: string): Record<string, unknown>[] =>
  readdirSync(outboxDir(dir))
    .filter((f) => f.endsWith('.json'))
    .map(
      (f) =>
        JSON.parse(readFileSync(path.join(outboxDir(dir), f), 'utf8')) as Record<string, unknown>,
    );

const READY = (size: string, priority: number, extra: Record<string, unknown> = {}) => ({
  Status: 'Ready',
  Complexity: size,
  Priority: priority,
  ...extra,
});

describe('arima-plan', () => {
  it('--dry-run prints the plan and writes nothing', async () => {
    const dir = world({ 'US-001': READY('L', 1), 'US-002': READY('M', 2) });
    const r = await cli(dir, ['--dry-run']);
    expect(r.code).toBe(PLAN_EXIT.ok);
    expect(r.out).toContain('US-001');
    expect(readdirSync(path.join(dir, '.arima')).includes('outbox')).toBe(false);
  });

  it('queues one Milestones row with an engine-issued MS id, the story links, and the budget', async () => {
    const dir = world({
      'US-001': READY('L', 1),
      'US-002': READY('M', 2),
      'US-003': READY('S', 3, { Type: 'Tech task' }),
    });
    const r = await cli(dir, []);
    expect(r.code, r.err).toBe(PLAN_EXIT.ok);
    expect(r.out).toContain('queued MS-01');
    const [entry] = queued(dir);
    expect(entry).toMatchObject({ op: 'create', database: 'milestones', role: 'orchestrator' });
    const props = entry!['properties'] as Record<string, unknown>;
    expect(props['ID']).toBe('MS-01');
    expect(props['Stories']).toEqual(['US-001', 'US-002', 'US-003']);
    expect(props['Budget USD']).toBeGreaterThan(0);
    expect(props).not.toHaveProperty('Status');
  });

  it('revising updates the existing row and refuses a milestone that is not in the mirror', async () => {
    const dir = world(
      { 'US-001': READY('M', 1, { Milestone: ['MS-01'] }), 'US-002': READY('S', 2) },
      { 'MS-01': { Status: 'Planned' } },
    );
    const r = await cli(dir, ['--milestone', 'MS-01']);
    expect(r.code, r.err).toBe(0);
    expect(queued(dir)[0]).toMatchObject({ op: 'update', item_id: 'MS-01' });
    expect((await cli(dir, ['--milestone', 'MS-09'])).code).toBe(PLAN_EXIT.failed);
    expect((await cli(dir, ['--milestone', 'bad'])).code).toBe(PLAN_EXIT.usage);
  });

  it('exit 13 and nothing queued when the story budgets exceed the remaining project budget', async () => {
    const dir = world({
      'US-001': READY('L', 1, { 'Budget USD': 300 }),
      'US-002': READY('L', 2, { 'Budget USD': 300 }),
    });
    const row = {
      run_id: 'r-20261120-0900-01',
      date: '2026-11-20',
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
      cost_usd: 1,
      budget_usd: 2,
      result: 'pass',
    } as LedgerRow;
    await appendLedgerRow(dir, row);
    const r = await cli(dir, []);
    expect(r.code).toBe(PLAN_EXIT.budget);
    expect(r.err).toMatch(/remain/);
    expect(readdirSync(path.join(dir, '.arima')).includes('outbox')).toBe(false);
  });

  it('exit 4 when nothing sized and unstarted exists; exit 12 with the kill switch on; exit 11 while a run holds the lock', async () => {
    expect((await cli(world({ 'US-001': { Status: 'Ready' } }), [])).code).toBe(PLAN_EXIT.nothing);
    const a = world({ 'US-001': READY('M', 1) });
    setPauseFile(a, true);
    expect((await cli(a, [])).code).toBe(PLAN_EXIT.killSwitch);
    expect((await cli(a, ['--dry-run'])).code).toBe(PLAN_EXIT.ok);
    const b = world({ 'US-001': READY('M', 1) });
    acquireRunLock(b, 'r-20261120-0900-09', 3_600_000);
    expect((await cli(b, [])).code).toBe(PLAN_EXIT.locked);
  });

  it('the real mirror holds relations as page ids: they are named by row id (found on the dev workspace)', async () => {
    const dir = world(
      {
        'US-001': READY('M', 1, { Milestone: ['p-MS-01'] }),
        'US-002': READY('S', 2, { 'Depends on': ['p-US-001'] }),
        'US-003': { Status: 'In Progress', Complexity: 'L', Priority: 3, Milestone: ['p-MS-01'] },
      },
      { 'MS-01': { Status: 'Planned' } },
    );
    const s = storiesForPlan(dir, { perStoryDefault: 1 });
    expect(s.map((x) => [x.id, x.milestones, x.dependsOn])).toEqual([
      ['US-001', ['MS-01'], []],
      ['US-002', [], ['US-001']],
      ['US-003', ['MS-01'], []],
    ]);
    const r = await cli(dir, ['--milestone', 'MS-01', '--dry-run', '--json']);
    const plan = JSON.parse(r.out).plan as { stories: { id: string; pinned: boolean }[] };
    expect(plan.stories[0]).toMatchObject({ id: 'US-003', pinned: true });
    const again = await cli(dir, ['--dry-run']);
    expect(again.out).toContain('already in MS-01');
  });

  it('reads Depends on, the by-size budgets and the default budget from the mirror and the config', () => {
    const dir = world({
      'US-001': READY('S', 1),
      'US-002': READY('L', 2, { 'Depends on': 'US-001, US-009' }),
    });
    const s = storiesForPlan(dir, { perStoryDefault: 3, bySize: { S: 1 } });
    expect(s.map((x) => [x.id, x.budget, x.dependsOn])).toEqual([
      ['US-001', 1, []],
      ['US-002', 3, ['US-001', 'US-009']],
    ]);
  });
});
