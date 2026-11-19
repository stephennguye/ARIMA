// WP-108: the engine owns Status (spec 7.1, 9.3). Agents cannot write it; the state machine's
// accepted moves are the only engine writes; a human's edit in Notion wins and is adopted.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import {
  ENGINE_STATUS_PREFIX,
  mirrorStatus,
  moveItem,
  reconcileStatuses,
} from '../src/item-status.js';
import { readItem } from '../src/item.js';
import type { ItemStatus } from '../src/item.js';
import { Throttle } from '../src/lib/throttle.js';
import { allocateId, isEngineEntry, registerEngineEntry } from '../src/notion/allocations.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { pullMirror } from '../src/notion/mirror.js';
import { enqueue, outboxDir, pushOutbox } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import type { Facts, Guard } from '../src/state-machine.js';
import { FakeNotion } from './fake-notion.js';
import { tempDir } from './helpers.js';

const RUN = 'r-20261119-1100-01';
const ALLOW = { allowStatusWrites: { idPrefix: ENGINE_STATUS_PREFIX } };

async function world() {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  const dir = tempDir('arima-status-');
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
  const pull = () => pullMirror(dir, port, map);
  const push = (opts = ALLOW) => pushOutbox(dir, port, map, opts);
  // seed US-001 in Backlog the way the engine does
  const id = await allocateId(dir, 'US', RUN);
  await registerEngineEntry(dir, 'st-seed-1');
  enqueue(dir, {
    id: 'st-seed-1',
    created_at: '2026-11-19T11:00:00.000Z',
    run_id: RUN,
    role: 'orchestrator',
    op: 'create',
    database: 'stories',
    properties: { ID: id, Title: 'Cart summary', Status: 'Backlog', Attempt: 1 },
  });
  await push();
  await pull();
  return { fake, port, map, dir, pull, push, id };
}

const facts = (names: Guard[], more: Partial<Facts> = {}): Facts => ({
  guards: Object.fromEntries(names.map((g) => [g, true])),
  budget_available: true,
  ...more,
});
const status = (w: Awaited<ReturnType<typeof world>>): unknown =>
  w.fake.rowByTitle('Stories', w.id)?.properties['Status'];
const selected = (v: unknown): string | undefined =>
  (v as { select?: { name: string } } | undefined)?.select?.name;

describe('an agent cannot write Status, whatever the file is called', () => {
  it('refuses Status from an agent entry, also named like an engine entry, even when the engine opt-in is on', async () => {
    const w = await world();
    for (const [n, name] of [
      ['a', 'ob-1'],
      ['b', 'st-forged-1'],
      ['c', 'init-forged-1'],
    ] as const) {
      enqueue(w.dir, {
        id: name,
        created_at: `2026-11-19T11:01:0${n === 'a' ? 1 : n === 'b' ? 2 : 3}.000Z`,
        run_id: RUN,
        role: 'orchestrator',
        op: 'update',
        database: 'stories',
        item_id: w.id,
        properties: { Status: 'Done' },
      });
    }
    const r = await w.push({ allowStatusWrites: { idPrefix: 'st-' } });
    const r2 = await pushOutbox(w.dir, w.port, w.map, { allowStatusWrites: { idPrefix: 'init-' } });
    expect(r.applied).toEqual([]);
    expect([...r.rejected, ...r2.rejected].map((x) => x.id).sort()).toEqual(
      ['ob-1', 'st-forged-1', 'init-forged-1'].sort(),
    );
    expect(r.rejected[0]?.reason).toMatch(/"Status".*except by the engine/);
    expect(selected(status(w))).toBe('Backlog');
  });

  it('only engine-registered entries are engine entries', async () => {
    const dir = tempDir();
    expect(isEngineEntry(dir, 'st-x')).toBe(false);
    await registerEngineEntry(dir, 'st-x');
    await registerEngineEntry(dir, 'st-x');
    expect(isEngineEntry(dir, 'st-x')).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(dir, '.arima', 'state', 'engine-entries.json'), 'utf8')),
    ).toEqual(['st-x']);
  });
});

describe('moveItem: an accepted move is applied and logged as item.status', () => {
  it('Backlog -> Ready: counters, event, an engine entry, and Notion shows the new Status after push', async () => {
    const w = await world();
    expect(mirrorStatus(w.dir, w.id)).toBe('Backlog');
    const r = await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'Ready',
      actor: 'ba',
      facts: facts(['dor_met', 'priority_set']),
      runId: RUN,
      now: new Date('2026-11-19T11:05:00Z'),
    });
    expect(r).toMatchObject({ ok: true, applied: { next: { status: 'Ready' } } });
    const ev = readEvents(w.dir).filter((e) => e.type === 'item.status');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      actor: 'ba',
      item: w.id,
      run_id: RUN,
      data: { from: 'Backlog', to: 'Ready', attempt: 1 },
    });
    expect(readItem(w.dir, w.id)).toMatchObject({ attempt: 1, run_failures: 0 });

    const pushed = await w.push();
    expect(pushed.rejected).toEqual([]);
    expect(pushed.applied).toHaveLength(1);
    expect(selected(status(w))).toBe('Ready');
    // the push without the engine opt-in would have refused it
    expect(existsSync(path.join(outboxDir(w.dir), 'applied'))).toBe(true);
  });

  it('a refused move changes nothing: no counters, no event, no entry', async () => {
    const w = await world();
    const r = await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'Ready',
      actor: 'ba',
      facts: facts(['dor_met']),
      runId: RUN,
    });
    expect(r).toMatchObject({ ok: false, code: 'guard_failed', failed: ['priority_set'] });
    expect(readEvents(w.dir).filter((e) => e.type === 'item.status')).toEqual([]);
    expect(existsSync(path.join(w.dir, '.arima', 'items', `${w.id}.json`))).toBe(false);
    expect(readdirSync(outboxDir(w.dir)).filter((f) => f.endsWith('.json'))).toEqual([]);
    const wrongActor = await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'Ready',
      actor: 'developer',
      facts: facts(['dor_met', 'priority_set']),
      runId: RUN,
    });
    expect(wrongActor).toMatchObject({ ok: false, code: 'actor_not_allowed' });
  });

  it('unknown items and non-story ids are refused', async () => {
    const w = await world();
    expect(
      await moveItem({
        projectDir: w.dir,
        item: 'US-999',
        to: 'Ready',
        actor: 'ba',
        facts: facts([]),
        runId: RUN,
      }),
    ).toMatchObject({ ok: false, code: 'unknown_item' });
    expect(
      await moveItem({
        projectDir: w.dir,
        item: 'BUG-001',
        to: 'Ready',
        actor: 'ba',
        facts: facts([]),
        runId: RUN,
      }),
    ).toMatchObject({ ok: false, code: 'unknown_item' });
  });

  it('the third failed review blocks the story in Notion, with the reason and a question due', async () => {
    const w = await world();
    const go = async (
      to: ItemStatus,
      actor: 'ba' | 'orchestrator' | 'developer' | 'tech-lead',
      g: Guard[],
    ) => {
      const r = await moveItem({
        projectDir: w.dir,
        item: w.id,
        to,
        actor,
        facts: facts(g),
        runId: RUN,
        now: new Date('2026-11-19T11:10:00Z'),
      });
      if (!r.ok) throw new Error(r.message);
      await w.push();
      await w.pull();
      return r;
    };
    await go('Ready', 'ba', ['dor_met', 'priority_set']);
    await go('In Progress', 'orchestrator', [
      'test_cases_exist',
      'story_budget_available',
      'wip_ok',
    ]);
    let last;
    for (let k = 0; k < 3; k++) {
      await go('In Review', 'developer', ['pr_open', 'ci_green', 'criteria_mapped']);
      last = await go('In Progress', 'tech-lead', ['changes_requested']);
    }
    expect(last).toMatchObject({
      ok: true,
      applied: { redirected: true, question: { reason: 'attempt_limit' } },
    });
    expect(selected(status(w))).toBe('Blocked');
    expect(readItem(w.dir, w.id)).toMatchObject({ attempt: 4, blocked_from: 'In Review' });
    const props = w.fake.rowByTitle('Stories', w.id)!.properties;
    expect(JSON.stringify(props['Blocked reason'])).toContain('failed review or QA 3 times');
    expect(props['Attempt']).toMatchObject({ number: 4 });
  });
});

describe('reconcileStatuses: a human edit in Notion wins', () => {
  const humanSets = (w: Awaited<ReturnType<typeof world>>, name: string): void =>
    w.fake.humanEdit(w.fake.rowByTitle('Stories', w.id)!.id, { Status: { select: { name } } });

  it('adopts a human Status change, logs it as the human, and does not repeat', async () => {
    const w = await world();
    await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'Ready',
      actor: 'ba',
      facts: facts(['dor_met', 'priority_set']),
      runId: RUN,
    });
    await w.push();
    await w.pull();
    expect(await reconcileStatuses(w.dir)).toEqual([]); // our own write is not a human edit
    humanSets(w, 'Cancelled');
    await w.pull();
    expect(await reconcileStatuses(w.dir)).toEqual([
      { item: w.id, from: 'Ready', to: 'Cancelled' },
    ]);
    const ev = readEvents(w.dir)
      .filter((e) => e.type === 'item.status')
      .at(-1);
    expect(ev).toMatchObject({
      actor: 'human',
      item: w.id,
      data: { from: 'Ready', to: 'Cancelled', source: 'notion' },
    });
    expect(await reconcileStatuses(w.dir)).toEqual([]);
  });

  it('a human moving a story to Blocked and back keeps the counters straight', async () => {
    const w = await world();
    await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'Ready',
      actor: 'ba',
      facts: facts(['dor_met', 'priority_set']),
      runId: RUN,
    });
    await w.push();
    await w.pull();
    humanSets(w, 'Blocked');
    await w.pull();
    await reconcileStatuses(w.dir);
    expect(readItem(w.dir, w.id)).toMatchObject({
      blocked_from: 'Ready',
      blocked_reason: 'set in Notion',
      run_failures: 0,
    });
    humanSets(w, 'Ready');
    await w.pull();
    await reconcileStatuses(w.dir);
    expect(readItem(w.dir, w.id)).toMatchObject({ blocked_from: null, blocked_reason: null });
  });

  it('a human edit beats a pending engine write (conflict) and is then adopted', async () => {
    const w = await world();
    await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'Ready',
      actor: 'ba',
      facts: facts(['dor_met', 'priority_set']),
      runId: RUN,
    });
    await w.push();
    await w.pull();
    // engine queues Ready -> In Progress; a human sets Cancelled before it is pushed
    await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'In Progress',
      actor: 'orchestrator',
      facts: facts(['test_cases_exist', 'story_budget_available', 'wip_ok']),
      runId: RUN,
    });
    humanSets(w, 'Cancelled');
    const pushed = await w.push();
    expect(pushed.conflicts).toHaveLength(1);
    expect(selected(status(w))).toBe('Cancelled');
    await w.pull();
    expect(await reconcileStatuses(w.dir)).toEqual([
      { item: w.id, from: 'In Progress', to: 'Cancelled' },
    ]);
  });

  it('skips a story whose engine write is still pending, a story the engine never moved, and junk values', async () => {
    const w = await world();
    expect(await reconcileStatuses(w.dir)).toEqual([]); // never moved
    await moveItem({
      projectDir: w.dir,
      item: w.id,
      to: 'Ready',
      actor: 'ba',
      facts: facts(['dor_met', 'priority_set']),
      runId: RUN,
    });
    // mirror still says Backlog while the engine write waits in the outbox
    expect(await reconcileStatuses(w.dir)).toEqual([]);
    expect(mirrorStatus(tempDir(), 'US-1')).toBeUndefined();
  });
});
