// LIVE tier (S0.6): runs against the real Notion dev workspace. Never part of `npm test` or CI.
//
//   ARIMA_LIVE=1 ARIMA_NOTION_TOKEN=... ARIMA_LIVE_PROJECT=D:\GitHub\arima-dev npm run test:live
//   (add ARIMA_LIVE_RECORD=1 to refresh the scrubbed fixtures in test/fixtures/notion-real/)
//
// It uses one clearly named probe row in the Documents database and never deletes anything. The
// token is read from the environment and is never printed.
import pkg from '@notionhq/client';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapWorkspace } from '../src/notion/mapper.js';
import { pullMirror, readMirror, readNotionMap } from '../src/notion/mirror.js';
import { enqueue, pushOutbox } from '../src/notion/outbox.js';
import { createNotionPortFromToken } from '../src/notion/port.js';
import { scrub } from './scrub.js';
import { tempDir } from '../test/helpers.js';

const { Client } = pkg;
const token = process.env['ARIMA_NOTION_TOKEN'];
const projectDir = process.env['ARIMA_LIVE_PROJECT'];
const LIVE = process.env['ARIMA_LIVE'] === '1' && !!token && !!projectDir;
const RECORD = process.env['ARIMA_LIVE_RECORD'] === '1';
const FIXTURES = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'notion-real');
const PROBE_TITLE = 'ARIMA live test row (safe to ignore)';
const RUN = 'r-20261118-0900-01';

describe.skipIf(!LIVE)('live Notion (real API, dev workspace)', () => {
  const map = LIVE ? readNotionMap(projectDir as string) : (undefined as never);
  const port = LIVE ? createNotionPortFromToken(token as string) : (undefined as never);
  const raw = LIVE ? new Client({ auth: token as string, retry: false }) : (undefined as never);
  const docs = LIVE ? map.databases['documents'] : (undefined as never);

  /** A scratch project directory holding a copy of the dev map, so the dev project is untouched. */
  function scratch(): string {
    const dir = tempDir('arima-live-');
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    copyFileSync(
      path.join(projectDir as string, '.arima', 'notion-map.json'),
      path.join(dir, '.arima', 'notion-map.json'),
    );
    return dir;
  }

  /** Makes sure the probe row exists (created once through the real outbox) and returns its page id. */
  async function probeRow(dir: string): Promise<string> {
    await pullMirror(dir, port, map);
    const have = readMirror(dir, 'documents')?.rows.find((r) => r.id === PROBE_TITLE);
    if (have) return have.page_id;
    enqueue(dir, {
      id: 'live-create-0001',
      created_at: new Date().toISOString(),
      run_id: RUN,
      role: 'orchestrator',
      op: 'create',
      database: 'documents',
      properties: { Title: PROBE_TITLE, Type: 'Other', Version: 'v0' },
    });
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toHaveLength(1);
    await pullMirror(dir, port, map);
    return readMirror(dir, 'documents')!.rows.find((r2) => r2.id === PROBE_TITLE)!.page_id;
  }

  it('the real workspace verifies against the template, with Coverage as a formula and Test results as a rollup', async () => {
    const result = await mapWorkspace(port, map.root_page_id);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.map).toBeDefined();
    expect(Object.keys(result.map!.databases)).toHaveLength(19);
    expect(map.databases['requirements']?.properties['Coverage']?.type).toBe('formula');
    expect(map.databases['requirements']?.properties['Test results']?.type).toBe('rollup');
  });

  it('last_edited_time is rounded to the whole minute (so it cannot detect same-minute edits)', async () => {
    const dir = scratch();
    const pageId = await probeRow(dir);
    const times: string[] = [];
    for (const v of ['v1', 'v2', 'v3']) {
      const w = await port.updatePage(pageId, {
        Version: { rich_text: [{ type: 'text', text: { content: v } }] },
      });
      times.push(w.lastEdited);
    }
    expect(times.every((t) => /:00\.000Z$/.test(t))).toBe(true);
    // Three writes, a fraction of a second apart: at most two distinct minutes.
    expect(new Set(times).size).toBeLessThanOrEqual(2);
  });

  it('the outbox detects an out-of-band edit made in the same minute, by value', async () => {
    const dir = scratch();
    const pageId = await probeRow(dir);
    await pullMirror(dir, port, map); // what an agent would have read
    // Someone else changes the value directly (here through the API; a person in the UI is the same to Notion).
    const outside = `outside-${Date.now()}`;
    await port.updatePage(pageId, {
      Version: { rich_text: [{ type: 'text', text: { content: outside } }] },
    });
    enqueue(dir, {
      id: 'live-update-0001',
      created_at: new Date().toISOString(),
      run_id: RUN,
      role: 'orchestrator',
      op: 'update',
      database: 'documents',
      item_id: PROBE_TITLE,
      properties: { Version: 'agent-overwrite' },
    });
    const r = await pushOutbox(dir, port, map);
    expect(r.conflicts).toEqual(['live-update-0001']);
    expect(r.applied).toEqual([]);
    const now = await port.getPage(pageId);
    expect(JSON.stringify(now.properties['Version'])).toContain(outside);
  });

  it('an agent update with no outside edit applies, and the mirror keeps Notion’s own values', async () => {
    const dir = scratch();
    const pageId = await probeRow(dir);
    await pullMirror(dir, port, map);
    enqueue(dir, {
      id: 'live-update-0002',
      created_at: new Date().toISOString(),
      run_id: RUN,
      role: 'orchestrator',
      op: 'update',
      database: 'documents',
      item_id: PROBE_TITLE,
      properties: { Version: 'v-applied' },
    });
    const r = await pushOutbox(dir, port, map);
    expect(r.applied).toEqual(['live-update-0002']);
    const row = readMirror(dir, 'documents')!.rows.find((x) => x.id === PROBE_TITLE)!;
    expect(row.properties['Version']).toBe('v-applied');
    expect(row.properties['Last written by run']).toBe(RUN);
    expect(row.page_id).toBe(pageId);
  });

  it.skipIf(!RECORD)('records scrubbed real responses as fixtures', async () => {
    const dir = scratch();
    const pageId = await probeRow(dir);
    mkdirSync(FIXTURES, { recursive: true });
    const save = (name: string, data: unknown): void =>
      writeFileSync(path.join(FIXTURES, name), `${JSON.stringify(scrub(data), null, 2)}\n`);
    save('page-documents.json', await raw.pages.retrieve({ page_id: pageId }));
    const q = await raw.dataSources.query({ data_source_id: docs!.data_source_id, page_size: 3 });
    save('query-documents.json', q);
    save(
      'data-source-documents.json',
      await raw.dataSources.retrieve({ data_source_id: docs!.data_source_id }),
    );
    const req = map.databases['requirements'];
    if (req) {
      save(
        'data-source-requirements.json',
        await raw.dataSources.retrieve({ data_source_id: req.data_source_id }),
      );
    }
    save('users-list.json', await raw.users.list({}));
    expect(existsSync(path.join(FIXTURES, 'page-documents.json'))).toBe(true);
  });
});
