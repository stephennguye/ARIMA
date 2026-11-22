// LIVE tier (WP-211): the records a QA run proposes reach the real Notion dev workspace through the real
// outbox: test cases and a bug linked to a story by id, the severity rule applied, the engine (not QA) owning
// every id and Status. Never part of `npm test` or CI.
//
//   ARIMA_LIVE=1 ARIMA_NOTION_TOKEN=... ARIMA_LIVE_PROJECT=D:\GitHub\arima-dev npm run test:live -- qa-records
//
// It adds two Test Cases rows and one Bug row (the bug is retired at the end; test cases have no retire
// status and stay), and deletes nothing.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import { readMirror, pullMirror, readNotionMap } from '../src/notion/mirror.js';
import { enqueue, pushOutbox } from '../src/notion/outbox.js';
import { createNotionPortFromToken } from '../src/notion/port.js';
import { enqueueReportRecords } from '../src/notion/proposals.js';
import type { AgentReport } from '../src/report.js';
import { tempDir } from '../test/helpers.js';

const token = process.env['ARIMA_NOTION_TOKEN'];
const projectDir = process.env['ARIMA_LIVE_PROJECT'];
const LIVE = process.env['ARIMA_LIVE'] === '1' && !!token && !!projectDir;
const RUN = 'r-20261122-1000-01';

describe.skipIf(!LIVE)('QA records in the real Notion dev workspace', () => {
  it('test cases and a bug are created with engine ids, linked to the story, severity lowered, Status untouched', async () => {
    const map = readNotionMap(projectDir as string);
    const port = createNotionPortFromToken(token as string);
    const dir = tempDir('arima-live-qa-');
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    copyFileSync(
      path.join(projectDir as string, '.arima', 'notion-map.json'),
      path.join(dir, '.arima', 'notion-map.json'),
    );
    await pullMirror(dir, port, map);
    const story = readMirror(dir, 'stories')?.rows.find((r) => r.id === 'US-005');
    expect(story, 'the dev workspace has no story US-005 to link to').toBeDefined();

    await appendEvent(dir, { type: 'run.start', actor: 'qa', run_id: RUN, item: 'US-005' });
    const report: AgentReport = {
      schema_version: 1,
      run_id: RUN,
      role: 'qa',
      item: 'US-005',
      status: 'done',
      summary: 'live check',
      records: [
        {
          database: 'test_cases',
          ref: 'NEW-1',
          properties: {
            Title: 'NEW-1',
            Type: 'e2e',
            Automated: true,
            'Last result': 'Not run',
            'Test path': 'tests/e2e/us-005.test.js',
            Story: 'US-005',
          },
        },
        {
          database: 'bugs',
          ref: 'NEW-2',
          reproductions: 1,
          properties: {
            Title: 'NEW-2',
            Severity: 'S1',
            Environment: 'preview',
            'Found by': 'qa',
            Steps: 'open /cart',
            Expected: '9.00',
            Actual: '9 (tests/.evidence/NEW-1/out.txt)',
            Story: 'US-005',
          },
        },
      ],
    };
    const enq = await enqueueReportRecords({ projectDir: dir, runId: RUN, role: 'qa', report });
    expect(enq.entries).toHaveLength(2);
    const [tcId, bugId] = [enq.ids['NEW-1'] as string, enq.ids['NEW-2'] as string];
    expect(tcId).toMatch(/^TC-\d+$/);
    expect(bugId).toMatch(/^BUG-\d+$/);

    const pushed = await pushOutbox(dir, port, map);
    expect(pushed.rejected, JSON.stringify(pushed)).toEqual([]);
    expect(pushed.applied).toHaveLength(2);

    await pullMirror(dir, port, map);
    const tc = readMirror(dir, 'test_cases')?.rows.find((r) => r.id === tcId);
    const bug = readMirror(dir, 'bugs')?.rows.find((r) => r.id === bugId);
    expect(tc?.properties['Last result']).toBe('Not run');
    expect(tc?.properties['Story']).toEqual([story?.page_id]);
    expect(bug?.properties['Severity']).toBe('S3');
    expect(String(bug?.properties['Actual'])).toContain('severity lowered from S1 to S3');
    expect(bug?.properties['Found by']).toBe('qa');
    expect(bug?.properties['Story']).toEqual([story?.page_id]);
    // The engine, not QA, owns Status: QA proposed none, so the row carries the database default (or none), never a QA value.
    expect(['Open', undefined, null, '']).toContain(bug?.properties['Status'] as never);

    // Clean up what can be: retire the bug (Cancelled). Test cases have no retire status and stay.
    enqueue(dir, {
      id: 'live-qa-retire-0001',
      created_at: new Date().toISOString(),
      run_id: RUN,
      role: 'orchestrator',
      op: 'retire',
      database: 'bugs',
      item_id: bugId,
    });
    const retired = await pushOutbox(dir, port, map, { bindRuns: false });
    expect(retired.applied).toEqual(['live-qa-retire-0001']);
  });
});
