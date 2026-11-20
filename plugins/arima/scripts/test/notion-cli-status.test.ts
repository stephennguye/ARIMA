// `arima-notion push` and the engine's Status writes (found by the WP-217 live check): the commands that tell a
// person "run arima-notion push" queue Status writes of their own (a review opening, a lesson applied), and a
// plain push must apply exactly those: the `st-` prefix AND a registration in the protected engine-entry registry.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runNotionCli } from '../src/cli/notion-cli.js';
import { appendEvent } from '../src/events.js';
import { Throttle } from '../src/lib/throttle.js';
import { allocateId, registerEngineEntry } from '../src/notion/allocations.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { enqueue } from '../src/notion/outbox.js';
import type { OutboxEntry } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { FakeNotion } from './fake-notion.js';
import { tempDir } from './helpers.js';

const RUN = 'r-20261120-1200-01';

async function world() {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  const dir = tempDir('arima-status-');
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
  const push = async (argv: string[] = ['push']) => {
    let out = '';
    const code = await runNotionCli(
      argv,
      { out: (s) => (out += s), err: () => undefined, cwd: dir },
      {
        portFactory: () => port,
        env: { ARIMA_NOTION_TOKEN: 'ntn_not_a_real_token' },
        now: new Date('2026-11-20T12:00:00Z'),
        isPaused: () => Promise.resolve(false),
      },
    );
    return { code, out };
  };
  const entry = (id: string, over: Partial<OutboxEntry>): void =>
    void enqueue(dir, {
      id,
      created_at: '2026-11-20T12:00:00.000Z',
      run_id: RUN,
      role: 'orchestrator',
      op: 'update',
      database: 'stories',
      item_id: 'US-001',
      ...over,
    });
  return { fake, dir, push, entry };
}

describe('a plain arima-notion push and Status writes', () => {
  it('applies a registered st- entry, refuses an unregistered st- entry, a registered entry without the prefix, and an agent-style entry', async () => {
    const w = await world();
    await allocateId(w.dir, 'US', RUN);
    await registerEngineEntry(w.dir, 'st-seed');
    w.entry('st-seed', {
      op: 'create',
      item_id: undefined as never,
      properties: { ID: 'US-001', Title: 'a', Status: 'Ready' },
    });
    expect((await w.push()).out).toContain('1 applied, 0 rejected');
    const status = (): string =>
      String(
        w.fake.rowByTitle('Stories', 'US-001')?.properties['Status'] &&
          JSON.stringify(w.fake.rowByTitle('Stories', 'US-001')?.properties['Status']),
      );

    await registerEngineEntry(w.dir, 'st-ok');
    w.entry('st-ok', { properties: { Status: 'In Progress' } });
    expect((await w.push()).out).toContain('1 applied, 0 rejected');
    expect(status()).toContain('In Progress');

    w.entry('st-forged', { properties: { Status: 'Done' } }); // right prefix, never registered
    await registerEngineEntry(w.dir, 'engine-no-prefix');
    w.entry('engine-no-prefix', { properties: { Status: 'Done' } }); // registered, wrong prefix
    w.entry('ob-agent', { properties: { Status: 'Done' } }); // an agent-style entry
    const r = await w.push();
    expect(r.out).toContain('0 applied, 3 rejected');
    expect(status()).toContain('In Progress');
  });

  it('--allow-status-writes (a human) still forces a Status write', async () => {
    const w = await world();
    await allocateId(w.dir, 'US', RUN);
    await registerEngineEntry(w.dir, 'st-seed');
    w.entry('st-seed', {
      op: 'create',
      item_id: undefined as never,
      properties: { ID: 'US-001', Title: 'a', Status: 'Ready' },
    });
    await w.push();
    w.entry('ob-human', { properties: { Status: 'Done' } });
    expect((await w.push(['push', '--allow-status-writes'])).out).toContain(
      '1 applied, 0 rejected',
    );
  });
});
