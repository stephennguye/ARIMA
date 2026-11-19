// WP-109: plan the day (spec 7.2 step 4; F02 priority table). The rank table is a test table.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_STATUSES } from '../src/item.js';
import type { ItemStatus } from '../src/item.js';
import { appendLedgerRow, buildLedgerRow } from '../src/ledger.js';
import { RANKS, RANK_NAMES, byTieBreak, planDay, storiesFromMirror } from '../src/queue.js';
import type { PlanInput, PlanLimits, RankName, StoryFacts } from '../src/queue.js';
import { tempDir } from './helpers.js';

const LIMITS: PlanLimits = {
  maxDevelopers: 2,
  maxPrsAwaitingHuman: 5,
  prsAwaitingHuman: 0,
  reviewers: 1,
};

const story = (id: string, status: ItemStatus, over: Partial<StoryFacts> = {}): StoryFacts => ({
  id,
  status,
  attempt: 1,
  testCases: 2,
  openBugs: 0,
  budgetOk: true,
  ...over,
});

const shape = (p: ReturnType<typeof planDay>): string[] =>
  p.units.map((u) => `${u.rank}:${u.kind}:${u.role}:${u.item}`);

/** One candidate per rank: the table the order must follow. */
const WORLD: PlanInput = {
  incidents: [
    { id: 'INC-001', priority: 'P1', needsHotfix: true },
    { id: 'INC-002', priority: 'P3' },
  ],
  ciRedOnMain: true,
  stagingSmokeFailing: true,
  stories: [
    story('US-001', 'In Progress', { attempt: 2 }), // rank 3 rework
    story('US-002', 'In Review', { prReady: true }), // rank 4 review
    story('US-003', 'In QA'), // rank 4 qa
    story('US-004', 'Ready', { testCases: 0 }), // rank 5 test-write
    story('US-005', 'Ready'), // rank 6 new story
  ],
  recurringDue: [{ name: 'dependency audit', kind: 'security-scan', role: 'security' }],
  docsAndDebt: [{ item: 'US-009', kind: 'author', role: 'ba' }],
};

describe('the priority table (spec 7.2 step 4)', () => {
  it('the ranks are exactly the spec order', () => {
    expect([...RANKS]).toEqual([
      'incident',
      'broken_main',
      'rework',
      'qa_of_prs',
      'test_cases',
      'new_stories',
      'recurring',
      'docs_and_debt',
    ]);
    expect(RANK_NAMES).toHaveLength(8);
  });

  it('one candidate per rank comes out in rank order, as the right unit for the right role', () => {
    const p = planDay(WORLD, { ...LIMITS, maxDevelopers: 4 });
    expect(shape(p)).toEqual([
      '1:triage:devops:INC-001',
      '1:hotfix:developer:INC-001',
      '2:fix:developer:none',
      '2:deploy-staging:devops:none',
      '3:develop:developer:US-001',
      '4:review:tech-lead:US-002',
      '4:qa:qa:US-003',
      '5:test-write:qa:US-004',
      '6:develop:developer:US-005',
      '7:security-scan:security:none',
      '8:author:ba:US-009',
    ]);
    expect(p.units.map((u) => u.order)).toEqual(p.units.map((_, i) => i + 1));
    expect(p.units.every((u) => u.why.length > 0)).toBe(true);
  });

  it('only P1 and P2 incidents are planned', () => {
    const p = planDay(
      {
        stories: [],
        incidents: [
          { id: 'INC-1', priority: 'P3' },
          { id: 'INC-2', priority: 'P2' },
          { id: 'INC-3', priority: 'P4' },
        ],
      },
      LIMITS,
    );
    expect(shape(p)).toEqual(['1:triage:devops:INC-2']);
  });

  it('rework outranks new work, and a rework unit carries its reason', () => {
    const p = planDay(
      {
        stories: [
          story('US-001', 'In Progress', { attempt: 2, lastFailureQa: true }),
          story('US-002', 'In Progress', { attempt: 2 }),
          story('US-003', 'In Progress', { openBugs: 1 }),
          story('US-004', 'Ready'),
        ],
      },
      { ...LIMITS, maxDevelopers: 3 },
    );
    expect(p.units.map((u) => [u.item, u.rank, u.reworkReason])).toEqual([
      ['US-001', 3, 'failed_qa'],
      ['US-002', 3, 'failed_review'],
      ['US-003', 3, 'bug'],
    ]);
    expect(p.skipped.map((s) => s.item)).toContain('US-004');
  });
});

describe('a story is only started when it is Ready (DoR met) and has test cases', () => {
  it('no other status is ever started as a new story', () => {
    for (const status of ITEM_STATUSES.filter((s) => s !== 'Ready')) {
      const p = planDay({ stories: [story('US-001', status)] }, LIMITS);
      expect(
        p.units.filter((u) => u.rank === 6),
        status,
      ).toEqual([]);
    }
  });
  it('a Ready story with no test cases gets test-writing, not development', () => {
    const p = planDay({ stories: [story('US-001', 'Ready', { testCases: 0 })] }, LIMITS);
    expect(shape(p)).toEqual(['5:test-write:qa:US-001']);
  });
  it('a story whose budget is used up is skipped with the reason, whatever its rank', () => {
    const p = planDay(
      {
        stories: [
          story('US-001', 'Ready', { budgetOk: false }),
          story('US-002', 'In Progress', { attempt: 2, budgetOk: false }),
          story('US-003', 'In QA', { budgetOk: false }),
          story('US-004', 'Ready', { testCases: 0, budgetOk: false }),
        ],
      },
      LIMITS,
    );
    expect(p.units).toEqual([]);
    expect(p.skipped.map((s) => s.reason)).toEqual(Array(4).fill('story budget used up'));
  });
});

describe('work in progress, parallelism and the review queue', () => {
  const ready = (n: number): StoryFacts[] =>
    Array.from({ length: n }, (_, i) => story(`US-${String(i + 1).padStart(3, '0')}`, 'Ready'));

  it('starts at most as many new stories as there are developer slots', () => {
    const p = planDay({ stories: ready(5) }, { ...LIMITS, maxDevelopers: 2 });
    expect(shape(p)).toEqual(['6:develop:developer:US-001', '6:develop:developer:US-002']);
    expect(p.skipped.map((s) => s.item)).toEqual(['US-003', 'US-004', 'US-005']);
  });

  it('a minimum of one developer, and WIP counts stories already In Progress', () => {
    expect(planDay({ stories: ready(2) }, { ...LIMITS, maxDevelopers: 0 }).units).toHaveLength(1);
    const p = planDay(
      {
        stories: [
          story('US-001', 'In Progress'),
          ...ready(2).map((s, i) => ({ ...s, id: `US-00${i + 2}` })),
        ],
      },
      { ...LIMITS, maxDevelopers: 2 },
    );
    expect(shape(p)).toEqual(['6:develop:developer:US-002']);
    expect(p.skipped[0]?.reason).toMatch(/work in progress is at its limit \(2\)/);
  });

  it('rework takes developer slots before new stories do', () => {
    const p = planDay(
      {
        stories: [
          story('US-001', 'In Progress', { attempt: 2 }),
          ...ready(2).map((s, i) => ({ ...s, id: `US-00${i + 2}` })),
        ],
      },
      { ...LIMITS, maxDevelopers: 2 },
    );
    expect(shape(p)).toEqual(['3:develop:developer:US-001', '6:develop:developer:US-002']);
  });

  it('no new story when the review queue is full; ranks 3, 4, 5 and 8 continue', () => {
    const input: PlanInput = {
      ...WORLD,
      incidents: [],
      ciRedOnMain: false,
      stagingSmokeFailing: false,
    };
    const full = planDay(input, { ...LIMITS, maxDevelopers: 4, prsAwaitingHuman: 5 });
    expect(full.units.map((u) => u.rank)).toEqual([3, 4, 4, 5, 7, 8]);
    expect(full.skipped).toEqual([
      {
        rankName: 'new_stories',
        item: 'US-005',
        reason: '5 pull requests await your approval (limit 5)',
      },
    ]);
    const room = planDay(input, { ...LIMITS, maxDevelopers: 4, prsAwaitingHuman: 4 });
    expect(room.units.map((u) => u.rank)).toContain(6);
  });

  it('a regulated profile gets two review units per PR', () => {
    const p = planDay(
      { stories: [story('US-001', 'In Review', { prReady: true })] },
      { ...LIMITS, reviewers: 2 },
    );
    expect(p.units.map((u) => [u.kind, u.reviewer])).toEqual([
      ['review', 1],
      ['review', 2],
    ]);
    expect(
      planDay({ stories: [story('US-001', 'In Review', { prReady: true })] }, LIMITS).units[0]
        ?.reviewer,
    ).toBeUndefined();
  });

  it('an In Review story without a ready PR (no PR, CI red) is not reviewed', () => {
    expect(
      planDay(
        {
          stories: [story('US-001', 'In Review'), story('US-002', 'In Review', { prReady: false })],
        },
        LIMITS,
      ).units,
    ).toEqual([]);
  });

  it('a broken main takes a developer slot from new stories', () => {
    const p = planDay(
      { stories: [story('US-001', 'Ready')], ciRedOnMain: true },
      { ...LIMITS, maxDevelopers: 1 },
    );
    expect(shape(p)).toEqual(['2:fix:developer:none']);
    expect(p.skipped[0]?.reason).toMatch(/developer slots/);
  });
});

describe('ties inside a rank: PO priority, then S before L, then the oldest', () => {
  it('sorts by priority, size, id', () => {
    const items = [
      story('US-010', 'Ready', { size: 'L', priority: 2 }),
      story('US-011', 'Ready', { size: 'S', priority: 2 }),
      story('US-012', 'Ready', { priority: 1, size: 'L' }),
      story('US-013', 'Ready'),
      story('US-009', 'Ready', { size: 'S', priority: 2 }),
      story('US-014', 'Ready', { size: 'M' }),
    ];
    expect([...items].sort(byTieBreak).map((s) => s.id)).toEqual([
      'US-012',
      'US-009',
      'US-011',
      'US-010',
      'US-014',
      'US-013',
    ]);
    const p = planDay({ stories: items }, { ...LIMITS, maxDevelopers: 6 });
    expect(p.units.map((u) => u.item)).toEqual([
      'US-012',
      'US-009',
      'US-011',
      'US-010',
      'US-014',
      'US-013',
    ]);
  });
  it('compares ids as numbers, not text', () => {
    expect(
      [story('US-100', 'Ready'), story('US-99', 'Ready')].sort(byTieBreak).map((s) => s.id),
    ).toEqual(['US-99', 'US-100']);
  });
});

describe('an item gets at most one unit a day', () => {
  it('a story claimed by an earlier rank is not planned again', () => {
    const p = planDay(
      {
        stories: [story('US-001', 'In Progress', { attempt: 2 })],
        docsAndDebt: [{ item: 'US-001', kind: 'author', role: 'ba' }],
      },
      LIMITS,
    );
    expect(shape(p)).toEqual(['3:develop:developer:US-001']);
  });
});

describe('mutating the order breaks a test', () => {
  const expected = shape(planDay(WORLD, { ...LIMITS, maxDevelopers: 4 }));
  it('every swap of two ranks changes the plan', () => {
    for (let i = 0; i < RANKS.length; i++)
      for (let j = i + 1; j < RANKS.length; j++) {
        const swapped = [...RANKS] as RankName[];
        [swapped[i], swapped[j]] = [swapped[j] as RankName, swapped[i] as RankName];
        const got = shape(planDay(WORLD, { ...LIMITS, maxDevelopers: 4 }, swapped));
        expect(got, `${RANKS[i]} <-> ${RANKS[j]}`).not.toEqual(expected);
      }
  });
  it('dropping a rank drops its units', () => {
    for (const r of RANKS) {
      const got = shape(
        planDay(
          WORLD,
          { ...LIMITS, maxDevelopers: 4 },
          RANKS.filter((x) => x !== r),
        ),
      );
      expect(got.length, r).toBeLessThan(expected.length);
    }
  });
});

describe('storiesFromMirror', () => {
  it('reads status, priority, size, attempt, test cases, open bugs and the budget from the mirror and the ledger', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.arima', 'mirror'), { recursive: true });
    const row = (id: string, properties: Record<string, unknown>) => ({
      page_id: `p-${id}`,
      last_edited_time: 't',
      id,
      properties,
    });
    writeFileSync(
      path.join(dir, '.arima', 'mirror', 'stories.json'),
      JSON.stringify({
        database: 'stories',
        rows: [
          row('US-001', {
            Status: 'Ready',
            Priority: 1,
            Complexity: 'S',
            'Test Cases': ['TC-0001', 'TC-0002'],
            Bugs: [],
          }),
          row('US-002', {
            Status: 'In Progress',
            Attempt: 2,
            Complexity: 'M',
            Bugs: ['BUG-001', 'BUG-002', 'BUG-003'],
            'Budget USD': 5,
          }),
          row('US-003', { Status: 'Ready', Complexity: 'S' }),
          row('XX-1', { Status: 'Ready' }),
          row('US-004', {}),
        ],
      }),
    );
    writeFileSync(
      path.join(dir, '.arima', 'mirror', 'bugs.json'),
      JSON.stringify({
        database: 'bugs',
        rows: [
          row('BUG-001', { Status: 'Open' }),
          row('BUG-002', { Status: 'Verified' }),
          row('BUG-003', { Status: 'Fixed' }),
        ],
      }),
    );
    await appendLedgerRow(
      dir,
      buildLedgerRow(
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          total_cost_usd: 0.9,
          duration_ms: 1,
          num_turns: 1,
        },
        {
          run_id: 'r-20261119-1100-01',
          date: '2026-11-19',
          project: 'TAS',
          phase: 4,
          item: 'US-003',
          role: 'developer',
          attempt: 1,
          is_rework: false,
          budget_usd: 2,
        },
      ),
    );
    const cfg = { perStoryDefault: 2, bySize: { S: 1, M: 3, L: 6 }, perRunCap: 2 };
    const s = storiesFromMirror(dir, cfg, { 'US-001': { prReady: true } });
    expect(s.map((x) => x.id)).toEqual(['US-001', 'US-002', 'US-003']);
    expect(s[0]).toMatchObject({
      status: 'Ready',
      priority: 1,
      size: 'S',
      testCases: 2,
      openBugs: 0,
      budgetOk: true,
      prReady: true,
    });
    expect(s[1]).toMatchObject({ status: 'In Progress', attempt: 2, openBugs: 2, budgetOk: true });
    expect(s[2]).toMatchObject({ budgetOk: false }); // S = 1, spent 0.9, under the 0.25 cost floor
    expect(storiesFromMirror(tempDir(), cfg)).toEqual([]);
  });
});
