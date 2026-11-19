// WP-140: the inbox applies what a human did in Notion (spec 7.2 step 3, 12.2; F03 5.5).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkApprover } from '../src/approver.js';
import { appendEvent, readEvents } from '../src/events.js';
import { applyHumanInputs, cursorFile, readCursor } from '../src/inbox.js';
import type { InboxInput } from '../src/inbox.js';
import { ENGINE_STATUS_PREFIX, mirrorStatus } from '../src/item-status.js';
import type { ItemStatus } from '../src/item.js';
import { Throttle } from '../src/lib/throttle.js';
import { allocateId, registerEngineEntry } from '../src/notion/allocations.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { pullMirror } from '../src/notion/mirror.js';
import { enqueue, pushOutbox } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { raiseQuestions, readQuestions } from '../src/questions.js';
import { FakeNotion } from './fake-notion.js';
import { tempDir } from './helpers.js';

const RUN = 'r-20261119-2000-01';
const NOW = new Date('2026-11-19T20:00:00Z');
const team = {
  people: {
    me: { name: 'Me', notion_user: 'user-me' },
    client: { name: 'Client', notion_user: 'user-client', access: 'guest' },
    bot: { name: 'Bot', notion_user: 'user-bot' },
  },
  roles: {
    po: { type: 'human' as const, person: 'me' },
    sponsor: { type: 'human' as const, person: 'client' },
    legal: { type: 'human' as const, person: 'me' },
  },
};
const profile = {
  gates: {
    G1: { approvers: ['po' as const], require: 'all' as const },
    G3: { approvers: ['po' as const, 'sponsor' as const], require: 'all' as const },
  },
};

async function world(status: ItemStatus = 'PO Acceptance') {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  const dir = tempDir('arima-inbox-');
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
  const pull = () => pullMirror(dir, port, map);
  const push = () =>
    pushOutbox(dir, port, map, { allowStatusWrites: { idPrefix: ENGINE_STATUS_PREFIX } });
  const id = await allocateId(dir, 'US', RUN);
  await registerEngineEntry(dir, 'st-seed-1');
  await registerEngineEntry(dir, 'st-seed-2');
  enqueue(dir, {
    id: 'st-seed-1',
    created_at: '2026-11-19T10:00:00.000Z',
    run_id: RUN,
    role: 'orchestrator',
    op: 'create',
    database: 'stories',
    properties: { ID: id, Title: 'Cart', Status: status, Attempt: 1 },
  });
  enqueue(dir, {
    id: 'st-seed-2',
    created_at: '2026-11-19T10:00:01.000Z',
    run_id: RUN,
    role: 'orchestrator',
    op: 'create',
    database: 'gates',
    properties: { Gate: 'G1', Phase: 1, Status: 'Ready for review' },
  });
  await push();
  await pull();
  // the engine knows the story's status (a move in the log), as it does in real runs
  await appendEvent(dir, {
    type: 'item.status',
    actor: 'orchestrator',
    item: id,
    data: { from: 'In QA', to: status },
  });
  const input = (over: Partial<InboxInput> = {}): InboxInput => ({
    projectDir: dir,
    runId: RUN,
    team,
    profile,
    now: NOW,
    ...over,
  });
  return { fake, port, map, dir, pull, push, id, input };
}
type W = Awaited<ReturnType<typeof world>>;

const sel = (v: unknown): string | undefined =>
  (v as { select?: { name: string } } | undefined)?.select?.name;
const rich = (s: string) => ({ rich_text: [{ type: 'text', text: { content: s } }] });
const rowOf = (w: W, db: string, id: string) => w.fake.rowByTitle(db, id)!;
const decideGate = (w: W, status: string, by: { id: string }[]): void =>
  w.fake.humanEdit(rowOf(w, 'Gates', 'G1').id, {
    Status: { select: { name: status } },
    'Decided by': { people: by },
  });

describe('answers', () => {
  it('an answer in Notion answers the question and unblocks the story', async () => {
    const w = await world('In Progress');
    await raiseQuestions({
      projectDir: w.dir,
      runId: RUN,
      role: 'developer',
      item: w.id,
      policy: 'assume_and_log',
      now: NOW,
      questions: [
        {
          question: 'Which provider?',
          options: [{ label: 'Stripe', recommendation: true }],
          blocking: true,
        },
      ],
    });
    await w.push();
    await w.pull();
    w.fake.humanEdit(rowOf(w, 'Questions', 'Q-001').id, { Answer: rich('Stripe') });
    await w.pull();
    const r = await applyHumanInputs(w.input());
    expect(r.answered).toEqual(['Q-001']);
    expect(r.unblocked).toEqual([w.id]);
    await w.push();
    await w.pull();
    expect(mirrorStatus(w.dir, w.id)).toBe('In Progress');
    expect((await applyHumanInputs(w.input())).answered).toEqual([]);
  });
});

describe('vetoes', () => {
  const decide = async (w: W, item: string): Promise<void> => {
    await raiseQuestions({
      projectDir: w.dir,
      runId: RUN,
      role: 'developer',
      item,
      policy: 'assume_and_log',
      now: NOW,
      questions: [
        {
          question: 'Rounding mode?',
          options: [{ label: 'Half up', recommendation: true }],
          blocking: false,
          default: 'Half up',
        },
      ],
    });
    await w.push();
    await w.pull();
  };
  const veto = async (w: W, reason: string): Promise<void> => {
    w.fake.humanEdit(rowOf(w, 'Decisions', 'DEC-0001').id, {
      Veto: { checkbox: true },
      'Veto reason': rich(reason),
    });
    await w.pull();
  };

  it('a veto reopens a story waiting in PO Acceptance, with a BUG that carries the reason', async () => {
    const w = await world('PO Acceptance');
    await decide(w, w.id);
    await veto(w, 'Use banker rounding');
    const r = await applyHumanInputs(w.input());
    expect(r.vetoes).toEqual([{ decision: 'DEC-0001', bug: 'BUG-001', reopened: true }]);
    const ev = readEvents(w.dir);
    expect(ev.find((e) => e.type === 'decision.vetoed')).toMatchObject({
      actor: 'human',
      item: w.id,
      data: { decision: 'DEC-0001', reason: 'Use banker rounding' },
    });
    expect(ev.filter((e) => e.type === 'item.status').at(-1)).toMatchObject({
      actor: 'po',
      data: { from: 'PO Acceptance', to: 'In Progress' },
    });

    expect((await w.push()).rejected).toEqual([]);
    await w.pull();
    const bug = rowOf(w, 'Bugs', 'BUG-001');
    expect(JSON.stringify(bug.properties['Actual'])).toContain('Use banker rounding');
    expect(sel(bug.properties['Status'])).toBe('Open');
    expect(sel(bug.properties['Severity'])).toBe('S3');
    expect(JSON.stringify(bug.properties['Story'])).toContain(rowOf(w, 'Stories', w.id).id);
    expect(sel(rowOf(w, 'Stories', w.id).properties['Status'])).toBe('In Progress');
    // idempotent: the same veto is not applied twice
    expect((await applyHumanInputs(w.input())).vetoes).toEqual([]);
    expect(readEvents(w.dir).filter((e) => e.type === 'decision.vetoed')).toHaveLength(1);
  });

  it('a veto of a decision on a story in another state files the BUG but leaves the status alone', async () => {
    const w = await world('In QA');
    await decide(w, w.id);
    await veto(w, 'no');
    expect((await applyHumanInputs(w.input())).vetoes).toEqual([
      { decision: 'DEC-0001', bug: 'BUG-001', reopened: false },
    ]);
    expect(mirrorStatus(w.dir, w.id)).toBe('In QA');
  });

  it('a veto with no reason says so in the BUG, and one on a decision with no story only records the event', async () => {
    const w = await world('PO Acceptance');
    await decide(w, 'none');
    await veto(w, '');
    const r = await applyHumanInputs(w.input());
    expect(r.vetoes).toEqual([{ decision: 'DEC-0001', reopened: false }]);
    expect(readEvents(w.dir).some((e) => e.type === 'decision.vetoed')).toBe(true);
    const w2 = await world('PO Acceptance');
    await decide(w2, w2.id);
    await veto(w2, '');
    await applyHumanInputs(w2.input());
    await w2.push();
    await w2.pull();
    expect(JSON.stringify(rowOf(w2, 'Bugs', 'BUG-001').properties['Actual'])).toContain(
      'no reason given',
    );
  });
});

describe('gate decisions are checked by checkApprover', () => {
  it("a listed approver's decision is recorded as gate.decided", async () => {
    const w = await world();
    decideGate(w, 'Approved', [{ id: 'user-me' }]);
    await w.pull();
    const r = await applyHumanInputs(w.input());
    expect(r.gates).toEqual([{ gate: 'G1', status: 'Approved', ok: true }]);
    expect(readEvents(w.dir).find((e) => e.type === 'gate.decided')).toMatchObject({
      actor: 'human',
      data: { gate: 'G1', status: 'Approved', approver_check: { method: 'placeholder', ok: true } },
    });
    expect((await applyHumanInputs(w.input())).gates).toEqual([]); // idempotent
    expect(readEvents(w.dir).filter((e) => e.type === 'gate.decided')).toHaveLength(1);
  });

  it('someone who is not a listed approver is ignored, logged, and one blocking hard-stop question is raised; nothing is reverted', async () => {
    const w = await world();
    decideGate(w, 'Approved', [{ id: 'user-bot' }]);
    await w.pull();
    const r = await applyHumanInputs(w.input());
    expect(r.gates).toEqual([{ gate: 'G1', status: 'Approved', ok: false }]);
    expect(readEvents(w.dir).some((e) => e.type === 'gate.decided')).toBe(false);
    expect(readEvents(w.dir).find((e) => e.type === 'notion.refused')).toMatchObject({
      data: { gate: 'G1' },
    });
    expect(readQuestions(w.dir)['Q-001']).toMatchObject({
      blocking: true,
      hard_stop: 'G1',
      route: 'owner',
    });
    expect(sel(rowOf(w, 'Gates', 'G1').properties['Status'])).toBe('Approved'); // the human edit stays
    expect((await applyHumanInputs(w.input())).gates).toEqual([]);
    expect(Object.keys(readQuestions(w.dir))).toEqual(['Q-001']); // one question, not one per run
  });

  it('a Rejected decision and a changed decision are each applied once', async () => {
    const w = await world();
    decideGate(w, 'Rejected', [{ id: 'user-me' }]);
    await w.pull();
    expect((await applyHumanInputs(w.input())).gates[0]).toMatchObject({
      status: 'Rejected',
      ok: true,
    });
    decideGate(w, 'Approved with conditions', [{ id: 'user-me' }]);
    await w.pull();
    expect((await applyHumanInputs(w.input())).gates[0]).toMatchObject({
      status: 'Approved with conditions',
      ok: true,
    });
    expect(readEvents(w.dir).filter((e) => e.type === 'gate.decided')).toHaveLength(2);
  });

  it('a gate nobody decided is left alone; a gate with no decider is not approved', async () => {
    const w = await world();
    expect((await applyHumanInputs(w.input())).gates).toEqual([]);
    decideGate(w, 'Approved', []);
    await w.pull();
    expect((await applyHumanInputs(w.input())).gates[0]?.ok).toBe(false);
  });
});

describe('Status edits and priorities', () => {
  it('a human Status edit of a story is adopted (the human wins) and logged', async () => {
    const w = await world('In Progress');
    w.fake.humanEdit(rowOf(w, 'Stories', w.id).id, { Status: { select: { name: 'Cancelled' } } });
    await w.pull();
    const r = await applyHumanInputs(w.input());
    expect(r.statusEdits).toEqual([{ item: w.id, from: 'In Progress', to: 'Cancelled' }]);
    expect((await applyHumanInputs(w.input())).statusEdits).toEqual([]);
  });
});

describe('the cursor', () => {
  it('is validated, kept under state/, and a corrupt one is refused', async () => {
    const w = await world();
    decideGate(w, 'Approved', [{ id: 'user-me' }]);
    await w.pull();
    await applyHumanInputs(w.input());
    expect(JSON.parse(readFileSync(cursorFile(w.dir), 'utf8'))).toMatchObject({
      schema_version: 1,
      processed: { gates: { G1: expect.stringMatching(/^[0-9a-f]{16}$/) } },
    });
    writeFileSync(cursorFile(w.dir), '{"schema_version":1,"processed":{"gates":{"G1":"nope"}}}');
    expect(() => readCursor(w.dir)).toThrow(/Corrupt/);
  });
});

describe('checkApprover (the one seam, D-40)', () => {
  const g = (decidedBy: { id?: string; name?: string }[], gate: 'G1' | 'G3' = 'G1') =>
    checkApprover({ gate, decidedBy, team, profile });
  it('accepts only people who fill an approver role of that gate', () => {
    expect(g([{ id: 'user-me' }])).toEqual({ method: 'placeholder', approvers: ['Me'], ok: true });
    expect(g([{ id: 'user-client' }]).ok).toBe(false);
    expect(g([{ id: 'user-client' }], 'G3')).toMatchObject({
      ok: true,
      approvers: ['Me', 'Client'],
    });
    expect(g([{ name: 'Me' }]).ok).toBe(true);
    expect(g([{ id: 'user-bot' }, { id: 'user-me' }]).ok).toBe(true);
  });
  it('refuses nobody, strangers, and a gate the profile does not enforce', () => {
    expect(g([]).ok).toBe(false);
    expect(g([{ id: 'x' }]).ok).toBe(false);
    expect(
      checkApprover({ gate: 'G2', decidedBy: [{ id: 'user-me' }], team, profile }),
    ).toMatchObject({ ok: false, approvers: [] });
  });
});
