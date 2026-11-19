// E-S2 failure loops (spec 7.12, F10 5.3, WP-150): what the engine does when a role fails, is refused by
// review three times, runs out of story budget or out of turns. Stub roles, the real dispatcher. Every
// variant ends in a state the human can read: Blocked, with a Question, and a ledger row for every run.
//
// Variant (c), "fake CI fails once then passes: rerun once; fails twice: a BUG on the test", belongs to the
// flaky-CI rerun that WP-215 builds; it is listed as a todo so it cannot be forgotten.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../../plugins/arima/scripts/src/events.js';
import { readItem } from '../../plugins/arima/scripts/src/item.js';
import { readLedger } from '../../plugins/arima/scripts/src/ledger.js';
import { readQuestions } from '../../plugins/arima/scripts/src/questions.js';
import { ledgerRows } from '../lib/graders.js';
import { approveG2, day, readyAll, reportText, stubRoles, world } from './support.js';

const blockedWithQuestion = (dir: string, item: string): string[] => {
  const out: string[] = [];
  const qs = Object.values(readQuestions(dir)).filter((q) => q.item === item);
  if (qs.length === 0) out.push('no question was raised');
  if (!qs.some((q) => q.blocking)) out.push('no blocking question');
  return out;
};

describe('E-S2 failure loops', () => {
  it('(a) an invalid report: result fail, report_invalid, retried once, the second failure Blocks the story with a blocking Question', async () => {
    const w = await world({ stories: 1 });
    stubRoles(w);
    writeFileSync(path.join(w.stub, 'developer-develop.txt'), 'I finished, trust me.');
    await approveG2(w);
    await readyAll(w);
    const r = await day(w, 1);
    const rows = readLedger(w.dir).filter((x) => x.role === 'developer');
    expect(rows.map((x) => [x.result, x.reason])).toEqual([
      ['fail', 'report_invalid'],
      ['fail', 'report_invalid'],
    ]);
    const retries = readEvents(w.dir).filter((e) => e.type === 'unit.retried').length;
    expect(ledgerRows(readLedger(w.dir), r.dispatched.filter((d) => d.result !== 'skipped').length + retries)).toEqual([]);
    expect(readEvents(w.dir).filter((e) => e.type === 'unit.retried')).toHaveLength(1);
    expect(readEvents(w.dir).some((e) => e.type === 'pr.published')).toBe(false);
    expect(w.status(w.stories[0] as string)).toBe('Blocked');
    expect(blockedWithQuestion(w.dir, w.stories[0] as string)).toEqual([]);
  }, 120_000);

  it('(b) the tech-lead asks for changes three times: the third failed attempt Blocks the story with a Question, the attempt counter says so', async () => {
    const w = await world({ stories: 1 });
    stubRoles(w);
    writeFileSync(
      path.join(w.stub, 'tech-lead-review.txt'),
      reportText('tech-lead', {
        verdict: { result: 'changes_requested', reasons: ['the discount is ignored'] },
        findings: [
          {
            severity: 'blocker',
            location: 'src/cart.ts:1',
            claim: 'The discount is ignored',
            evidence: 'line 1 sums the price only',
            recommendation: 'Apply the discount',
          },
        ],
      }),
    );
    await approveG2(w);
    await readyAll(w);
    const id = w.stories[0] as string;
    let days = 0;
    while (days < 20 && w.status(id) !== 'Blocked') {
      days += 1;
      await day(w, days);
    }
    expect(w.status(id)).toBe('Blocked');
    const edges = readEvents(w.dir).filter((e) => e.type === 'item.status' && e.item === id).map((e) => `${String(e.data?.['from'])}>${String(e.data?.['to'])}`);
    expect(edges.filter((e) => e === 'In Review>In Progress')).toHaveLength(2);
    expect(edges.at(-1)).toBe('In Review>Blocked');
    expect(readItem(w.dir, id).attempt).toBeGreaterThanOrEqual(3);
    expect(readLedger(w.dir).filter((r) => r.role === 'tech-lead')).toHaveLength(3);
    expect(blockedWithQuestion(w.dir, id)).toEqual([]);
  }, 240_000);

  it('(d) a story whose budget is used up is not started again: Blocked and a Question, no further run', async () => {
    const w = await world({ stories: 1 });
    stubRoles(w);
    const id = w.stories[0] as string;
    // 0.30 USD for the story and a stub run that costs 0.25: after the first run less than the cost floor is left
    const row = w.fake.rowByTitle('Stories', id)!;
    w.fake.humanEdit(row.id, { 'Budget USD': { number: 0.3 } });
    await approveG2(w);
    await readyAll(w);
    for (let d = 1; d <= 4; d++) await day(w, d);
    const runs = readLedger(w.dir).filter((r) => r.item === id);
    const spent = runs.reduce((n, r) => n + r.cost_usd, 0);
    // the story used its budget and was stopped, it did not run on
    expect(spent).toBeLessThanOrEqual(0.3 + 0.25);
    expect(runs.length).toBeLessThanOrEqual(2);
    const hard = readEvents(w.dir).filter((e) => e.type === 'hardstop.hit' && e.data?.['stop'] === 'story_budget');
    const skipped = readEvents(w.dir).some((e) => e.type === 'phase.step_done');
    expect(skipped).toBe(true);
    expect(w.status(id)).toBe('Blocked');
    expect(hard).toHaveLength(1); // once, not every day
    expect(runs).toHaveLength(1);
    expect(blockedWithQuestion(w.dir, id)).toEqual([]);
  }, 240_000);

  it('(e) a run that ends on the turn cap is a blocked run: ledger row result blocked, the story Blocked, a Question', async () => {
    const w = await world({ stories: 1 });
    stubRoles(w);
    await approveG2(w);
    await readyAll(w);
    const r = await day(w, 1, { extraEnv: { STUB_MODE: 'max_turns' } });
    const rows = readLedger(w.dir).filter((x) => x.role === 'developer');
    expect(rows.map((x) => x.result)).toEqual(['blocked']);
    expect(r.dispatched[0]).toMatchObject({ result: 'blocked' });
    expect(w.status(w.stories[0] as string)).toBe('Blocked');
    expect(blockedWithQuestion(w.dir, w.stories[0] as string)).toEqual([]);
  }, 120_000);

  it.todo('(c) fake CI fails once then passes: one rerun and on; fails twice: a BUG on the test (WP-215, the flaky-CI rerun)');
});
