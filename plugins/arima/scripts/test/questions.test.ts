// WP-141: the question and decision protocol (spec 7.5, 12.1; F04 5.3; owner principles 09 section 1).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { HARD_STOPS } from '../src/hardstops.js';
import { readItem } from '../src/item.js';
import type { ItemStatus } from '../src/item.js';
import { ENGINE_STATUS_PREFIX, mirrorStatus } from '../src/item-status.js';
import type { Role } from '../src/ledger.js';
import { Throttle } from '../src/lib/throttle.js';
import { allocateId, registerEngineEntry } from '../src/notion/allocations.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { pullMirror } from '../src/notion/mirror.js';
import { enqueue, pushOutbox } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import {
  MAX_QUESTIONS_PER_DIGEST,
  answerConsult,
  applyAnswers,
  decisionsToVeto,
  digestQuestions,
  expireQuestions,
  pendingConsults,
  questionsFile,
  raiseQuestions,
  readQuestions,
} from '../src/questions.js';
import type { QuestionPolicy, RaiseInput } from '../src/questions.js';
import { FakeNotion } from './fake-notion.js';
import { tempDir } from './helpers.js';

const RUN = 'r-20261119-1900-01';
const NOW = new Date('2026-11-19T19:00:00Z');
const ALLOW = { allowStatusWrites: { idPrefix: ENGINE_STATUS_PREFIX } };

async function world(status: ItemStatus = 'In Progress') {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  const dir = tempDir('arima-questions-');
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
  const pull = () => pullMirror(dir, port, map);
  const push = () => pushOutbox(dir, port, map, ALLOW);
  const id = await allocateId(dir, 'US', RUN);
  await registerEngineEntry(dir, 'st-seed-1');
  enqueue(dir, {
    id: 'st-seed-1',
    created_at: '2026-11-19T10:00:00.000Z',
    run_id: RUN,
    role: 'orchestrator',
    op: 'create',
    database: 'stories',
    properties: { ID: id, Title: 'Cart', Status: status, Attempt: 1 },
  });
  await push();
  await pull();
  return { fake, port, map, dir, pull, push, id };
}
type W = Awaited<ReturnType<typeof world>>;

const q = (over: Record<string, unknown> = {}) => ({
  question: 'Which payment provider?',
  options: [
    { label: 'Stripe', recommendation: true },
    { label: 'Mollie', recommendation: false },
  ],
  blocking: true,
  ...over,
});
const raise = (w: W, questions: unknown[], over: Partial<RaiseInput> = {}) =>
  raiseQuestions({
    projectDir: w.dir,
    runId: RUN,
    role: 'developer' as Role,
    item: w.id,
    questions: questions as never,
    policy: 'assume_and_log' as QuestionPolicy,
    now: NOW,
    ...over,
  });
const sel = (v: unknown): string | undefined =>
  (v as { select?: { name: string } } | undefined)?.select?.name;
const answer = (w: W, qid: string, text: string): void =>
  w.fake.humanEdit(w.fake.rowByTitle('Questions', qid)!.id, {
    Answer: { rich_text: [{ type: 'text', text: { content: text } }] },
  });

describe('consult routing: a question addressed to a role never reaches the owner', () => {
  it('is recorded for that role, blocks nothing and is not in the digest; the role answers it', async () => {
    const w = await world();
    const [r] = await raise(w, [q({ addressed_to: 'architect', blocking: true })]);
    expect(r).toMatchObject({ id: 'Q-001', route: 'consult', blocking: false, blockedItem: false });
    expect(mirrorStatus(w.dir, w.id)).toBe('In Progress');
    expect(digestQuestions(w.dir).shown).toEqual([]);
    expect(pendingConsults(w.dir, 'architect').map((c) => c.id)).toEqual(['Q-001']);
    expect(pendingConsults(w.dir, 'qa')).toEqual([]);
    expect((await w.push()).applied).toEqual([]); // no Questions row, no DEC
    expect(w.fake.rowByTitle('Questions', 'Q-001')).toBeUndefined();

    await expect(answerConsult(w.dir, 'Q-001', 'qa', 'x')).rejects.toThrow(
      /addressed to architect/,
    );
    await answerConsult(w.dir, 'Q-001', 'architect', 'Yes, GET /cart/summary is in the spec.');
    expect(readQuestions(w.dir)['Q-001']).toMatchObject({
      status: 'answered',
      answered_by: 'architect',
    });
    expect(pendingConsults(w.dir)).toEqual([]);
    await expect(answerConsult(w.dir, 'Q-001', 'architect', 'again')).rejects.toThrow(
      /already answered/,
    );
    expect(readEvents(w.dir).filter((e) => e.type === 'question.answered')).toHaveLength(1);
  });
});

describe('a blocking question moves the story to Blocked and an answer unblocks it', () => {
  it("blocks, shows in Notion, and the owner's answer returns the story to where it was", async () => {
    const w = await world();
    const [r] = await raise(w, [q()]);
    expect(r).toMatchObject({ id: 'Q-001', route: 'owner', blocking: true, blockedItem: true });
    expect(readItem(w.dir, w.id)).toMatchObject({
      blocked_from: 'In Progress',
      blocked_reason: expect.stringContaining('Q-001'),
    });
    expect(readEvents(w.dir).find((e) => e.type === 'question.raised')).toMatchObject({
      item: w.id,
      data: { question: 'Q-001', blocking: true },
    });

    expect((await w.push()).rejected).toEqual([]);
    await w.pull();
    expect(sel(w.fake.rowByTitle('Stories', w.id)!.properties['Status'])).toBe('Blocked');
    const row = w.fake.rowByTitle('Questions', 'Q-001')!;
    expect(sel(row.properties['Status'])).toBe('Open');
    expect(row.properties['Blocking']).toMatchObject({ checkbox: true });
    expect(JSON.stringify(row.properties['Recommendation'])).toContain('Stripe');

    expect(await applyAnswers({ projectDir: w.dir, runId: RUN, now: NOW })).toEqual({
      answered: [],
      unblocked: [],
    }); // nothing answered yet
    answer(w, 'Q-001', 'Stripe, please');
    await w.pull();
    const done = await applyAnswers({ projectDir: w.dir, runId: RUN, now: NOW });
    expect(done).toEqual({ answered: ['Q-001'], unblocked: [w.id] });
    expect(readQuestions(w.dir)['Q-001']).toMatchObject({
      status: 'answered',
      answer: 'Stripe, please',
    });
    expect(
      readEvents(w.dir).some((e) => e.type === 'question.answered' && e.actor === 'human'),
    ).toBe(true);
    await w.push();
    await w.pull();
    expect(sel(w.fake.rowByTitle('Stories', w.id)!.properties['Status'])).toBe('In Progress');
    expect(sel(w.fake.rowByTitle('Questions', 'Q-001')!.properties['Status'])).toBe('Answered');
    expect(readItem(w.dir, w.id).blocked_from).toBeNull();
    expect(await applyAnswers({ projectDir: w.dir, runId: RUN, now: NOW })).toEqual({
      answered: [],
      unblocked: [],
    }); // idempotent
  });

  it('with two blocking questions the story stays Blocked until both are answered', async () => {
    const w = await world();
    await raise(w, [q({ question: 'A?' }), q({ question: 'B?' })]);
    await w.push();
    await w.pull();
    answer(w, 'Q-001', 'a');
    await w.pull();
    expect(await applyAnswers({ projectDir: w.dir, runId: RUN, now: NOW })).toEqual({
      answered: ['Q-001'],
      unblocked: [],
    });
    await w.push();
    await w.pull();
    expect(mirrorStatus(w.dir, w.id)).toBe('Blocked');
    answer(w, 'Q-002', 'b');
    await w.pull();
    expect((await applyAnswers({ projectDir: w.dir, runId: RUN, now: NOW })).unblocked).toEqual([
      w.id,
    ]);
  });

  it('a story that cannot return to a spending state without budget stays Blocked', async () => {
    const w = await world();
    await raise(w, [q()]);
    await w.push();
    await w.pull();
    answer(w, 'Q-001', 'x');
    await w.pull();
    expect(
      await applyAnswers({ projectDir: w.dir, runId: RUN, now: NOW, budgetAvailable: () => false }),
    ).toEqual({ answered: ['Q-001'], unblocked: [] });
  });

  it('a question about something that is not a story is recorded and asked, but blocks no story', async () => {
    const w = await world();
    const [r] = await raise(w, [q({ item: 'BUG-001' })]);
    expect(r).toMatchObject({ blocking: true, blockedItem: false });
    expect(mirrorStatus(w.dir, w.id)).toBe('In Progress');
  });
});

describe('assume-and-log: a non-blocking question becomes a DEC with a veto box', () => {
  it('the story carries on with the recommendation; the DEC row exists; it shows in the digest until vetoed', async () => {
    const w = await world();
    const [r] = await raise(w, [
      q({ blocking: false, default: 'Stripe', question: 'Rounding mode?' }),
    ]);
    expect(r).toMatchObject({
      route: 'owner',
      blocking: false,
      decision: 'DEC-0001',
      blockedItem: false,
    });
    expect(mirrorStatus(w.dir, w.id)).toBe('In Progress');
    expect(readEvents(w.dir).find((e) => e.type === 'decision.made')).toMatchObject({
      data: { decision: 'DEC-0001', question: 'Q-001', chosen: 'Stripe', assumed: true },
    });
    expect((await w.push()).rejected).toEqual([]);
    await w.pull();
    const dec = w.fake.rowByTitle('Decisions', 'DEC-0001')!;
    expect(JSON.stringify(dec.properties['Chosen'])).toContain('Stripe');
    expect(dec.properties['Reversible']).toMatchObject({ checkbox: true });
    expect(decisionsToVeto(w.dir).map((d) => d.id)).toEqual(['DEC-0001']);
    expect(decisionsToVeto(w.dir, { sinceDate: '2026-11-20' })).toEqual([]);
    w.fake.humanEdit(dec.id, { Veto: { checkbox: true } });
    await w.pull();
    expect(decisionsToVeto(w.dir)).toEqual([]);
  });

  it('without a default the recommended option is the assumption', async () => {
    const w = await world();
    await raise(w, [q({ blocking: false })]);
    expect(readQuestions(w.dir)['Q-001']?.default).toBe('Stripe');
  });

  it('under block_story every question blocks and none is assumed', async () => {
    const w = await world();
    const [r] = await raise(w, [q({ blocking: false, default: 'Stripe' })], {
      policy: 'block_story',
    });
    expect(r).toMatchObject({ blocking: true, blockedItem: true });
    expect(r?.decision).toBeUndefined();
    expect(readEvents(w.dir).some((e) => e.type === 'decision.made')).toBe(false);
  });
});

describe('a hard-stop matter is never assumed', () => {
  it('whatever the agent says, every one of the 16 ids is forced blocking and loses its default', async () => {
    for (const hard of HARD_STOPS) {
      const w = await world();
      const [r] = await raise(w, [q({ hard_stop: hard, blocking: false, default: 'Stripe' })]);
      expect(r, hard).toMatchObject({ blocking: true, hardStop: hard, blockedItem: true });
      expect(r?.decision, hard).toBeUndefined();
      expect(readQuestions(w.dir)['Q-001'], hard).toMatchObject({
        blocking: true,
        hard_stop: hard,
      });
      expect(readQuestions(w.dir)['Q-001']?.default, hard).toBeUndefined();
      expect(
        readEvents(w.dir).some((e) => e.type === 'decision.made'),
        hard,
      ).toBe(false);
      await w.push();
      const row = w.fake.rowByTitle('Questions', 'Q-001')!;
      expect(
        row.properties['Default'] === undefined ||
          JSON.stringify(row.properties['Default']).includes('"rich_text":[]'),
        hard,
      ).toBe(true);
      expect(JSON.stringify(row.properties['Question'])).toContain(`[hard stop: ${hard}]`);
    }
  }, 60_000);

  it('an engine detector forces it too, under the lenient policy, with no hard_stop field set by the agent', async () => {
    const w = await world();
    const [r] = await raise(w, [q({ blocking: false, default: 'Stripe' })], {
      engineHardStop: 'missing_credential',
    });
    expect(r).toMatchObject({ blocking: true, hardStop: 'missing_credential' });
    expect(readQuestions(w.dir)['Q-001']?.default).toBeUndefined();
  });

  it('an unknown hard-stop id is refused', async () => {
    const w = await world();
    await expect(raise(w, [q({ hard_stop: 'everything' })])).rejects.toThrow(/not a hard-stop id/);
  });
});

describe('batching: at most 10 per digest, highest impact first', () => {
  it('blocking before non-blocking, hard stops first among them, then oldest; the rest are counted', async () => {
    const w = await world();
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    await raise(w, [q({ blocking: false, question: 'n1', topic: 'ui' })], { now: at(1) });
    await raise(w, [q({ question: 'b1', topic: 'api' })], { now: at(2) });
    await raise(w, [q({ question: 'h1', topic: 'money', hard_stop: 'new_paid_service' })], {
      now: at(3),
    });
    await raise(w, [q({ question: 'b2', topic: 'api' })], { now: at(4) });
    for (let i = 0; i < 9; i++)
      await raise(w, [q({ blocking: false, question: `m${i}`, topic: 'misc' })], {
        now: at(10 + i),
      });
    const d = digestQuestions(w.dir);
    expect(d.shown).toHaveLength(MAX_QUESTIONS_PER_DIGEST);
    expect(d.more).toBe(3);
    expect(d.shown.slice(0, 3).map((x) => x.question)).toEqual(['h1', 'b1', 'b2']);
    expect(d.shown[3]?.question).toBe('n1');
    expect(d.byTopic.get('api')?.map((x) => x.question)).toEqual(['b1', 'b2']);
    expect(digestQuestions(w.dir, { max: 2 }).more).toBe(11);
    expect(MAX_QUESTIONS_PER_DIGEST).toBe(10);
  });

  it('answered, expired and consult questions are not shown', async () => {
    const w = await world();
    await raise(w, [q({ addressed_to: 'architect' }), q({ question: 'owner?' })]);
    expect(digestQuestions(w.dir).shown.map((x) => x.question)).toEqual(['owner?']);
  });
});

describe('expiry (RD-F04-6)', () => {
  it('a blocking non-hard-stop question takes its default with a DEC and unblocks; a hard stop stays and is escalated once; a non-blocking one is flagged', async () => {
    const w = await world();
    await raise(w, [q({ expires: '2026-11-18', default: 'Stripe', question: 'blocking?' })], {
      item: w.id,
    });
    await raise(w, [
      q({ expires: '2026-11-18', hard_stop: 'licence', question: 'licence?', item: 'BUG-009' }),
    ]);
    await raise(w, [
      q({ expires: '2026-11-18', blocking: false, question: 'minor?', item: 'BUG-010' }),
    ]);
    await raise(w, [q({ expires: '2026-12-01', question: 'later?', item: 'BUG-011' })]);
    await w.push();
    await w.pull();
    const e = await expireQuestions({ projectDir: w.dir, runId: RUN, now: NOW });
    expect(e.tookDefault).toEqual([
      { id: 'Q-001', decision: expect.stringMatching(/^DEC-/), unblocked: true },
    ]);
    expect(e.escalated).toEqual(['Q-002']);
    expect(e.flagged).toEqual(['Q-003']);
    expect(readQuestions(w.dir)['Q-001']).toMatchObject({ status: 'expired' });
    expect(readQuestions(w.dir)['Q-002']).toMatchObject({ status: 'open', escalated: true });
    expect(
      readEvents(w.dir).find((x) => x.type === 'hardstop.hit' && x.data?.['escalated'] === true),
    ).toMatchObject({ data: { stop: 'licence', question: 'Q-002' } });
    const again = await expireQuestions({ projectDir: w.dir, runId: RUN, now: NOW });
    expect(again.tookDefault).toEqual([]);
    expect(again.escalated).toEqual([]); // once only
    expect(again.flagged).toEqual(['Q-003']);
    expect(digestQuestions(w.dir, { now: NOW }).shown.find((x) => x.id === 'Q-003')?.expired).toBe(
      true,
    );
  });
});

describe('placeholders and state', () => {
  it('a question may mention NEW-n placeholders of the same report', async () => {
    const w = await world();
    await raise(w, [q({ question: 'Is guest checkout in scope for NEW-2?' })], {
      placeholders: { 'NEW-2': 'US-077' },
    });
    expect(readQuestions(w.dir)['Q-001']?.question).toBe('Is guest checkout in scope for US-077?');
  });

  it('the state file validates and a corrupt one is refused, never reset', async () => {
    const w = await world();
    await raise(w, [q()]);
    const f = questionsFile(w.dir);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ schema_version: 1 });
    writeFileSync(f, '{"schema_version":1,"questions":{"Q-001":{"raised_by":"nobody"}}}');
    expect(() => readQuestions(w.dir)).toThrow(/Corrupt/);
  });

  it('the engine, not the agent, issues the ids, and the rows are engine entries (Status allowed)', async () => {
    const w = await world();
    await raise(w, [q()]);
    expect((await pushOutbox(w.dir, w.port, w.map)).rejected.length).toBeGreaterThan(0); // without the engine opt-in, Status is refused
  });
});
