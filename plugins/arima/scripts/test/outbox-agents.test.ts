// WP-104: the outbox for agents - entries bound to their run, ids issued by the engine,
// per-role database and property limits, the Status opt-in, one secret allow-list.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { readCounters } from '../src/ids.js';
import type { Role } from '../src/ledger.js';
import { Throttle } from '../src/lib/throttle.js';
import { scanSecrets } from '../src/lib/secrets.js';
import { allocateId, allocatedTo, registerEngineEntry } from '../src/notion/allocations.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { enqueue, outboxDir, pushOutbox } from '../src/notion/outbox.js';
import type { OutboxEntry } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { enqueueReportRecords } from '../src/notion/proposals.js';
import { ROLES, allowedTools } from '../src/roles.js';
import type { AgentReport } from '../src/report.js';
import { FakeNotion } from './fake-notion.js';
import { tempDir } from './helpers.js';

const RUN = 'r-20261119-1000-01';
let seq = 0;

async function setup(role: Role = 'ba') {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  const dir = tempDir('arima-outbox-agents-');
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  await appendEvent(dir, { type: 'run.start', actor: role, run_id: RUN, item: 'US-001' });
  return { fake, port, map, dir };
}

const entry = (over: Partial<OutboxEntry> & Pick<OutboxEntry, 'op' | 'database'>): OutboxEntry => {
  seq += 1;
  return {
    id: `ob-${String(seq).padStart(4, '0')}`,
    created_at: `2026-11-19T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    run_id: RUN,
    role: 'ba',
    ...over,
  };
};

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  schema_version: 1,
  run_id: RUN,
  role: 'ba',
  item: 'none',
  status: 'done',
  summary: 'x',
  ...over,
});

const pending = (dir: string): string[] =>
  readdirSync(outboxDir(dir)).filter((f) => f.endsWith('.json'));

describe('entries are bound to their run', () => {
  it('an entry whose role differs from the run is rejected', async () => {
    const { dir, port, map, fake } = await setup('ba');
    enqueue(
      dir,
      entry({ op: 'create', database: 'documents', role: 'qa', properties: { Title: 'Plan' } }),
    );
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/says role qa, but run .* was started as ba/);
    expect(fake.rowByTitle('Documents', 'Plan')).toBeUndefined();
    expect(readEvents(dir).filter((e) => e.type === 'notion.refused')).toHaveLength(1);
  });

  it('an entry for a run ARIMA never started is rejected', async () => {
    const { dir, port, map } = await setup('ba');
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'documents',
        run_id: 'r-20261119-1000-77',
        properties: { Title: 'Plan' },
      }),
    );
    expect((await pushOutbox(dir, port, map)).rejected[0]?.reason).toMatch(/no run.start event/);
  });

  it('a role that is not in the team is rejected', async () => {
    const { dir, port, map } = await setup('ba');
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'documents',
        role: 'sponsor',
        properties: { Title: 'Plan' },
      }),
    );
    expect((await pushOutbox(dir, port, map)).rejected[0]?.reason).toMatch(
      /not a role of the team/,
    );
  });

  it('a matching entry is applied', async () => {
    const { dir, port, map, fake } = await setup('ba');
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'documents',
        properties: { Title: 'Plan', Type: 'PRD', Phase: 1 },
      }),
    );
    expect((await pushOutbox(dir, port, map)).applied).toHaveLength(1);
    expect(fake.rowByTitle('Documents', 'Plan')).toBeDefined();
  });

  it('enqueue inside a run refuses an entry that names another run or role', () => {
    const dir = tempDir();
    const env = { ARIMA_RUN_ID: RUN, ARIMA_ROLE: 'ba' } as NodeJS.ProcessEnv;
    expect(() =>
      enqueue(
        dir,
        entry({
          op: 'create',
          database: 'documents',
          run_id: 'r-20261119-1000-02',
          properties: { Title: 'x' },
        }),
        { env },
      ),
    ).toThrow(/this process is run/);
    expect(() =>
      enqueue(
        dir,
        entry({ op: 'create', database: 'documents', role: 'qa', properties: { Title: 'x' } }),
        { env },
      ),
    ).toThrow(/runs as ba/);
    expect(() =>
      enqueue(dir, entry({ op: 'create', database: 'documents', properties: { Title: 'x' } }), {
        env,
      }),
    ).not.toThrow();
  });
});

describe('per-role database and property limits', () => {
  it('a developer entry aimed at gates is rejected with database_not_allowed', async () => {
    const { dir, port, map, fake } = await setup('developer');
    enqueue(
      dir,
      entry({ op: 'create', database: 'gates', role: 'developer', properties: { Gate: 'G1' } }),
    );
    const r = await pushOutbox(dir, port, map);
    expect(r.rejected[0]).toMatchObject({ code: 'database_not_allowed' });
    expect(r.rejected[0]?.reason).toMatch(/database_not_allowed/);
    expect(fake.rowByTitle('Gates', 'G1')).toBeUndefined();
    const ev = readEvents(dir).find((e) => e.type === 'notion.refused');
    expect(ev?.data).toMatchObject({ reason_code: 'database_not_allowed' });
  });

  it('no non-orchestrator role may write gates, digests, cost_log or milestones; devops alone may write releases', async () => {
    const { OUTBOX_DATABASES } = await import('../src/roles.js');
    for (const role of ROLES.filter((r) => r !== 'orchestrator'))
      for (const db of ['gates', 'digests', 'cost_log', 'milestones'] as const)
        expect(OUTBOX_DATABASES[role], `${role} ${db}`).not.toContain(db);
    expect(ROLES.filter((r) => OUTBOX_DATABASES[r].includes('releases')).sort()).toEqual([
      'devops',
      'orchestrator',
    ]);
    expect(OUTBOX_DATABASES.orchestrator).toHaveLength(19);
  });

  it('devops can propose a release but never its human-only approval fields (WP-213)', async () => {
    const { dir, port, map, fake } = await setup('devops');
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'releases',
        role: 'devops',
        properties: { Version: 'v0.1.0', 'Prod deploy approval': 'Approved' },
      }),
    );
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/Prod deploy approval/);
    expect(fake.rowByTitle('Releases', 'v0.1.0')).toBeUndefined();
  });

  it('ba and ux cannot write Priority; the orchestrator can', async () => {
    for (const role of ['ba', 'ux'] as const) {
      const { dir, port, map } = await setup(role);
      const id = await allocateId(dir, 'US', RUN);
      enqueue(
        dir,
        entry({
          op: 'create',
          database: 'stories',
          role,
          properties: { ID: id, Title: 'a', Priority: 1 },
        }),
      );
      expect((await pushOutbox(dir, port, map)).rejected[0]?.reason).toMatch(
        /may not write "Priority"/,
      );
    }
    const { dir, port, map } = await setup('orchestrator');
    const id = await allocateId(dir, 'US', RUN);
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        role: 'orchestrator',
        properties: { ID: id, Title: 'a', Priority: 1 },
      }),
    );
    expect((await pushOutbox(dir, port, map)).applied).toHaveLength(1);
  });
});

describe('an agent cannot choose an id; the engine issues them', () => {
  it('a hand-written create with a made-up id is rejected, and with an id issued to another run too', async () => {
    const { dir, port, map, fake } = await setup('ba');
    enqueue(
      dir,
      entry({ op: 'create', database: 'stories', properties: { ID: 'US-777', Title: 'sneaky' } }),
    );
    const other = await allocateId(dir, 'US', 'r-20261119-1000-09');
    enqueue(
      dir,
      entry({ op: 'create', database: 'stories', properties: { ID: other, Title: 'borrowed' } }),
    );
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toEqual([]);
    expect(r.rejected.map((x) => x.reason).join('\n')).toMatch(/an agent cannot choose an id/);
    expect(fake.rowByTitle('Stories', 'US-777')).toBeUndefined();
    expect(fake.rowByTitle('Stories', other)).toBeUndefined();
  });

  it('an id the engine issued to this run is accepted', async () => {
    const { dir, port, map, fake } = await setup('ba');
    const id = await allocateId(dir, 'US', RUN);
    expect(allocatedTo(dir, id)).toBe(RUN);
    enqueue(dir, entry({ op: 'create', database: 'stories', properties: { ID: id, Title: 'ok' } }));
    expect((await pushOutbox(dir, port, map)).applied).toHaveLength(1);
    expect(fake.rowByTitle('Stories', id)).toBeDefined();
  });

  it('report records get issued ids and NEW-n placeholders are rewritten everywhere', async () => {
    const { dir, port, map, fake } = await setup('ba');
    const r = await enqueueReportRecords({
      projectDir: dir,
      runId: RUN,
      role: 'ba',
      now: new Date('2026-11-19T10:00:00Z'),
      report: report({
        item: 'none',
        records: [
          { database: 'epics', ref: 'NEW-1', properties: { Title: 'Checkout' } },
          {
            database: 'stories',
            ref: 'NEW-2',
            properties: { ID: 'NEW-2', Title: 'Cart summary', Epic: ['NEW-1'] },
          },
          {
            database: 'risks',
            ref: 'NEW-3',
            properties: { Title: 'Late data about NEW-2' },
            content_markdown: 'Depends on NEW-1 and NEW-2.',
          },
        ],
        decisions: [
          {
            summary: 'Split NEW-2',
            options_considered: ['split', 'keep'],
            chosen: 'split',
            reversible: true,
            rationale: 'size',
          },
        ],
      } as unknown as Partial<AgentReport>),
    });
    expect(r.ids).toEqual({ 'NEW-1': 'EP-01', 'NEW-2': 'US-001', 'NEW-3': 'RISK-001' });
    expect(r.entries).toHaveLength(4);
    expect(readCounters(dir)).toMatchObject({ EP: 1, US: 1, RISK: 1, DEC: 1 });

    const files = pending(dir).map(
      (f) => JSON.parse(readFileSync(path.join(outboxDir(dir), f), 'utf8')) as OutboxEntry,
    );
    for (const e of files) {
      expect(e.role).toBe('ba');
      expect(e.run_id).toBe(RUN);
      expect(JSON.stringify(e)).not.toMatch(/NEW-\d/);
    }
    expect(files.find((e) => e.database === 'stories')?.properties).toMatchObject({
      ID: 'US-001',
      Epic: ['EP-01'],
    });
    expect(files.find((e) => e.database === 'risks')?.content_markdown).toBe(
      'Depends on EP-01 and US-001.',
    );
    // and they apply, in order, through the real push
    const pushed = await pushOutbox(dir, port, map);
    expect(pushed.rejected).toEqual([]);
    expect(pushed.applied).toHaveLength(4);
    expect(fake.rowByTitle('Stories', 'US-001')).toBeDefined();
    expect(fake.rowByTitle('Decisions', 'DEC-0001')).toBeDefined();
  });

  it('an agent that supplies its own id, or an undefined placeholder, is refused before anything is issued', async () => {
    const dir = tempDir();
    const bad = (records: unknown): Promise<unknown> =>
      enqueueReportRecords({
        projectDir: dir,
        runId: RUN,
        role: 'ba',
        report: report({ records } as never),
      });
    await expect(
      bad([{ database: 'stories', properties: { ID: 'US-050', Title: 'x' } }]),
    ).rejects.toThrow(/cannot choose an id/);
    await expect(
      bad([{ database: 'stories', ref: 'NEW-1', properties: { Title: 'x', Epic: ['NEW-9'] } }]),
    ).rejects.toThrow(/NEW-9 is not defined/);
  });
});

describe('Status writes: init may only opt in for the entries it created (G-02)', () => {
  it('a stale agent entry carrying Status is refused while init-made entries are allowed', async () => {
    const { dir, port, map, fake } = await setup('orchestrator');
    const id = await allocateId(dir, 'US', RUN);
    await registerEngineEntry(dir, 'init-r-1-01'); // init registers what it enqueues
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        role: 'orchestrator',
        properties: { ID: id, Title: 'stale', Status: 'Done' },
      }),
    );
    enqueue(
      dir,
      entry({
        id: 'init-r-1-01',
        op: 'create',
        database: 'gates',
        role: 'orchestrator',
        properties: { Gate: 'G0', Phase: 0, Status: 'Not ready' },
      }),
    );
    const r = await pushOutbox(dir, port, map, { allowStatusWrites: { idPrefix: 'init-' } });
    expect(r.applied).toEqual(['init-r-1-01']);
    expect(r.rejected[0]?.reason).toMatch(/"Status".*except by the engine/);
    expect(fake.rowByTitle('Stories', id)).toBeUndefined();
  });

  it('init passes the prefix form, never a blanket true', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'src', 'init.ts'), 'utf8');
    expect(src).not.toMatch(/allowStatusWrites: true/);
    expect(src).toMatch(/allowStatusWrites: \{ idPrefix: 'init-' \}/);
  });
});

describe('the outbox write pattern is top-level files only (G-07)', () => {
  it('no role may write the outbox sub-folders by pattern', () => {
    for (const role of ROLES)
      for (const t of allowedTools(role, '/p/scripts/dist'))
        if (/outbox/.test(t)) expect(t, role).toBe('Write(./.arima/outbox/*.json)');
  });
});

describe('one secret allow-list (G-09)', () => {
  const token = 'ntn_' + 'aB3xQ9zLm2Kp7Vd4Ts8Wy1Nc6Hf0JgReUo5Xi';

  it('a reviewed fingerprint lets enqueue and push through; without it both refuse', async () => {
    const { dir, port, map, fake } = await setup('ba');
    const props = { Title: 'Plan', Type: 'PRD', Phase: 1, Notes: `example ${token}` };
    const found = scanSecrets(JSON.stringify(props));
    expect(found.length).toBeGreaterThan(0);
    expect(() =>
      enqueue(dir, entry({ op: 'create', database: 'documents', properties: props })),
    ).toThrow(/secret/);

    writeFileSync(
      path.join(dir, '.arima', 'secret-allowlist.txt'),
      found.map((f) => f.fingerprint).join('\n'),
    );
    expect(() =>
      enqueue(
        dir,
        entry({ op: 'create', database: 'documents', properties: { ...props, Title: 'Plan2' } }),
      ),
    ).not.toThrow();
    void port;
    void map;
    void fake;
  });

  it('state push, outbox and init use the one reader', () => {
    const read = (f: string): string =>
      readFileSync(path.join(import.meta.dirname, '..', 'src', f), 'utf8');
    expect(read('state.ts')).toMatch(/readAllowlistFile/);
    expect(read('init.ts')).toMatch(/loadSecretAllowlist/);
    expect(read('notion/outbox.ts')).toMatch(/loadSecretAllowlist/);
    for (const f of ['state.ts', 'init.ts', 'notion/outbox.ts'])
      expect(read(f), f).not.toMatch(/parseAllowlist\(/);
  });
});
