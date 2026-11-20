// WP-217: the milestone review (open, veto rows, close, hold) and the retro inputs. Unit level: a mirror
// written by hand, the real state machine and outbox files. The whole flow through the dispatcher is E-S5.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { appendLedgerRow } from '../src/ledger.js';
import type { LedgerRow } from '../src/ledger.js';
import {
  REVIEW_WINDOW_HOURS,
  closeReview,
  computeRetro,
  heldForReview,
  milestoneStories,
  openReview,
  readReviews,
  renderRetro,
  reviewReady,
  reviewTick,
} from '../src/milestone-review.js';
import { outboxDir } from '../src/notion/outbox.js';
import { project } from './helpers.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const RUN = 'r-20261120-1200-01';
const hours = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

const row = (id: string, properties: Record<string, unknown>) => ({
  page_id: `p-${id}`,
  last_edited_time: 't',
  id,
  properties,
});
const mirror = (dir: string, db: string, rows: unknown[]): void => {
  mkdirSync(path.join(dir, '.arima', 'mirror'), { recursive: true });
  writeFileSync(
    path.join(dir, '.arima', 'mirror', `${db}.json`),
    JSON.stringify({ database: db, rows }),
  );
};
/** A project with milestone MS-01 and the given story statuses (each linked to it by page id, as the real mirror holds it). */
async function world(
  statuses: Record<string, string>,
  ms: Record<string, unknown> = { Status: 'Active' },
) {
  const dir = project();
  mirror(dir, 'milestones', [row('MS-01', ms)]);
  mirror(
    dir,
    'stories',
    Object.entries(statuses).map(([id, Status]) =>
      row(id, { Status, Complexity: 'S', Milestone: ['p-MS-01'] }),
    ),
  );
  await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
  return dir;
}
const queued = (dir: string): Record<string, unknown>[] => {
  const d = outboxDir(dir);
  return existsSync(d)
    ? readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')) as Record<string, unknown>)
    : [];
};
const ledger = (over: Partial<LedgerRow>): LedgerRow =>
  ({
    run_id: 'r-20261120-0900-01',
    date: '2026-11-20',
    project: 'TAS',
    phase: 4,
    item: 'US-001',
    role: 'developer',
    attempt: 1,
    is_rework: false,
    subtype: 'success',
    num_turns: 1,
    duration_ms: 1,
    tokens: { input: 1, output: 1, cache_read: 0, cache_creation: 0 },
    cost_usd: 1,
    budget_usd: 2,
    result: 'pass',
    ...over,
  }) as LedgerRow;

describe('when a review is ready to open', () => {
  it('only when every story of the milestone is accepted, cancelled or released, and at least one is accepted', async () => {
    expect(
      reviewReady(await world({ 'US-001': 'PO Acceptance', 'US-002': 'PO Acceptance' }), 'MS-01'),
    ).toBe(true);
    expect(
      reviewReady(
        await world({ 'US-001': 'PO Acceptance', 'US-002': 'Cancelled', 'US-003': 'Done' }),
        'MS-01',
      ),
    ).toBe(true);
    expect(
      reviewReady(await world({ 'US-001': 'PO Acceptance', 'US-002': 'In QA' }), 'MS-01'),
    ).toBe(false);
    expect(
      reviewReady(await world({ 'US-001': 'PO Acceptance', 'US-002': 'Blocked' }), 'MS-01'),
    ).toBe(false);
    expect(reviewReady(await world({ 'US-001': 'Cancelled' }), 'MS-01')).toBe(false);
    expect(reviewReady(await world({}), 'MS-01')).toBe(false);
  });

  it('follows what the engine last decided, not the lagging mirror (a veto just applied reopens the story)', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance', 'US-002': 'PO Acceptance' });
    await appendEvent(dir, {
      type: 'item.status',
      actor: 'po',
      item: 'US-002',
      data: { from: 'PO Acceptance', to: 'In Progress' },
    });
    expect(reviewReady(dir, 'MS-01')).toBe(false);
  });

  it('finds the stories of a milestone through page-id relations', async () => {
    const dir = await world({ 'US-001': 'Ready' });
    expect(milestoneStories(dir, 'MS-01').map((s) => s.id)).toEqual(['US-001']);
    expect(milestoneStories(dir, 'MS-09')).toEqual([]);
  });
});

describe('opening the review', () => {
  it('a Decisions row with a veto box per accepted story, the review on the milestone page, Status Review (engine), the retro file, the state and an event', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance', 'US-002': 'Done', 'US-003': 'Cancelled' });
    const rec = await openReview(
      { projectDir: dir, runId: RUN, now: NOW, stagingUrl: 'http://localhost:3000' },
      'MS-01',
    );
    expect(rec.stories).toEqual(['US-001', 'US-002']);
    expect(rec.decisions).toEqual({ 'US-001': 'DEC-0001', 'US-002': 'DEC-0002' });
    const entries = queued(dir);
    const decs = entries.filter((e) => e['database'] === 'decisions');
    expect(decs).toHaveLength(2);
    expect(decs[0]).toMatchObject({ op: 'create', role: 'orchestrator' });
    expect(decs[0]!['properties']).toMatchObject({
      ID: 'DEC-0001',
      Chosen: 'accepted',
      Item: 'US-001',
      Reversible: true,
    });
    expect(Object.keys(decs[0]!['properties'] as object)).not.toContain('Veto'); // human-only
    const page = entries.find((e) => e['op'] === 'append_content');
    expect(page).toMatchObject({ database: 'milestones', item_id: 'MS-01' });
    expect(String(page!['content_markdown'])).toContain('veto it on DEC-0001');
    expect(String(page!['content_markdown'])).toContain('Staging: http://localhost:3000');
    const status = entries.find(
      (e) => (e['properties'] as Record<string, unknown> | undefined)?.['Status'] === 'Review',
    );
    expect(status).toMatchObject({ database: 'milestones', item_id: 'MS-01' });
    expect(String(status!['id'])).toMatch(/^st-/);
    expect(existsSync(path.join(dir, '.arima', 'retro', 'MS-01.md'))).toBe(true);
    expect(readReviews(dir)['MS-01']).toMatchObject({
      opened_at: NOW.toISOString(),
      stories: ['US-001', 'US-002'],
    });
    expect(readEvents(dir).find((e) => e.type === 'milestone.review_opened')?.data).toMatchObject({
      milestone: 'MS-01',
    });
  });
});

describe('closing the review', () => {
  it('moves the stories still in PO Acceptance to Done, not a story the engine already sent back; the milestone is Active while one is open', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance', 'US-002': 'PO Acceptance' });
    await openReview({ projectDir: dir, runId: RUN, now: NOW }, 'MS-01');
    await appendEvent(dir, {
      type: 'item.status',
      actor: 'po',
      item: 'US-002',
      data: { from: 'PO Acceptance', to: 'In Progress' },
    });
    const accepted = await closeReview({ projectDir: dir, runId: RUN, now: hours(25) }, 'MS-01');
    expect(accepted).toEqual(['US-001']);
    const edges = readEvents(dir).filter(
      (e) => e.type === 'item.status' && e.data?.['to'] === 'Done',
    );
    expect(edges.map((e) => e.item)).toEqual(['US-001']);
    expect(readReviews(dir)['MS-01']?.closed_at).toBe(hours(25).toISOString());
    const last = queued(dir).filter(
      (e) =>
        e['database'] === 'milestones' &&
        e['op'] === 'update' &&
        String(e['id']).endsWith('-active'),
    );
    expect(last).toHaveLength(1);
    expect(readEvents(dir).find((e) => e.type === 'milestone.review_closed')?.data).toMatchObject({
      accepted: ['US-001'],
      milestone_done: false,
    });
  });

  it('the milestone becomes Done when every story is accepted', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance' });
    await openReview({ projectDir: dir, runId: RUN, now: NOW }, 'MS-01');
    await closeReview({ projectDir: dir, runId: RUN, now: hours(24) }, 'MS-01');
    expect(
      queued(dir).some(
        (e) =>
          String(e['id']).endsWith('-done') &&
          (e['properties'] as Record<string, unknown>)['Status'] === 'Done',
      ),
    ).toBe(true);
  });

  it('refuses to close a milestone that has no open review', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance' });
    await expect(closeReview({ projectDir: dir, runId: RUN, now: NOW }, 'MS-01')).rejects.toThrow(
      /no open review/,
    );
  });
});

describe('the daily tick and the hold', () => {
  it('opens a ready milestone once; closes it at exactly the window and not before', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance' });
    expect(await reviewTick({ projectDir: dir, runId: RUN, now: NOW })).toEqual({
      opened: ['MS-01'],
      closed: [],
    });
    expect(await reviewTick({ projectDir: dir, runId: RUN, now: hours(1) })).toEqual({
      opened: [],
      closed: [],
    });
    expect(
      await reviewTick({ projectDir: dir, runId: RUN, now: hours(REVIEW_WINDOW_HOURS - 0.01) }),
    ).toEqual({ opened: [], closed: [] });
    expect(
      await reviewTick({ projectDir: dir, runId: RUN, now: hours(REVIEW_WINDOW_HOURS) }),
    ).toEqual({ opened: [], closed: ['MS-01'] });
    expect(await reviewTick({ projectDir: dir, runId: RUN, now: hours(72) })).toEqual({
      opened: [],
      closed: [],
    });
  });

  it('a Done milestone and a collecting one are left alone', async () => {
    const done = await world({ 'US-001': 'PO Acceptance' }, { Status: 'Done' });
    expect(await reviewTick({ projectDir: done, runId: RUN, now: NOW })).toEqual({
      opened: [],
      closed: [],
    });
    const collecting = await world({ 'US-001': 'PO Acceptance', 'US-002': 'In Progress' });
    expect(await reviewTick({ projectDir: collecting, runId: RUN, now: NOW })).toEqual({
      opened: [],
      closed: [],
    });
  });

  it('holds a milestone story in PO Acceptance until the review closes; a story with no milestone, or in a closed one, is not held', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance' });
    mirror(dir, 'stories', [
      ...(JSON.parse(readFileSync(path.join(dir, '.arima', 'mirror', 'stories.json'), 'utf8'))
        .rows as unknown[]),
      row('US-009', { Status: 'PO Acceptance' }),
    ]);
    expect(heldForReview(dir, 'US-001')).toBe(true); // review not even open yet
    expect(heldForReview(dir, 'US-009')).toBe(false);
    await reviewTick({ projectDir: dir, runId: RUN, now: NOW });
    expect(heldForReview(dir, 'US-001')).toBe(true);
    await reviewTick({ projectDir: dir, runId: RUN, now: hours(24) });
    expect(heldForReview(dir, 'US-001')).toBe(false);
  });
});

describe('the retro inputs', () => {
  it('cost, rework by reason, first-pass QA, review findings and vetoes, from the ledger, the reports and the events', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance', 'US-002': 'PO Acceptance' });
    for (const r of [
      ledger({ run_id: 'r-20261120-0900-01', cost_usd: 2 }),
      ledger({
        run_id: 'r-20261120-0900-02',
        cost_usd: 1,
        is_rework: true,
        rework_reason: 'failed_review',
      }),
      ledger({
        run_id: 'r-20261120-0900-03',
        cost_usd: 1,
        is_rework: true,
        rework_reason: 'failed_review',
      }),
      ledger({
        run_id: 'r-20261120-0900-04',
        cost_usd: 1,
        is_rework: true,
        rework_reason: 'vetoed',
        item: 'US-002',
      }),
      ledger({
        run_id: 'r-20261120-0900-05',
        role: 'qa',
        result: 'pass',
        item: 'US-002',
        cost_usd: 1,
      }),
      ledger({
        run_id: 'r-20261120-0900-06',
        role: 'qa',
        result: 'fail',
        item: 'US-001',
        cost_usd: 1,
      }),
      ledger({ run_id: 'r-20261120-0900-07', cost_usd: 9, item: 'US-777' }), // not in the milestone
    ])
      await appendLedgerRow(dir, r);
    mkdirSync(path.join(dir, '.arima', 'runs'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'runs', 'r-20261120-0900-08.report.json'),
      JSON.stringify({
        findings: [
          { severity: 'minor', location: 'a.ts:1', claim: 'naming' },
          { severity: 'blocker', location: 'b.ts:2', claim: 'discount ignored' },
        ],
      }),
    );
    await appendEvent(dir, {
      type: 'report.accepted',
      actor: 'system',
      run_id: 'r-20261120-0900-08',
      item: 'US-001',
      data: { role: 'tech-lead', kind: 'review' },
    });
    await appendEvent(dir, {
      type: 'decision.vetoed',
      actor: 'human',
      item: 'US-002',
      data: { decision: 'DEC-0001', reason: 'rounding' },
    });
    const r = computeRetro(dir, 'MS-01', ['US-001', 'US-002']);
    expect(r.runs).toBe(6);
    expect(r.costUsd).toBe(7);
    expect(r.reworkCostUsd).toBe(3);
    expect(r.reworkShare).toBeCloseTo(0.43, 2);
    expect(r.reworkByReason).toEqual({
      failed_review: { runs: 2, costUsd: 2 },
      vetoed: { runs: 1, costUsd: 1 },
    });
    expect(r.firstPassQa).toEqual({ passed: 1, total: 2 });
    expect(r.findings.map((f) => f.severity)).toEqual(['blocker', 'minor']); // most severe first
    expect(r.vetoes).toEqual([{ item: 'US-002', reason: 'rounding' }]);
    const text = renderRetro(r);
    expect(text).toContain('failed_review: 2 runs, 2 USD');
    expect(text).toContain('First-pass QA: 1 of 2');
    expect(text).toContain('US-002 (rounding)');
  });

  it('an empty milestone has zero numbers and says none', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance' });
    const r = computeRetro(dir, 'MS-01', ['US-001']);
    expect(r).toMatchObject({ runs: 0, costUsd: 0, reworkShare: 0, firstPassQa: undefined });
    expect(renderRetro(r)).toContain('Rework by reason: none');
  });

  it('refuses to open a review whose retro text looks like it holds a secret (a finding quoting one)', async () => {
    const dir = await world({ 'US-001': 'PO Acceptance' });
    mkdirSync(path.join(dir, '.arima', 'runs'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'runs', 'r-20261120-0900-08.report.json'),
      JSON.stringify({
        findings: [
          {
            severity: 'major',
            location: 'a.ts:1',
            claim: 'uses ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
          },
        ],
      }),
    );
    await appendEvent(dir, {
      type: 'report.accepted',
      actor: 'system',
      run_id: 'r-20261120-0900-08',
      item: 'US-001',
      data: { role: 'tech-lead', kind: 'review' },
    });
    await expect(openReview({ projectDir: dir, runId: RUN, now: NOW }, 'MS-01')).rejects.toThrow(
      /secret/,
    );
    expect(readReviews(dir)).toEqual({});
  });
});
