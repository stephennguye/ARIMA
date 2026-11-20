// WP-142: the human views, created through the API: the right database, filter, sort and grouping for each;
// idempotent by name; never altered or deleted. The fake Notion records every create.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runNotionCli } from '../src/cli/notion-cli.js';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { createNotionPort } from '../src/notion/port.js';
import { VIEW_SPECS, ensureViews } from '../src/notion/views.js';
import { FakeNotion } from './fake-notion.js';
import { project } from './helpers.js';

async function world() {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  return { fake, port, map };
}

describe('the view specs', () => {
  it('cover the five views of spec 9.2 that ARIMA creates, each name in the right database', () => {
    const by = (name: string): string[] =>
      VIEW_SPECS.filter((v) => v.name === name)
        .map((v) => v.db)
        .sort();
    expect(by('Board')).toEqual(['stories']);
    expect(by('Approval inbox')).toEqual([
      'change_requests',
      'decisions',
      'gates',
      'questions',
      'releases',
    ]);
    expect(by('RTM')).toEqual(['requirements']);
    expect(by('Milestone burn')).toEqual(['milestones', 'stories']);
    expect(by('Open bugs')).toEqual(['bugs']);
  });
});

describe('ensureViews', () => {
  it('creates every view once, with its filter, sort and grouping', async () => {
    const { fake, port, map } = await world();
    const r = await ensureViews(port, map);
    expect(r.failed).toEqual([]);
    expect(r.created).toHaveLength(VIEW_SPECS.length);
    expect(fake.views).toHaveLength(VIEW_SPECS.length);
    const find = (db: string, name: string) => {
      const d = map.databases[db]!;
      return fake.views.find((v) => v.databaseId === d.database_id && v.name === name)!;
    };
    const board = find('stories', 'Board');
    expect(board.body['type']).toBe('board');
    expect(board.body['data_source_id']).toBe(map.databases['stories']!.data_source_id);
    expect(board.body['configuration']).toEqual({
      type: 'board',
      group_by: {
        type: 'select',
        property_id: map.databases['stories']!.properties['Status']!.id,
        sort: { type: 'manual' },
      },
    });
    expect(board.body['filter']).toEqual({
      property: 'Status',
      select: { does_not_equal: 'Cancelled' },
    });
    expect(find('gates', 'Approval inbox').body['filter']).toEqual({
      property: 'Status',
      select: { equals: 'Ready for review' },
    });
    expect(find('questions', 'Approval inbox').body['filter']).toEqual({
      and: [
        { property: 'Status', select: { equals: 'Open' } },
        { property: 'Blocking', checkbox: { equals: true } },
      ],
    });
    expect(find('releases', 'Approval inbox').body['filter']).toEqual({
      property: 'Status',
      select: { equals: 'Awaiting approval' },
    });
    expect(find('change_requests', 'Approval inbox').body['filter']).toEqual({
      property: 'Decision',
      select: { equals: 'Pending' },
    });
    expect(find('bugs', 'Open bugs').body['sorts']).toEqual([
      { property: 'Severity', direction: 'ascending' },
    ]);
    expect(find('bugs', 'Open bugs').body['filter']).toEqual({
      or: ['Open', 'In progress', 'Fixed'].map((v) => ({
        property: 'Status',
        select: { equals: v },
      })),
    });
    expect(find('stories', 'Milestone burn').body['sorts']).toEqual([
      { property: 'Cost USD', direction: 'descending' },
    ]);
    expect(find('requirements', 'RTM').body['type']).toBe('table');
  });

  it('a second run creates nothing and reports every view as existing', async () => {
    const { fake, port, map } = await world();
    await ensureViews(port, map);
    const again = await ensureViews(port, map);
    expect(again.created).toEqual([]);
    expect(again.existing).toHaveLength(VIEW_SPECS.length);
    expect(fake.views).toHaveLength(VIEW_SPECS.length);
  });

  it('a view a person already made with that name is left alone (never altered, never replaced)', async () => {
    const { fake, port, map } = await world();
    const bugs = map.databases['bugs']!;
    await port.createView({
      databaseId: bugs.database_id,
      dataSourceId: bugs.data_source_id,
      name: 'Open bugs',
      type: 'table',
    });
    const r = await ensureViews(port, map);
    expect(r.existing.map((e) => `${e.db}:${e.name}`)).toContain('bugs:Open bugs');
    expect(fake.views.filter((v) => v.name === 'Open bugs')).toHaveLength(1);
    expect(fake.views.find((v) => v.name === 'Open bugs')?.body['filter']).toBeUndefined();
    expect(
      fake.calls.filter((c) => c.startsWith('views.')).some((c) => /delete|update/.test(c)),
    ).toBe(false);
  });

  it('one failing view does not stop the others, and says why', async () => {
    const { fake, port, map } = await world();
    fake.failNext = { op: 'views.create', status: 400 };
    const r = await ensureViews(port, map);
    expect(r.failed).toHaveLength(1);
    expect(r.created).toHaveLength(VIEW_SPECS.length - 1);
    expect(r.failed[0]?.reason.length).toBeGreaterThan(0);
  });

  it('a database missing from the map is reported, not guessed', async () => {
    const { port, map } = await world();
    const trimmed = { ...map, databases: { ...map.databases } };
    delete trimmed.databases['bugs'];
    const r = await ensureViews(port, trimmed);
    expect(r.failed.map((f) => f.db)).toEqual(['bugs']);
    expect(r.failed[0]?.reason).toMatch(/not in the Notion map/);
    expect(r.created.length).toBe(VIEW_SPECS.length - 1);
  });
});

describe('arima-notion views and notify (CLI)', () => {
  async function cliWorld() {
    const w = await world();
    const dir = project({
      arima: [['"<duplicated template root page id>"', `"${w.fake.rootId}"`]],
    });
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(w.map));
    const go = async (argv: string[]) => {
      let out = '';
      let err = '';
      const code = await runNotionCli(
        argv,
        { out: (s) => (out += s), err: (s) => (err += s), cwd: dir },
        {
          portFactory: () => w.port,
          env: { ARIMA_NOTION_TOKEN: 'ntn_not_a_real_token' },
          now: new Date('2026-11-20T12:00:00Z'),
          lock: { maxWaitMs: 0, sleep: () => Promise.resolve() },
        },
      );
      return { code, out, err };
    };
    return { ...w, dir, go };
  }

  it('views creates them (exit 0) and a second run reports them as already there', async () => {
    const w = await cliWorld();
    const a = await w.go(['views', '--project', w.dir]);
    expect(a.code, a.err).toBe(0);
    expect(a.out).toContain(`${VIEW_SPECS.length} created, 0 already there, 0 failed`);
    const b = await w.go(['views', '--project', w.dir]);
    expect(b.out).toContain(`0 created, ${VIEW_SPECS.length} already there, 0 failed`);
    expect(w.fake.views).toHaveLength(VIEW_SPECS.length);
  });

  it('views exits 1 and names the view that failed', async () => {
    const w = await cliWorld();
    w.fake.failNext = { op: 'views.create', status: 400 };
    const r = await w.go(['views', '--project', w.dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAILED');
  });

  it('notify --dry-run lists what it would send and posts nothing; a person without a Notion id is skipped (exit 0)', async () => {
    const w = await cliWorld();
    mkdirSync(path.join(w.dir, '.arima', 'mirror'), { recursive: true });
    writeFileSync(
      path.join(w.dir, '.arima', 'mirror', 'gates.json'),
      JSON.stringify({
        database: 'gates',
        rows: [
          {
            page_id: 'p-G1',
            last_edited_time: 't',
            id: 'G1',
            properties: { Status: 'Ready for review' },
          },
        ],
      }),
    );
    const r = await w.go(['notify', '--dry-run', '--project', w.dir]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('skipped gate:G1');
    expect(w.fake.comments).toEqual([]);
  });
});
