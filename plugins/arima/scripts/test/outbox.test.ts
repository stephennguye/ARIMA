import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runNotionCli } from '../src/cli/notion-cli.js';
import { readEvents } from '../src/events.js';
import { Throttle, withBackoff } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { findRow, mirrorFile, pullMirror, readMirror } from '../src/notion/mirror.js';
import type { MirrorFile } from '../src/notion/mirror.js';
import { enqueue, outboxDir, pushOutbox } from '../src/notion/outbox.js';
import type { OutboxEntry } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { markdownToBlocks } from '../src/notion/values.js';
import { FakeNotion } from './fake-notion.js';
import { tempDir } from './helpers.js';

const RUN = 'r-20261118-0200-01';
let seq = 0;

async function setup() {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  const dir = tempDir('arima-outbox-');
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  return { fake, port, map, dir };
}

const entry = (over: Partial<OutboxEntry> & Pick<OutboxEntry, 'op' | 'database'>): OutboxEntry => {
  seq += 1;
  return {
    id: `ob-${String(seq).padStart(4, '0')}`,
    created_at: `2026-11-18T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    run_id: RUN,
    role: 'ba',
    ...over,
  };
};

const events = (dir: string, type: string) => readEvents(dir).filter((e) => e.type === type);
const pending = (dir: string) => readdirSync(outboxDir(dir)).filter((f) => f.endsWith('.json'));
const bucket = (dir: string, name: string) =>
  existsSync(path.join(outboxDir(dir), name))
    ? readdirSync(path.join(outboxDir(dir), name)).filter((f) => !f.endsWith('.result.json'))
    : [];

describe('markdownToBlocks', () => {
  it('converts headings, lists, to-dos and paragraphs', () => {
    const blocks = markdownToBlocks('# Title\n\nSome text\nmore text\n\n- a\n- [x] done\n1. one\n');
    expect(blocks.map((b) => b['type'])).toEqual([
      'heading_1',
      'paragraph',
      'bulleted_list_item',
      'to_do',
      'numbered_list_item',
    ]);
    expect(JSON.stringify(blocks[1])).toContain('Some text more text');
  });

  it('splits long text into Notion-sized rich-text chunks', () => {
    const [b] = markdownToBlocks('x'.repeat(4500));
    const rt = (b?.['paragraph'] as { rich_text: unknown[] }).rich_text;
    expect(rt).toHaveLength(3);
  });
});

describe('withBackoff and the port (HTTP 429)', () => {
  it('waits Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await withBackoff(
      () => {
        n += 1;
        return n < 3
          ? Promise.reject(
              Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '2' } }),
            )
          : Promise.resolve('ok');
      },
      { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    );
    expect(out).toBe('ok');
    expect(waits).toEqual([2000, 2000]);
  });

  it('backs off exponentially without a header, gives up after the retries, and never retries other errors', async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => (waits.push(ms), Promise.resolve());
    await expect(
      withBackoff(
        () => Promise.reject(Object.assign(new Error('rate'), { code: 'rate_limited' })),
        { retries: 3, baseMs: 100, sleep },
      ),
    ).rejects.toThrow('rate');
    expect(waits).toEqual([100, 200, 400]);
    let calls = 0;
    await expect(
      withBackoff(
        () => (calls++, Promise.reject(Object.assign(new Error('bad'), { status: 400 }))),
        { sleep },
      ),
    ).rejects.toThrow('bad');
    expect(calls).toBe(1);
  });

  it('the port retries a 429 from the API', async () => {
    const { fake, port } = await setup();
    fake.failNext = { op: 'dataSources.query', status: 429, message: 'slow down' };
    const ds = fake.databases.get(fake.dbIdByTitle('Stories'))!.dataSourceId;
    await expect(port.queryRows(ds)).resolves.toEqual([]);
  });
});

describe('mirror (pull)', () => {
  it('writes one file per mapped database with plain values', async () => {
    const { fake, port, map, dir } = await setup();
    const ds = map.databases['stories']!.data_source_id;
    await fake.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: ds },
      properties: {
        ID: { title: [{ type: 'text', text: { content: 'US-001' } }] },
        Complexity: { select: { name: 'M' } },
        Attempt: { number: 2 },
        'PR link': { url: 'https://example.com/pr/1' },
      },
    });
    const mirrors = await pullMirror(dir, port, map, { now: new Date('2026-11-18T01:00:00Z') });
    expect(mirrors.size).toBe(19);
    expect(existsSync(mirrorFile(dir, 'stories'))).toBe(true);
    const m = readMirror(dir, 'stories') as MirrorFile;
    expect(m.fetched_at).toBe('2026-11-18T01:00:00.000Z');
    expect(m.rows[0]).toMatchObject({
      id: 'US-001',
      properties: { Complexity: 'M', Attempt: 2, 'PR link': 'https://example.com/pr/1' },
    });
    expect(events(dir, 'notion.pull')).toHaveLength(19);
  });

  it('finds a row by ARIMA ID or page id, and refuses an ambiguous ID', () => {
    const m: MirrorFile = {
      schema_version: 1,
      database: 'stories',
      fetched_at: 't',
      rows: [
        { page_id: 'p1', last_edited_time: 't', id: 'US-1', properties: {} },
        { page_id: 'p2', last_edited_time: 't', id: 'US-2', properties: {} },
        { page_id: 'p3', last_edited_time: 't', id: 'US-2', properties: {} },
      ],
    };
    expect(findRow(m, 'US-1')?.page_id).toBe('p1');
    expect(findRow(m, 'p2')?.id).toBe('US-2');
    expect(findRow(m, 'nope')).toBeUndefined();
    expect(() => findRow(m, 'US-2')).toThrow(/2 rows/);
  });
});

describe('outbox: create / update / append', () => {
  it('creates a row, stamps the run id, records the outcome and an event', async () => {
    const { fake, port, map, dir } = await setup();
    const e = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-001', Title: 'Checkout summary', Complexity: 'M', Priority: 1 },
    });
    enqueue(dir, e);
    const report = await pushOutbox(dir, port, map);
    expect(report).toMatchObject({ applied: [e.id], rejected: [], conflicts: [], deferred: [] });

    const row = fake.rowByTitle('Stories', 'US-001')!;
    expect(fake.text(row, 'Title')).toBe('Checkout summary');
    expect(fake.text(row, 'Last written by run')).toBe(RUN);
    expect(row.properties['Complexity']).toMatchObject({ select: { name: 'M' } });
    expect(pending(dir)).toEqual([]);
    expect(bucket(dir, 'applied')).toEqual([`${e.id}.json`]);
    expect(existsSync(path.join(outboxDir(dir), 'applied', `${e.id}.result.json`))).toBe(true);
    expect(events(dir, 'notion.push')).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ entry: e.id, op: 'create' }) }),
    );
    expect(readMirror(dir, 'stories')?.rows.map((r) => r.id)).toEqual(['US-001']);
  });

  it('adds page content from Markdown on create', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'documents',
        properties: { Title: 'Charter', Type: 'Charter', Status: 'Draft' },
        content_markdown: '# Charter\n\n- scope\n- budget',
      }),
    );
    await pushOutbox(dir, port, map);
    const row = fake.rowByTitle('Documents', 'Charter')!;
    expect((fake.pages.get(row.id) ?? []).map((b) => b.type)).toEqual([
      'heading_1',
      'bulleted_list_item',
      'bulleted_list_item',
    ]);
  });

  it('rejects a create for an ID that already exists, but treats a retry of the same run as done', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({ op: 'create', database: 'stories', properties: { ID: 'US-001', Title: 'a' } }),
    );
    await pushOutbox(dir, port, map);
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        run_id: 'r-20261118-0300-02',
        properties: { ID: 'US-001', Title: 'b' },
      }),
    );
    const dup = await pushOutbox(dir, port, map);
    expect(dup.rejected[0]?.reason).toMatch(/already has a row "US-001"/);

    const same = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-001', Title: 'a' },
    });
    enqueue(dir, same);
    expect((await pushOutbox(dir, port, map)).applied).toEqual([same.id]);
    expect(
      [...fake.rows.values()].filter((r) => r.dsId === map.databases['stories']!.data_source_id),
    ).toHaveLength(1);
  });

  it('updates an existing row and keeps the audit stamp current', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({ op: 'create', database: 'stories', properties: { ID: 'US-001', Title: 'a' } }),
    );
    await pushOutbox(dir, port, map);
    const upd = entry({
      op: 'update',
      database: 'stories',
      item_id: 'US-001',
      run_id: 'r-20261118-0400-03',
      properties: { Status: 'Ready', Attempt: 1 },
    });
    enqueue(dir, upd);
    expect((await pushOutbox(dir, port, map)).applied).toEqual([upd.id]);
    const row = fake.rowByTitle('Stories', 'US-001')!;
    expect(row.properties['Status']).toMatchObject({ select: { name: 'Ready' } });
    expect(fake.text(row, 'Last written by run')).toBe('r-20261118-0400-03');
  });

  it('resolves relations by ARIMA ID and rejects an unknown target', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({ op: 'create', database: 'requirements', properties: { ID: 'REQ-001', Title: 'r' } }),
    );
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        properties: { ID: 'US-001', Title: 's', Requirements: ['REQ-001'] },
      }),
    );
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toHaveLength(2);
    const req = fake.rowByTitle('Requirements', 'REQ-001')!;
    expect(fake.rowByTitle('Stories', 'US-001')!.properties['Requirements']).toMatchObject({
      relation: [{ id: req.id }],
    });

    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        properties: { ID: 'US-002', Title: 's2', Requirements: ['REQ-404'] },
      }),
    );
    expect((await pushOutbox(dir, port, map)).rejected[0]?.reason).toMatch(
      /REQ-404.*does not exist/,
    );
  });

  it('appends Markdown content to an existing page', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(dir, entry({ op: 'create', database: 'documents', properties: { Title: 'PRD' } }));
    await pushOutbox(dir, port, map);
    enqueue(
      dir,
      entry({
        op: 'append_content',
        database: 'documents',
        item_id: 'PRD',
        content_markdown: '## Section\n\ntext',
      }),
    );
    expect((await pushOutbox(dir, port, map)).applied).toHaveLength(1);
    const row = fake.rowByTitle('Documents', 'PRD')!;
    expect((fake.pages.get(row.id) ?? []).map((b) => b.type)).toEqual(['heading_2', 'paragraph']);
  });

  it('applies entries in created_at order', async () => {
    const { fake, port, map, dir } = await setup();
    const late = entry({
      op: 'update',
      database: 'stories',
      item_id: 'US-001',
      created_at: '2026-11-18T00:10:00.000Z',
      properties: { Attempt: 2 },
    });
    const early = entry({
      op: 'create',
      database: 'stories',
      created_at: '2026-11-18T00:05:00.000Z',
      properties: { ID: 'US-001', Title: 'a', Attempt: 1 },
    });
    enqueue(dir, late);
    enqueue(dir, early);
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toEqual([early.id, late.id]);
    expect(fake.rowByTitle('Stories', 'US-001')!.properties['Attempt']).toMatchObject({
      number: 2,
    });
  });
});

describe('outbox: refusals (spec §9.3)', () => {
  it('refuses human-only properties and writes nothing', async () => {
    const { fake, port, map, dir } = await setup();
    const e1 = entry({
      op: 'create',
      database: 'gates',
      properties: { Gate: 'G1', Approvers: ['user-1'] },
    });
    const e2 = entry({
      op: 'create',
      database: 'decisions',
      properties: { ID: 'DEC-0001', Veto: true },
    });
    const e3 = entry({
      op: 'create',
      database: 'questions',
      properties: { ID: 'Q-001', Answer: 'yes' },
    });
    for (const e of [e1, e2, e3]) enqueue(dir, e);
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toEqual([]);
    expect(r.rejected.map((x) => x.id).sort()).toEqual([e1.id, e2.id, e3.id].sort());
    expect(r.rejected[0]?.reason).toMatch(/human-only/);
    expect(fake.rows.size).toBe(0);
    expect(events(dir, 'notion.refused')).toHaveLength(3);
    expect(bucket(dir, 'rejected')).toHaveLength(3);
  });

  it('refuses human-only VALUES of a shared field but allows the others', async () => {
    const { fake, port, map, dir } = await setup();
    const bad = entry({
      op: 'create',
      database: 'gates',
      properties: { Gate: 'G1', Status: 'Approved' },
    });
    const ok = entry({
      op: 'create',
      database: 'gates',
      properties: { Gate: 'G2', Status: 'Ready for review' },
    });
    enqueue(dir, bad);
    enqueue(dir, ok);
    const r = await pushOutbox(dir, port, map);
    expect(r.rejected.map((x) => x.id)).toEqual([bad.id]);
    expect(r.applied).toEqual([ok.id]);
    expect(fake.rowByTitle('Gates', 'G1')).toBeUndefined();
    expect(fake.rowByTitle('Gates', 'G2')).toBeDefined();
  });

  it('refuses unknown properties, the audit property and read-only types', async () => {
    const { port, map, dir } = await setup();
    enqueue(dir, entry({ op: 'create', database: 'stories', properties: { ID: 'US-1', Nope: 1 } }));
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        properties: { ID: 'US-2', 'Last written by run': 'forged' },
      }),
    );
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'requirements',
        properties: { ID: 'REQ-1', Coverage: 'Covered' },
      }),
    );
    const r = await pushOutbox(dir, port, map);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      expect.stringContaining('unknown property "Nope"'),
      expect.stringContaining('stamped by ARIMA'),
      expect.stringContaining('formula property, which agents cannot write'),
    ]);
  });

  it('rejects malformed entries without touching Notion', async () => {
    const { fake, port, map, dir } = await setup();
    mkdirSync(outboxDir(dir), { recursive: true });
    writeFileSync(path.join(outboxDir(dir), 'a-bad-json.json'), '{nope');
    writeFileSync(
      path.join(outboxDir(dir), 'b-bad-op.json'),
      JSON.stringify({
        id: 'x',
        created_at: '2026-11-18T00:00:00Z',
        run_id: RUN,
        role: 'ba',
        op: 'delete',
        database: 'stories',
      }),
    );
    writeFileSync(
      path.join(outboxDir(dir), 'c-no-item.json'),
      JSON.stringify({
        id: 'y',
        created_at: '2026-11-18T00:00:00Z',
        run_id: RUN,
        role: 'ba',
        op: 'update',
        database: 'stories',
      }),
    );
    const r = await pushOutbox(dir, port, map);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected[1]?.reason).toMatch(/invalid outbox entry/);
    expect(r.rejected[2]?.reason).toMatch(/item_id/);
    expect(fake.calls.filter((c) => c.startsWith('pages.'))).toEqual([]);
  });

  it('has no delete: the schema rejects op "delete" and retire only changes a status', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        properties: { ID: 'US-001', Title: 'a', Status: 'Ready' },
      }),
    );
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'requirements',
        properties: { ID: 'REQ-001', Title: 'r', Status: 'Approved' },
      }),
    );
    enqueue(
      dir,
      entry({ op: 'create', database: 'test_cases', properties: { ID: 'TC-0001', Title: 't' } }),
    );
    await pushOutbox(dir, port, map);
    enqueue(dir, entry({ op: 'retire', database: 'stories', item_id: 'US-001' }));
    enqueue(dir, entry({ op: 'retire', database: 'requirements', item_id: 'REQ-001' }));
    enqueue(dir, entry({ op: 'retire', database: 'test_cases', item_id: 'TC-0001' }));
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toHaveLength(2);
    expect(r.rejected[0]?.reason).toMatch(/no retired status/);
    expect(fake.rowByTitle('Stories', 'US-001')!.properties['Status']).toMatchObject({
      select: { name: 'Cancelled' },
    });
    expect(fake.rowByTitle('Requirements', 'REQ-001')!.properties['Status']).toMatchObject({
      select: { name: 'Retired' },
    });
    expect(fake.rows.size).toBe(3); // nothing removed
    enqueue(dir, entry({ op: 'retire', database: 'stories', item_id: 'US-001' }));
    expect((await pushOutbox(dir, port, map)).applied).toHaveLength(1); // already retired: no-op
  });
});

describe('outbox: human edits win (spec §3.3)', () => {
  it('keeps a human edit made after the agent last looked, and records a conflict', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({
        op: 'create',
        database: 'stories',
        properties: { ID: 'US-001', Title: 'original', Priority: 1 },
      }),
    );
    await pushOutbox(dir, port, map);
    const row = fake.rowByTitle('Stories', 'US-001')!;
    const seenByAgent = row.last_edited_time;

    fake.humanEdit(row.id, {
      Title: { rich_text: [{ type: 'text', text: { content: 'edited by a human' } }] },
    });

    const e = entry({
      op: 'update',
      database: 'stories',
      item_id: 'US-001',
      base_last_edited: seenByAgent,
      properties: { Title: 'agent rewrite' },
    });
    enqueue(dir, e);
    const r = await pushOutbox(dir, port, map);
    expect(r.conflicts).toEqual([e.id]);
    expect(r.applied).toEqual([]);
    expect(fake.text(row, 'Title')).toBe('edited by a human');
    expect(bucket(dir, 'conflicts')).toEqual([`${e.id}.json`]);
    expect(events(dir, 'notion.conflict')[0]?.data).toMatchObject({
      entry: e.id,
      database: 'stories',
    });
  });

  it('detects the edit from the previous mirror when the entry has no base_last_edited', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({ op: 'create', database: 'stories', properties: { ID: 'US-001', Title: 'x' } }),
    );
    await pushOutbox(dir, port, map); // mirror now reflects our own write
    fake.humanEdit(fake.rowByTitle('Stories', 'US-001')!.id, { Attempt: { number: 7 } });
    const e = entry({
      op: 'update',
      database: 'stories',
      item_id: 'US-001',
      properties: { Attempt: 1 },
    });
    enqueue(dir, e);
    expect((await pushOutbox(dir, port, map)).conflicts).toEqual([e.id]);
    expect(fake.rowByTitle('Stories', 'US-001')!.properties['Attempt']).toMatchObject({
      number: 7,
    });
  });

  it('does not mistake its own earlier write in the same push for a human edit', async () => {
    const { fake, port, map, dir } = await setup();
    enqueue(
      dir,
      entry({ op: 'create', database: 'stories', properties: { ID: 'US-001', Title: 'x' } }),
    );
    await pushOutbox(dir, port, map);
    const base = fake.rowByTitle('Stories', 'US-001')!.last_edited_time;
    const a = entry({
      op: 'update',
      database: 'stories',
      item_id: 'US-001',
      base_last_edited: base,
      properties: { Attempt: 1 },
    });
    const b = entry({
      op: 'update',
      database: 'stories',
      item_id: 'US-001',
      base_last_edited: base,
      properties: { Attempt: 2 },
    });
    enqueue(dir, a);
    enqueue(dir, b);
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toEqual([a.id, b.id]);
    expect(r.conflicts).toEqual([]);
  });
});

describe('outbox: when Notion misbehaves (spec §7.12)', () => {
  it('leaves an entry in the outbox on a transient error and stops; the next push applies it', async () => {
    const { fake, port, map, dir } = await setup();
    const a = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-001', Title: 'a' },
    });
    const b = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-002', Title: 'b' },
    });
    enqueue(dir, a);
    enqueue(dir, b);
    fake.failNext = { op: 'pages.create', status: 503, message: 'service unavailable' };
    const first = await pushOutbox(dir, port, map);
    expect(first.deferred).toEqual([a.id]);
    expect(first.applied).toEqual([]);
    expect(pending(dir).sort()).toEqual([`${a.id}.json`, `${b.id}.json`].sort());

    const second = await pushOutbox(dir, port, map);
    expect(second.applied).toEqual([a.id, b.id]);
    expect(pending(dir)).toEqual([]);
  });

  it('rejects an entry Notion permanently refuses (4xx) and carries on', async () => {
    const { fake, port, map, dir } = await setup();
    const a = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-001', Title: 'a' },
    });
    const b = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-002', Title: 'b' },
    });
    enqueue(dir, a);
    enqueue(dir, b);
    fake.failNext = { op: 'pages.create', status: 400, message: 'validation_error' };
    const r = await pushOutbox(dir, port, map);
    expect(r.rejected[0]).toMatchObject({ id: a.id });
    expect(r.rejected[0]?.reason).toMatch(/Notion refused/);
    expect(r.applied).toEqual([b.id]);
  });

  it('defers everything when the mirror cannot be refreshed', async () => {
    const { fake, port, map, dir } = await setup();
    const a = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-001', Title: 'a' },
    });
    enqueue(dir, a);
    fake.failNext = { op: 'dataSources.query', message: 'ENOTFOUND api.notion.com' };
    const r = await pushOutbox(dir, port, map);
    expect(r.deferred).toEqual([a.id]);
    expect(pending(dir)).toEqual([`${a.id}.json`]);
    expect(fake.rows.size).toBe(0);
  });

  it('an empty outbox makes no Notion calls', async () => {
    const { fake, port, map, dir } = await setup();
    const before = fake.calls.length;
    const r = await pushOutbox(dir, port, map);
    expect(r).toEqual({ applied: [], rejected: [], conflicts: [], deferred: [] });
    expect(fake.calls.length).toBe(before);
  });
});

describe('arima-notion pull / push CLI', () => {
  const run = async (argv: string[], dir: string, fake: FakeNotion) => {
    let out = '';
    let err = '';
    const code = await runNotionCli(
      argv,
      { out: (s) => (out += s), err: (s) => (err += s), cwd: dir },
      {
        portFactory: () =>
          createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() }),
        env: { ARIMA_NOTION_TOKEN: 'ntn_not_a_real_token' },
        now: new Date('2026-11-18T01:00:00Z'),
      },
    );
    return { code, out, err };
  };

  it('pull mirrors and push applies, with exit codes', async () => {
    const { fake, dir } = await setup();
    const pull = await run(['pull', '--project', dir], dir, fake);
    expect(pull.code).toBe(0);
    expect(pull.out).toContain('mirrored 19 databases');

    const e = entry({
      op: 'create',
      database: 'stories',
      properties: { ID: 'US-001', Title: 'a' },
    });
    enqueue(dir, e);
    const ok = await run(['push', '--project', dir], dir, fake);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('1 applied');

    enqueue(
      dir,
      entry({ op: 'create', database: 'gates', properties: { Gate: 'G1', Approvers: ['u'] } }),
    );
    const bad = await run(['push', '--project', dir], dir, fake);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('human-only');
  });

  it('pull without a notion-map.json explains what to run', async () => {
    const fake = new FakeNotion();
    const dir = tempDir();
    const r = await run(['pull', '--project', dir], dir, fake);
    expect(r.code).toBe(1);
    expect(r.err).toContain('arima-notion map');
  });

  it('never leaves the token in output', async () => {
    const { fake, dir } = await setup();
    const r = await run(['pull', '--project', dir], dir, fake);
    expect(r.out + r.err).not.toContain('ntn_not_a_real_token');
    expect(readFileSync(path.join(dir, '.arima', 'mirror', 'stories.json'), 'utf8')).not.toContain(
      'ntn_',
    );
  });
});
