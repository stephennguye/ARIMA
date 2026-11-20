// WP-142: @mentions. Each item awaiting a person gets one mention on its own page; the urgent cases go to the
// Urgent page; once per state an item waits in; a missing Notion user id skips instead of guessing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { createNotionPort } from '../src/notion/port.js';
import {
  MAX_PER_RUN,
  URGENT_PAGE,
  collectNotices,
  ownersOf,
  readSent,
  sendNotifications,
} from '../src/notify.js';
import { project } from './helpers.js';
import { FakeNotion } from './fake-notion.js';

const PO = '11111111-1111-4111-8111-111111111111';
const SPONSOR = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-20T12:00:00Z');

const row = (id: string, properties: Record<string, unknown>, edited = 't1') => ({
  page_id: `p-${id}`,
  last_edited_time: edited,
  id,
  properties,
});
const mirror = (dir: string, db: string, rows: unknown[]): void => {
  mkdirSync(path.join(dir, '.arima', 'mirror'), { recursive: true });
  writeFileSync(
    path.join(dir, '.arima', 'mirror', `${db}.json`),
    JSON.stringify({ database: db, rows }),
  );
};
/** A project whose po and sponsor have real-looking Notion user ids. */
function withOwners() {
  return project({
    team: [
      ['notion_user: "<notion user id>"', `notion_user: "${PO}"`],
      ['notion_user: "<notion user id>"', `notion_user: "${SPONSOR}"`],
    ],
  });
}
async function notion() {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  return { fake, port };
}
const text = (c: { rich_text: unknown[] }): string =>
  (c.rich_text as { text?: { content: string } }[]).map((r) => r.text?.content ?? '').join('');
const mentions = (c: { rich_text: unknown[] }): string[] =>
  (c.rich_text as { mention?: { user: { id: string } } }[]).flatMap((r) =>
    r.mention ? [r.mention.user.id] : [],
  );

describe('who is mentioned', () => {
  it('po first, sponsor too; a placeholder id is not a person', () => {
    expect(ownersOf(withOwners())).toEqual({ po: [PO], both: [PO, SPONSOR] });
    expect(ownersOf(project())).toEqual({ po: [], both: [] });
  });
});

describe('collectNotices', () => {
  it("one notice per item awaiting a person, on the item's own page, naming what it needs", () => {
    const dir = withOwners();
    mirror(dir, 'gates', [
      row('G1', { Status: 'Ready for review' }),
      row('G2', { Status: 'Not ready' }),
    ]);
    mirror(dir, 'releases', [row('v1.0.0', { Status: 'Awaiting approval' })]);
    mirror(dir, 'change_requests', [
      row('CR-001', { Decision: 'Pending' }),
      row('CR-002', { Decision: 'Approved' }),
    ]);
    const n = collectNotices({ projectDir: dir, urgentPageId: 'urgent' });
    expect(n.map((x) => [x.pageId, x.kind, x.who.length])).toEqual([
      ['p-G1', 'awaiting', 2],
      ['p-v1.0.0', 'awaiting', 2],
      ['p-CR-001', 'awaiting', 1],
    ]);
    expect(n[0]?.text).toBe('Gate G1 is ready for your decision.');
  });

  it('a PR that passed QA awaits the po, with its number; a story QA has not passed does not', async () => {
    const dir = withOwners();
    mirror(dir, 'stories', [
      row('US-001', { Status: 'In QA' }),
      row('US-002', { Status: 'In QA' }),
    ]);
    await appendEvent(dir, {
      type: 'pr.published',
      actor: 'system',
      item: 'US-001',
      data: { pr: 7 },
    });
    await appendEvent(dir, {
      type: 'report.accepted',
      actor: 'system',
      item: 'US-001',
      run_id: 'r-1',
      data: { role: 'qa', kind: 'qa', verdict: 'pass' },
    });
    await appendEvent(dir, {
      type: 'pr.published',
      actor: 'system',
      item: 'US-002',
      data: { pr: 8 },
    });
    const n = collectNotices({ projectDir: dir, urgentPageId: 'u' });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ pageId: 'p-US-001', who: [PO] });
    expect(n[0]?.text).toContain('#7');
  });

  it('urgent: a P1 or P2 incident, a hotfix approval while one is open, a red health day; a P3 is not urgent', () => {
    const dir = withOwners();
    mirror(dir, 'incidents', [
      row('INC-001', { Priority: 'P1', Status: 'Open' }),
      row('INC-002', { Priority: 'P3', Status: 'Open' }),
      row('INC-003', { Priority: 'P2', Status: 'Resolved' }),
    ]);
    mirror(dir, 'releases', [row('v1.0.1', { Status: 'Awaiting approval' })]);
    const n = collectNotices({
      projectDir: dir,
      urgentPageId: 'urgent',
      redHealth: { date: '2026-11-20', reasons: ['an open P1 or P2 incident'] },
    });
    const urgent = n.filter((x) => x.kind === 'urgent');
    expect(urgent.map((x) => x.key.split(':').slice(0, 2).join(':')).sort()).toEqual([
      'urgent:health',
      'urgent:hotfix',
      'urgent:incident',
    ]);
    expect(urgent.every((x) => x.pageId === 'urgent' && x.who.length === 2)).toBe(true);
    expect(urgent.find((x) => x.key.startsWith('urgent:incident'))?.text).toContain('INC-001');
    // no incident open: a release awaiting approval is an ordinary item, not a hotfix
    const calm = withOwners();
    mirror(calm, 'releases', [row('v1.0.1', { Status: 'Awaiting approval' })]);
    expect(
      collectNotices({ projectDir: calm, urgentPageId: 'urgent' }).filter(
        (x) => x.kind === 'urgent',
      ),
    ).toEqual([]);
  });
});

describe('sendNotifications', () => {
  it('posts one comment per item with the mention first, and the Urgent page under the root, created once', async () => {
    const dir = withOwners();
    const { fake, port } = await notion();
    mirror(dir, 'gates', [row('G1', { Status: 'Ready for review' })]);
    mirror(dir, 'incidents', [row('INC-001', { Priority: 'P1', Status: 'Open' })]);
    const r = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId, now: NOW });
    expect(r.failed).toEqual([]);
    expect(r.sent.map((s) => s.kind).sort()).toEqual(['awaiting', 'urgent']);
    expect(fake.comments).toHaveLength(2);
    const gate = fake.comments.find((c) => c.pageId === 'p-G1')!;
    expect(mentions(gate)).toEqual([PO, SPONSOR]);
    expect(text(gate)).toContain('Gate G1 is ready for your decision.');
    const pages = fake.pages
      .get(fake.rootId)!
      .filter((b) => (b as { type: string }).type === 'child_page');
    expect(pages).toHaveLength(1);
    expect((pages[0] as unknown as { child_page: { title: string } }).child_page.title).toBe(
      URGENT_PAGE,
    );
    const urgent = fake.comments.find((c) => c.pageId !== 'p-G1')!;
    expect(text(urgent)).toContain('URGENT: incident INC-001 (P1)');
  });

  it('says it once per state: a second pass sends nothing, a changed state sends again', async () => {
    const dir = withOwners();
    const { fake, port } = await notion();
    mirror(dir, 'gates', [row('G1', { Status: 'Ready for review' }, 't1')]);
    await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId, now: NOW });
    expect(
      (await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId, now: NOW })).sent,
    ).toEqual([]);
    expect(fake.comments).toHaveLength(1);
    expect(Object.keys(readSent(dir))).toEqual(['gate:G1:t1']);
    mirror(dir, 'gates', [row('G1', { Status: 'Ready for review' }, 't2')]); // edited and back in the queue
    expect(
      (await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId, now: NOW })).sent,
    ).toHaveLength(1);
    expect(fake.comments).toHaveLength(2);
  });

  it('a person with no Notion user id is skipped with the reason, nothing is posted, nothing is recorded', async () => {
    const dir = project();
    const { fake, port } = await notion();
    mirror(dir, 'gates', [row('G1', { Status: 'Ready for review' })]);
    const r = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId });
    expect(r.sent).toEqual([]);
    expect(r.skipped[0]).toMatch(/no Notion user id/);
    expect(fake.comments).toEqual([]);
    expect(readSent(dir)).toEqual({});
  });

  it('when comments are not allowed the mention goes into the page as a paragraph (the Urgent page), and the key is still recorded', async () => {
    const dir = withOwners();
    const { fake, port } = await notion();
    fake.failNext = { op: 'comments.create', status: 403, message: 'insufficient permissions' };
    mirror(dir, 'incidents', [row('INC-001', { Priority: 'P1', Status: 'Open' })]);
    const r = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId, now: NOW });
    expect(r.sent[0]?.via).toBe('page');
    expect(fake.comments).toEqual([]);
    const urgentId = (
      fake.pages.get(fake.rootId)!.find((b) => (b as { type: string }).type === 'child_page') as {
        id: string;
      }
    ).id;
    const blocks = fake.pages.get(urgentId)!;
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks[0])).toContain('URGENT: incident INC-001');
    expect(Object.keys(readSent(dir))).toHaveLength(1);
  });

  it('a failure on one item does not stop the others, and a failed key is retried next time', async () => {
    const dir = withOwners();
    const { fake, port } = await notion();
    mirror(dir, 'gates', [
      row('G1', { Status: 'Ready for review' }),
      row('G2', { Status: 'Ready for review' }),
    ]);
    fake.failNext = { op: 'comments.create', status: 500 }; // the first comment fails, then falls back to the page, which also works
    const a = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId, now: NOW });
    expect(a.sent.length + a.failed.length).toBe(2);
    const b = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId, now: NOW });
    expect(Object.keys(readSent(dir)).sort()).toEqual(['gate:G1:t1', 'gate:G2:t1']);
    expect(a.sent.length + b.sent.length).toBe(2);
  });

  it(`sends at most ${MAX_PER_RUN} in one run; the rest wait for the next`, async () => {
    const dir = withOwners();
    const { fake, port } = await notion();
    mirror(
      dir,
      'gates',
      Array.from({ length: MAX_PER_RUN + 5 }, (_, i) =>
        row(`G${i}`, { Status: 'Ready for review' }),
      ),
    );
    const a = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId });
    expect(a.sent).toHaveLength(MAX_PER_RUN);
    expect(a.skipped).toHaveLength(5);
    const b = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId });
    expect(b.sent).toHaveLength(5);
  });

  it('--dry-run posts and records nothing, and makes no Urgent page', async () => {
    const dir = withOwners();
    const { fake, port } = await notion();
    mirror(dir, 'incidents', [row('INC-001', { Priority: 'P1', Status: 'Open' })]);
    const r = await sendNotifications({
      projectDir: dir,
      port,
      rootPageId: fake.rootId,
      dryRun: true,
    });
    expect(r.sent).toHaveLength(1);
    expect(fake.comments).toEqual([]);
    expect(
      fake.pages.get(fake.rootId)!.some((b) => (b as { type: string }).type === 'child_page'),
    ).toBe(false);
    expect(readSent(dir)).toEqual({});
  });

  it('text that looks like a secret is never posted (a quoted question)', async () => {
    const dir = withOwners();
    const { fake, port } = await notion();
    mkdirSync(path.join(dir, '.arima', 'state'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'state', 'questions.json'),
      JSON.stringify({
        schema_version: 1,
        questions: {
          'Q-001': {
            raised_by: 'developer',
            run_id: 'r-1',
            item: 'none',
            question: 'use ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' + ' ?',
            route: 'owner',
            blocking: true,
            status: 'open',
            created_at: NOW.toISOString(),
          },
        },
      }),
    );
    mirror(dir, 'questions', [row('Q-001', { Status: 'Open' })]);
    const r = await sendNotifications({ projectDir: dir, port, rootPageId: fake.rootId });
    expect(r.sent).toEqual([]);
    expect(r.skipped.join()).toMatch(/secret/);
    expect(fake.comments).toEqual([]);
    expect(
      readFileSync(path.join(dir, '.arima', 'state', 'questions.json'), 'utf8').length,
    ).toBeGreaterThan(0);
  });
});
