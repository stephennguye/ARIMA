// S0.6: scrubbed REAL Notion responses (recorded by `npm run test:live` with ARIMA_LIVE_RECORD=1)
// are fed through ARIMA's own code, and the fake used by the other tests is checked against them,
// so the fake cannot quietly drift away from what Notion really returns.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { toMirrorRow } from '../src/notion/mirror.js';
import { createNotionPort } from '../src/notion/port.js';
import type { NotionClientLike, RawRow } from '../src/notion/port.js';
import { FakeNotion } from './fake-notion.js';

const DIR = path.join(import.meta.dirname, 'fixtures', 'notion-real');
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as Record<string, unknown>;

type RealProp = { id: string; type: string; [k: string]: unknown };
const page = load('page-documents.json') as {
  id: string;
  last_edited_time: string;
  last_edited_by: { id: string };
  properties: Record<string, RealProp>;
};
const query = load('query-documents.json') as {
  results: { id: string; last_edited_time: string; properties: Record<string, RealProp> }[];
};

describe('recorded real Notion responses', () => {
  it('Notion rounds last_edited_time to the whole minute', () => {
    expect(page.last_edited_time).toMatch(/:00\.000Z$/);
    for (const r of query.results) expect(r.last_edited_time).toMatch(/:00\.000Z$/);
  });

  it('toMirrorRow reads a real page: title as id, plain values, the audit stamp', () => {
    const raw: RawRow = {
      pageId: page.id,
      lastEdited: page.last_edited_time,
      properties: page.properties,
    };
    const row = toMirrorRow(raw);
    expect(row.id).toBe('ARIMA live test row (safe to ignore)');
    expect(row.properties['Version']).toBe('v-applied');
    expect(row.properties['Last written by run']).toMatch(/^r-\d{8}-\d{4}-\d{2}$/);
    expect(row.properties['Status']).toBeNull(); // an empty select is null, not undefined
    expect(row.properties['Phase']).toBeNull();
  });

  it('the port reads a real query response into rows', async () => {
    const client = {
      dataSources: {
        query: () => Promise.resolve({ ...query, has_more: false, next_cursor: null }),
      },
    } as unknown as NotionClientLike;
    const rows = await createNotionPort(client, new Throttle(0)).queryRows('ds');
    expect(rows).toHaveLength(query.results.length);
    expect(rows[0]?.properties).toBe(query.results[0]?.properties);
  });

  it('a real Requirements.Coverage property is a formula and Test results a rollup', () => {
    const ds = load('data-source-requirements.json') as { properties: Record<string, RealProp> };
    expect(ds.properties['Coverage']?.type).toBe('formula');
    expect(ds.properties['Test results']?.type).toBe('rollup');
  });

  it('the real bot is the last editor of a page it wrote (S1: last_edited_by is per page)', () => {
    const users = load('users-list.json') as { results: { id: string; type: string }[] };
    const bot = users.results.find((u) => u.type === 'bot');
    expect(bot?.id).toBe(page.last_edited_by.id);
  });
});

describe('the fake keeps the shape of real Notion pages', () => {
  const keys = (o: unknown): string[] => Object.keys(o as object).sort();

  it('every property of a fake page has the same keys as the real property of that type', async () => {
    const fake = new FakeNotion();
    const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
    await bootstrapTemplate(port, fake.rootId);
    const ds = [...fake.databases.values()].find((d) => d.title === 'Documents');
    const created = await port.createPage(ds!.dataSourceId, {
      Title: { title: [{ type: 'text', text: { content: 'x' } }] },
      Version: { rich_text: [{ type: 'text', text: { content: 'v1' } }] },
      Type: { select: { name: 'Other' } },
    });
    const fakePage = (await fake.client.pages.retrieve({ page_id: created.pageId })) as {
      properties: Record<string, RealProp>;
    };
    expect(fakePage.properties).toBeDefined();
    const seen = new Set<string>();
    for (const [name, real] of Object.entries(page.properties)) {
      const f = fakePage.properties[name];
      if (f === undefined) continue;
      seen.add(real.type);
      expect(f.type, `${name} type`).toBe(real.type);
      // the real one has an `id`, the type tag and the value under the type's name
      expect(keys(f), `${name} keys`).toEqual(keys(real));
    }
    expect([...seen].sort()).toEqual(expect.arrayContaining(['rich_text', 'select', 'title']));
  });

  it('a fake page carries the same top-level fields the code relies on', async () => {
    const fake = new FakeNotion();
    const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
    await bootstrapTemplate(port, fake.rootId);
    const ds = [...fake.databases.values()].find((d) => d.title === 'Documents');
    const created = await port.createPage(ds!.dataSourceId, {
      Title: { title: [{ type: 'text', text: { content: 'x' } }] },
    });
    const fakePage = (await fake.client.pages.retrieve({ page_id: created.pageId })) as Record<
      string,
      unknown
    >;
    for (const k of ['id', 'last_edited_time', 'properties']) {
      expect(fakePage, k).toHaveProperty(k);
      expect(page, k).toHaveProperty(k);
    }
  });
});
