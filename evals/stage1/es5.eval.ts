// E-S5 the milestone review and the learning loop (spec 6.4, 7.11, 12.2, D-16, WP-217): through the real
// dispatcher with stub roles. Two stories of a milestone are accepted and WAIT in PO Acceptance; the review
// opens with a Decisions row (a veto box) per story; the human vetoes one and approves a lesson; the
// next developer packet carries the lesson; the review closes after its window and accepts the other story.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPlanCli } from '../../plugins/arima/scripts/src/cli/plan-cli.js';
import { readEvents } from '../../plugins/arima/scripts/src/events.js';
import { readReviews } from '../../plugins/arima/scripts/src/milestone-review.js';
import { readMirror } from '../../plugins/arima/scripts/src/notion/mirror.js';
import { enqueue } from '../../plugins/arima/scripts/src/notion/outbox.js';
import { allocateId, registerEngineEntry } from '../../plugins/arima/scripts/src/notion/allocations.js';
import { stateTrace } from '../lib/graders.js';
import { RUN0, approveG2, day, readyAll, stubRoles, world } from './support.js';

const rich = (text: string) => ({ rich_text: [{ type: 'text', text: { content: text } }] });

describe('E-S5 milestone review and learning loop', () => {
  it('holds accepted stories for the review, opens veto rows, applies a veto and a lesson, closes after the window', async () => {
    const w = await world({ stories: 2 });
    stubRoles(w);
    await approveG2(w);
    await readyAll(w);
    const [s1, s2] = w.stories as [string, string];

    // /arima:plan: one milestone with both stories (the real planner and the real outbox)
    let out = '';
    expect(await runPlanCli(['--project', w.dir], { out: (s) => (out += s), err: () => undefined, cwd: w.dir })).toBe(0);
    expect(out).toContain('queued MS-01');
    await w.push();
    await w.pull();
    // the dual relation: the fake Notion does not mirror a milestone's Stories onto the stories' Milestone, a real one does (WP-216 live check)
    const msPage = w.fake.rowByTitle('Milestones', 'MS-01')!;
    for (const id of [s1, s2]) w.fake.humanEdit(w.fake.rowByTitle('Stories', id)!.id, { Milestone: { relation: [{ id: msPage.id }] } });
    await w.pull();

    // days pass: both stories are merged and reach PO Acceptance; neither becomes Done (held for the review)
    let n = 0;
    while (n < 30 && !(w.status(s1) === 'PO Acceptance' && w.status(s2) === 'PO Acceptance')) {
      n += 1;
      await day(w, n);
    }
    expect([w.status(s1), w.status(s2)]).toEqual(['PO Acceptance', 'PO Acceptance']);
    expect(readEvents(w.dir).some((e) => e.type === 'item.status' && e.data?.['to'] === 'Done')).toBe(false);

    // the next run opens the review: a Decisions row per accepted story, the milestone in Review
    n += 1;
    await day(w, n);
    await w.push();
    await w.pull();
    const reviewDay = n;
    expect(readReviews(w.dir)['MS-01']?.stories).toEqual([s1, s2]);
    expect(readEvents(w.dir).filter((e) => e.type === 'milestone.review_opened')).toHaveLength(1);
    const decs = (readMirror(w.dir, 'decisions')?.rows ?? []).filter((r) => String(r.properties['Summary']).startsWith('Accept US-'));
    expect(decs.map((r) => r.properties['Item']).sort()).toEqual([s1, s2]);
    expect(readMirror(w.dir, 'milestones')?.rows.find((r) => r.id === 'MS-01')?.properties['Status']).toBe('Review');
    expect([w.status(s1), w.status(s2)]).toEqual(['PO Acceptance', 'PO Acceptance']); // still held
    expect(existsSync(path.join(w.dir, '.arima', 'retro', 'MS-01.md'))).toBe(true);

    // the human vetoes story one with a reason, and approves a lesson a developer proposed
    const dec1 = decs.find((r) => r.properties['Item'] === s1)!;
    w.fake.humanEdit(w.fake.rowByTitle('Decisions', dec1.id)!.id, { Veto: { checkbox: true }, 'Veto reason': rich('Use banker rounding') });
    const les = await allocateId(w.dir, 'LES', RUN0);
    await registerEngineEntry(w.dir, `st-lesson-${les}`);
    enqueue(w.dir, {
      id: `st-lesson-${les}`,
      created_at: '2026-11-19T07:40:00.000Z',
      run_id: RUN0,
      role: 'orchestrator',
      op: 'create',
      database: 'lessons',
      properties: { ID: les, 'Proposed by': 'developer', Change: 'Write the empty-state test before the happy path.', Scope: 'project', Status: 'Proposed' },
    });
    await w.push();
    w.fake.humanEdit(w.fake.rowByTitle('Lessons', les)!.id, { Status: { select: { name: 'Approved' } } });
    await w.pull();

    // six hours later: the veto wins (BUG, story back In Progress), the lesson is applied, the developer's packet carries it, story two waits on
    const rec = path.join(path.dirname(w.dir), 'packet-record.json');
    await day(w, reviewDay + 0.25);
    await w.pull();
    expect(w.status(s1)).toBe('In Progress');
    expect(w.status(s2)).toBe('PO Acceptance');
    const bug = readMirror(w.dir, 'bugs')?.rows.find((b) => String(b.properties['Actual']).includes('Use banker rounding'));
    expect(bug?.properties['Status']).toBe('Open');
    // the dual relation again (a real Notion shows the bug on the story): the planner reworks a story with an open bug
    w.fake.humanEdit(w.fake.rowByTitle('Stories', s1)!.id, { Bugs: { relation: [{ id: w.fake.rowByTitle('Bugs', bug!.id)!.id }] } });
    await w.pull();
    expect(readFileSync(path.join(w.dir, '.arima', 'overrides', `${les}.md`), 'utf8')).toContain('role: developer');
    expect(readEvents(w.dir).some((e) => e.type === 'lesson.applied')).toBe(true);
    expect(readEvents(w.dir).some((e) => e.type === 'milestone.review_closed')).toBe(false);

    // the window passes: story two is accepted (Done), the milestone stays Active while story one is open
    await day(w, reviewDay + 1, { extraEnv: { STUB_MODE: 'by_unit', STUB_DIR: w.stub, STUB_RECORD: rec } });
    const prompt = (JSON.parse(readFileSync(rec, 'utf8')) as { stdin: string }).stdin;
    expect(prompt).toContain(`Project lesson ${les} (approved): Write the empty-state test before the happy path.`);
    await w.push();
    await w.pull();
    expect(w.status(s2)).toBe('Done');
    expect(w.status(s1)).not.toBe('Done');
    const closed = readEvents(w.dir).filter((e) => e.type === 'milestone.review_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.data).toMatchObject({ accepted: [s2], milestone_done: false });
    expect(readMirror(w.dir, 'milestones')?.rows.find((r) => r.id === 'MS-01')?.properties['Status']).toBe('Active');
    expect(stateTrace(readEvents(w.dir), s2, ['Ready', 'In Progress', 'In Review', 'In QA', 'PO Acceptance', 'Done'])).toEqual([]);
    expect(readFileSync(path.join(w.dir, '.arima', 'retro', 'MS-01.md'), 'utf8')).toContain('Retro inputs MS-01');
  }, 600_000);
});
