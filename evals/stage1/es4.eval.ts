// E-S4 human edits win (spec 3.3, 7.1, F10 5.3, WP-150). Part one: an agent's update meets a human's edit
// of the same property; the human's value stays in Notion and the mirror, and the clash is recorded.
// Part two: a story waiting in PO Acceptance receives a human veto with a reason; the next run reopens it
// with a BUG that carries the reason, and the auto-acceptance does not override the veto.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../../plugins/arima/scripts/src/events.js';
import { readMirror } from '../../plugins/arima/scripts/src/notion/mirror.js';
import { readNotionMap } from '../../plugins/arima/scripts/src/notion/mirror.js';
import { enqueue, outboxDir, pushOutbox } from '../../plugins/arima/scripts/src/notion/outbox.js';
import { raiseQuestions } from '../../plugins/arima/scripts/src/questions.js';
import { stateTrace } from '../lib/graders.js';
import { RUN0, approveG2, day, readyAll, stubRoles, world } from './support.js';

const rich = (text: string) => ({ rich_text: [{ type: 'text', text: { content: text } }] });

describe('E-S4 human edits win', () => {
  it('part one: an agent update that meets a human edit of the same property is a conflict; the human value stays and nothing is lost', async () => {
    const w = await world({ stories: 1 });
    await approveG2(w);
    const id = w.stories[0] as string;
    const row = w.fake.rowByTitle('Stories', id)!;
    const seenByAgent = row.last_edited_time;

    // the human edits the title after the agent last looked
    w.fake.humanEdit(row.id, { Title: rich('Edited by the human') });
    enqueue(w.dir, {
      id: 'agent-title-1',
      created_at: '2026-11-19T10:00:00.000Z',
      run_id: RUN0,
      role: 'orchestrator',
      op: 'update',
      database: 'stories',
      item_id: id,
      base_last_edited: seenByAgent,
      properties: { Title: 'Agent rewrite' },
    });
    const r = await pushOutbox(w.dir, w.port, readNotionMap(w.dir), {});
    expect(r.conflicts).toEqual(['agent-title-1']);
    expect(r.applied).toEqual([]);
    expect(w.fake.text(w.fake.rowByTitle('Stories', id)!, 'Title')).toBe('Edited by the human');
    await w.pull();
    expect(readMirror(w.dir, 'stories')?.rows.find((x) => x.id === id)?.properties['Title']).toBe('Edited by the human');
    expect(existsSync(path.join(outboxDir(w.dir), 'conflicts', 'agent-title-1.json'))).toBe(true);
    expect(readEvents(w.dir).filter((e) => e.type === 'notion.conflict')[0]?.data).toMatchObject({ entry: 'agent-title-1', database: 'stories' });
    // negative control: an update that did not meet an edit is applied
    enqueue(w.dir, {
      id: 'agent-title-2',
      created_at: '2026-11-19T10:01:00.000Z',
      run_id: RUN0,
      role: 'orchestrator',
      op: 'update',
      database: 'stories',
      item_id: id,
      properties: { Priority: 5 },
    });
    const ok = await pushOutbox(w.dir, w.port, readNotionMap(w.dir), {});
    expect(ok.applied).toEqual(['agent-title-2']);
  }, 120_000);

  it('part two: a veto of a story in PO Acceptance reopens it with a BUG carrying the reason, and auto-acceptance does not undo it', async () => {
    const w = await world({ stories: 1 });
    stubRoles(w);
    await approveG2(w);
    await readyAll(w);
    const id = w.stories[0] as string;
    let days = 0;
    while (days < 20 && w.status(id) !== 'PO Acceptance') {
      days += 1;
      await day(w, days);
    }
    expect(w.status(id)).toBe('PO Acceptance'); // merged, waiting for the next run to accept

    // an assume-and-log decision was made on the owner's behalf for this story; the human vetoes it
    await raiseQuestions({
      projectDir: w.dir,
      runId: RUN0,
      role: 'developer',
      item: id,
      policy: 'assume_and_log',
      now: new Date('2026-11-19T09:00:00Z'),
      questions: [{ question: 'Rounding mode?', options: [{ label: 'Half up', recommendation: true }], blocking: false, default: 'Half up' }],
    });
    await w.push();
    await w.pull();
    const dec = w.fake.rowByTitle('Decisions', 'DEC-0001')!;
    w.fake.humanEdit(dec.id, { Veto: { checkbox: true }, 'Veto reason': rich('Use banker rounding') });
    await w.pull();

    await day(w, days + 1);
    // the veto won: the story is back In Progress (it was not accepted), with a BUG that has the reason
    expect(w.status(id)).toBe('In Progress');
    const events = readEvents(w.dir);
    expect(events.some((e) => e.type === 'decision.vetoed')).toBe(true);
    expect(stateTrace(events, id, ['Ready', 'In Progress', 'In Review', 'In QA', 'PO Acceptance', 'In Progress']).filter((p) => !p.includes('path'))).toEqual([]);
    await w.pull();
    const bug = readMirror(w.dir, 'bugs')?.rows.find((b) => String(b.properties['Actual']).includes('Use banker rounding'));
    expect(bug).toBeDefined();
    expect(bug?.properties['Status']).toBe('Open');
    // the rework continues: the story gets a developer unit again, it is not stuck
    await day(w, days + 2);
    expect(readdirSync(path.join(w.dir, '.arima')).length).toBeGreaterThan(0);
    expect(w.status(id)).not.toBe('Done');
  }, 240_000);
});
