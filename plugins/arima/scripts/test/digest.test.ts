// WP-130: the daily digest (spec 12.1, F05). Health rules at their boundaries, lists capped at ten,
// the template's order, idempotent rebuilds, a secret blocks the page, the command's exit codes.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIGEST_EXIT, runDigestCli } from '../src/cli/digest-cli.js';
import {
  DIGEST_LIST_CAP,
  DIGEST_SECTIONS,
  DigestSecretError,
  buildDigest,
  capList,
  health,
  publishDigest,
  renderDigest,
} from '../src/digest.js';
import { appendEvent, readEvents } from '../src/events.js';
import { appendLedgerRow } from '../src/ledger.js';
import type { LedgerRow } from '../src/ledger.js';
import { outboxDir } from '../src/notion/outbox.js';
import { acquireRunLock } from '../src/runlock.js';
import { PLUGIN_ROOT, project } from './helpers.js';

const NOW = new Date('2026-11-20T12:00:00');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const row = (id: string, properties: Record<string, unknown>, edited = NOW.toISOString()) => ({
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
const ledger = (over: Partial<LedgerRow> = {}): LedgerRow =>
  ({
    run_id: 'r-20261120-0900-01',
    date: '2026-11-20',
    project: 'TAS',
    phase: 4,
    item: 'US-001',
    role: 'developer',
    attempt: 1,
    is_rework: false,
    subtype: 'success',
    num_turns: 5,
    duration_ms: 60_000,
    tokens: { input: 1, output: 1, cache_read: 1, cache_creation: 1 },
    cost_usd: 1,
    budget_usd: 2,
    result: 'pass',
    ...over,
  }) as LedgerRow;

const base = {
  hardStopWaitHours: undefined,
  openP1P2: false,
  dayPct: 0,
  projectPct: 0,
  oldestBlockerHours: undefined,
};

describe('health rules (spec 12.1), at their boundaries', () => {
  it('green with nothing wrong', () => expect(health(base).health).toBe('green'));

  it.each([
    ['a budget at 79.9%', { dayPct: 0.799 }, 'green'],
    ['a budget at exactly 80%', { dayPct: 0.8 }, 'amber'],
    ['the project budget at exactly 80%', { projectPct: 0.8 }, 'amber'],
    ['a budget at 99.9%', { projectPct: 0.999 }, 'amber'],
    ['a budget at exactly 100%', { dayPct: 1 }, 'red'],
    ['the project budget at 100%', { projectPct: 1 }, 'red'],
    ['a blocker of exactly 24 h', { oldestBlockerHours: 24 }, 'green'],
    ['a blocker of 24 h and a minute', { oldestBlockerHours: 24 + 1 / 60 }, 'amber'],
    ['a hard stop waiting exactly 48 h', { hardStopWaitHours: 48 }, 'green'],
    ['a hard stop waiting 48 h and a minute', { hardStopWaitHours: 48 + 1 / 60 }, 'red'],
    ['a hard stop waiting 30 h', { hardStopWaitHours: 30 }, 'green'],
    ['an open P1 or P2 incident', { openP1P2: true }, 'red'],
  ] as const)('%s is %s', (_name, over, want) => {
    expect(health({ ...base, ...over }).health).toBe(want);
  });

  it('red wins over amber, and every reason is named', () => {
    const h = health({ ...base, openP1P2: true, dayPct: 0.9, oldestBlockerHours: 30 });
    expect(h.health).toBe('red');
    expect(h.reasons.join(' ')).toMatch(/P1/);
  });
});

describe('capList', () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ line: `item ${i}`, weight: i }));
  it('shows ten, heaviest first, then "and N more"', () => {
    const out = capList(items(13));
    expect(out).toHaveLength(DIGEST_LIST_CAP + 1);
    expect(out[0]).toBe('- item 12');
    expect(out[9]).toBe('- item 3');
    expect(out[10]).toMatch(/and 3 more/);
  });
  it('exactly ten has no overflow line; fewer shows all', () => {
    expect(capList(items(10))).toHaveLength(10);
    expect(capList(items(2))).toEqual(['- item 1', '- item 0']);
    expect(capList([])).toEqual([]);
  });
});

describe('the digest of a project', () => {
  it('an empty project still builds: zero spend, green, every section present', () => {
    const dir = project();
    const m = buildDigest(dir, NOW);
    expect(m.health).toBe('green');
    expect(Object.keys(m.sections)).toEqual([...DIGEST_SECTIONS]);
    expect(m.sections['Awaiting you']).toEqual(['Nothing waits for you.']);
    expect(m.sections['Cost and time'].join(' ')).toContain('estimated consumption');
    expect(m.numbers).toEqual({ spendToday: 0, monthToDate: 0 });
    expect(m.headline).toMatch(/health green/);
  });

  it('the page has the template headings in the template order, and says when it was built', () => {
    const dir = project();
    const text = renderDigest(buildDigest(dir, NOW), PLUGIN_ROOT);
    const tpl = [
      ...readFileSync(path.join(PLUGIN_ROOT, 'templates', 'digest.md'), 'utf8').matchAll(
        /^## (.+)$/gm,
      ),
    ].map((x) => x[1]);
    expect([...text.matchAll(/^## (.+)$/gm)].map((x) => x[1])).toEqual(tpl);
    expect(tpl).toEqual([...DIGEST_SECTIONS]);
    expect(text).toContain('# Daily digest 2026-11-20');
    expect(text).toContain('Built 2026-11-20');
  });

  it('a gate waiting more than 48 h is red; at 30 h it is only a waiting item', () => {
    const a = project();
    mirror(a, 'gates', [row('G1', { Status: 'Ready for review' }, hoursAgo(49))]);
    expect(buildDigest(a, NOW).health).toBe('red');
    const b = project();
    mirror(b, 'gates', [row('G1', { Status: 'Ready for review' }, hoursAgo(30))]);
    const m = buildDigest(b, NOW);
    expect(m.health).toBe('green');
    expect(m.sections['Awaiting you'][0]).toMatch(
      /Gate G1 is ready for your decision \(waiting 30 h\)/,
    );
  });

  it('a blocked story older than 24 h is amber, with its reason and age', async () => {
    const dir = project();
    mirror(dir, 'stories', [
      row('US-007', { Status: 'Blocked', 'Blocked reason': 'Q-003: which payment provider?' }),
    ]);
    await appendEvent(dir, {
      type: 'item.status',
      actor: 'engine',
      item: 'US-007',
      ts: hoursAgo(25),
      data: { from: 'In Progress', to: 'Blocked' },
    });
    const m = buildDigest(dir, NOW);
    expect(m.health).toBe('amber');
    expect(m.sections['Blockers and risks'].join('\n')).toMatch(
      /US-007 blocked: Q-003: which payment provider\? \(waiting 25 h\)/,
    );
  });

  it('an open P1 incident is red and listed first among the blockers', () => {
    const dir = project();
    mirror(dir, 'incidents', [row('INC-001', { Priority: 'P1', Status: 'Open' })]);
    const m = buildDigest(dir, NOW);
    expect(m.health).toBe('red');
    expect(m.sections['Blockers and risks'][1]).toMatch(/INC-001 \(P1\)/);
  });

  it('spend: the day against the daily budget (15), month to date beside lifetime against the cap, top three items, rework share', async () => {
    const dir = project();
    for (const r of [
      ledger({ item: 'US-001', cost_usd: 6 }),
      ledger({ item: 'US-002', cost_usd: 3, is_rework: true }),
      ledger({ item: 'US-003', cost_usd: 2 }),
      ledger({ item: 'US-004', cost_usd: 1 }),
      ledger({ item: 'US-005', cost_usd: 5, date: '2026-10-30' }),
    ])
      await appendLedgerRow(dir, r);
    const m = buildDigest(dir, NOW);
    const cost = m.sections['Cost and time'].join('\n');
    expect(m.numbers).toEqual({ spendToday: 12, monthToDate: 12 });
    expect(cost).toContain('Today 12 of the 15 USD daily budget (80%)');
    expect(cost).toContain('Month to date 12 USD; lifetime 17 USD of the 500 USD project cap');
    expect(cost).toMatch(/Most expensive items: US-001 6 USD, US-005 5 USD, US-002 3 USD/);
    expect(cost).toContain('Rework share 18%');
    expect(m.health).toBe('amber'); // exactly 80% of the daily budget
  });

  it('run health counts the day: started, succeeded, failed, blocked, retried', async () => {
    const dir = project();
    await appendLedgerRow(dir, ledger({ run_id: 'r-20261120-0900-01' }));
    await appendLedgerRow(dir, ledger({ run_id: 'r-20261120-0900-02', result: 'fail' }));
    await appendLedgerRow(dir, ledger({ run_id: 'r-20261120-0900-03', result: 'blocked' }));
    await appendEvent(dir, {
      type: 'unit.retried',
      actor: 'system',
      ts: '2026-11-20T10:00:00.000Z',
      data: {},
    });
    expect(buildDigest(dir, NOW).sections['Run health'][0]).toBe(
      'Runs started 3, succeeded 1, failed 1, blocked 1, retried 1.',
    );
  });

  it('a list longer than ten shows ten and "and 3 more" (decisions)', () => {
    const dir = project();
    mirror(
      dir,
      'decisions',
      Array.from({ length: 13 }, (_, i) =>
        row(`DEC-${String(i + 1).padStart(4, '0')}`, {
          Summary: `choice ${i}`,
          Chosen: 'A',
          Date: '2026-11-20',
        }),
      ),
    );
    const lines = buildDigest(dir, NOW).sections['Decisions made'];
    expect(lines).toHaveLength(11);
    expect(lines[10]).toMatch(/and 3 more/);
    expect(lines[0]).toContain('[ ] veto DEC-');
  });

  it('shipped lists a story once, when it reaches staging (PO Acceptance), not again at Done', async () => {
    const dir = project();
    await appendEvent(dir, {
      type: 'pr.published',
      actor: 'system',
      item: 'US-001',
      data: { pr: 4 },
    });
    await appendEvent(dir, {
      type: 'item.status',
      actor: 'merge-script',
      item: 'US-001',
      data: { from: 'In QA', to: 'PO Acceptance' },
    });
    await appendEvent(dir, {
      type: 'item.status',
      actor: 'orchestrator',
      item: 'US-001',
      data: { from: 'PO Acceptance', to: 'Done' },
    });
    expect(buildDigest(dir, new Date()).sections.Shipped).toEqual([
      '- US-001 reached PO Acceptance (PR #4)',
    ]);
  });

  it('is read-only: the ledger, the mirror and the events are not changed by building', async () => {
    const dir = project();
    mirror(dir, 'gates', [row('G1', { Status: 'Ready for review' })]);
    await appendLedgerRow(dir, ledger());
    const snap = (): string =>
      ['ledger.jsonl', 'events.jsonl', 'mirror/gates.json']
        .map((f) => {
          try {
            return readFileSync(path.join(dir, '.arima', f), 'utf8');
          } catch {
            return '';
          }
        })
        .join('|');
    const before = snap();
    buildDigest(dir, NOW);
    expect(snap()).toBe(before);
  });
});

describe('publishing', () => {
  it('writes the local copy and queues one create with the page body; a rebuild updates and appends, and never duplicates', async () => {
    const dir = project();
    const m = buildDigest(dir, NOW);
    const first = await publishDigest({
      projectDir: dir,
      runId: 'r-20261120-1200-01',
      model: m,
      now: NOW,
      root: PLUGIN_ROOT,
    });
    expect(first.created).toBe(true);
    expect(readFileSync(first.file, 'utf8')).toContain('## Headline');
    const queued = (): Record<string, unknown>[] =>
      readdirSync(outboxDir(dir))
        .filter((f) => f.endsWith('.json'))
        .map(
          (f) =>
            JSON.parse(readFileSync(path.join(outboxDir(dir), f), 'utf8')) as Record<
              string,
              unknown
            >,
        );
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ op: 'create', database: 'digests', role: 'orchestrator' });
    expect((queued()[0]!['properties'] as Record<string, unknown>)['Date']).toBe('2026-11-20');
    expect(queued()[0]!['content_markdown']).toContain('## Awaiting you');
    expect(Object.keys(queued()[0]!['properties'] as object)).not.toEqual(
      expect.arrayContaining(['Reviewed by']),
    );
    expect(Object.keys(queued()[0]!['properties'] as object)).not.toContain('Minutes spent');
    // the row exists now (after a push and pull): a rebuild is an update plus an appended section
    mirror(dir, 'digests', [row('2026-11-20', { Date: '2026-11-20' })]);
    const again = await publishDigest({
      projectDir: dir,
      runId: 'r-20261120-1300-01',
      model: m,
      now: new Date(NOW.getTime() + 3_600_000),
      root: PLUGIN_ROOT,
    });
    expect(again.created).toBe(false);
    const ops = queued()
      .map((e) => e['op'])
      .sort();
    expect(ops).toEqual(['append_content', 'create', 'update']);
    expect(readEvents(dir).filter((e) => e.type === 'digest.published')).toHaveLength(2);
  });

  it('a secret anywhere in the page stops it: nothing is written, nothing is queued', async () => {
    const dir = project();
    mirror(dir, 'decisions', [
      row('DEC-0001', {
        Summary: 'use token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
        Chosen: 'A',
        Date: '2026-11-20',
      }),
    ]);
    const m = buildDigest(dir, NOW);
    await expect(
      publishDigest({
        projectDir: dir,
        runId: 'r-20261120-1200-01',
        model: m,
        now: NOW,
        root: PLUGIN_ROOT,
      }),
    ).rejects.toBeInstanceOf(DigestSecretError);
    expect(readdirSync(path.join(dir, '.arima')).includes('digests')).toBe(false);
    expect(readdirSync(path.join(dir, '.arima')).includes('outbox')).toBe(false);
  });
});

describe('arima-digest', () => {
  const cli = async (dir: string, args: string[], now = NOW) => {
    let out = '';
    let err = '';
    const code = await runDigestCli(
      [...args, '--project', dir],
      { out: (s) => (out += s), err: (s) => (err += s), cwd: dir },
      { now, lock: { sleep: () => Promise.resolve(), maxWaitMs: 0 } },
    );
    return { code, out, err };
  };

  it('builds, writes the copy, queues the row (exit 0); --no-push writes only the copy', async () => {
    const dir = project();
    const a = await cli(dir, []);
    expect(a.code, a.err).toBe(DIGEST_EXIT.ok);
    expect(a.out).toContain('queued the Notion row');
    expect(readdirSync(path.join(dir, '.arima', 'digests'))).toEqual(['2026-11-20.md']);
    const b = project();
    const r = await cli(b, ['--no-push']);
    expect(r.code).toBe(0);
    expect(readdirSync(path.join(b, '.arima')).includes('outbox')).toBe(false);
  });

  it("bad or future dates are exit 2; a past date is built from that date's ledger rows", async () => {
    const dir = project();
    expect((await cli(dir, ['--date', '2026-13-45x'])).code).toBe(DIGEST_EXIT.usage);
    expect((await cli(dir, ['--date', '2026-12-01'])).code).toBe(DIGEST_EXIT.usage);
    await appendLedgerRow(dir, ledger({ date: '2026-11-18', cost_usd: 4 }));
    const r = await cli(dir, ['--date', '2026-11-18', '--no-push', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).sections['Cost and time'].join(' ')).toContain(
      'Today 4 of the 15 USD',
    );
  });

  it('exit 10 for a bad config, exit 11 while a run holds the lock (the digest page itself still builds with --no-push)', async () => {
    const bad = project({ arima: [['profile: client-project', 'profile: nonsense']] });
    expect((await cli(bad, [])).code).toBe(DIGEST_EXIT.config);
    const dir = project();
    acquireRunLock(dir, 'r-20261120-0900-09', 3_600_000);
    expect((await cli(dir, [])).code).toBe(DIGEST_EXIT.locked);
    expect((await cli(dir, ['--no-push'])).code).toBe(DIGEST_EXIT.ok);
  });
});
