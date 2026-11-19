// v0.1 eval (spec §15.4): /arima:init on a sample brief against a mocked Notion, checked against
// expected.json. Run with `npm run eval`. No network, no model calls, no cost.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readEvents } from '../../plugins/arima/scripts/src/events.js';
import { handleHook } from '../../plugins/arima/scripts/src/hooks.js';
import { init, setup } from './support.js';

const expected = JSON.parse(readFileSync(path.join(import.meta.dirname, 'expected.json'), 'utf8')) as {
  databases: number;
  documents: string[];
  gates: string[];
  gate_status: string;
  g0_checklist: { total: number; checked: string[] };
  ledger: Record<string, unknown>;
  events_include: string[];
  notion_push_events: number;
  state_branch_files: string[];
  status: { phase: string; gates: number; runs: number };
  hard_stops: {
    kill_switch_preflight_exit: number;
    human_only_refused: { database: string; property: string }[];
    notion_delete_blocked: boolean;
    secret_file_blocked: boolean;
    mirror_write_blocked: boolean;
  };
};

const cleanup: string[] = [];
afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('v0.1: /arima:init on the sample brief', async () => {
  const w = await setup(path.join(import.meta.dirname, 'brief.md'));
  cleanup.push(w.dir);
  const result = await init(w);
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: w.dir, encoding: 'utf8' }).trim();

  it('succeeds with no gaps or problems', () => {
    expect(result).toMatchObject({ ok: true, exitCode: 0, gaps: [], problems: [] });
  });

  it('maps all databases and writes the required Notion pages', async () => {
    const { readNotionMap } = await import('../../plugins/arima/scripts/src/notion/mirror.js');
    expect(Object.keys(readNotionMap(w.dir).databases)).toHaveLength(expected.databases);
    for (const title of expected.documents) expect(w.fake.rowByTitle('Documents', title), title).toBeDefined();
    for (const g of expected.gates) {
      const row = w.fake.rowByTitle('Gates', g);
      expect(row, g).toBeDefined();
      expect(row?.properties['Status']).toMatchObject({ select: { name: expected.gate_status } });
    }
  });

  it('opens the G0 page with its evidence-pack checklist', () => {
    const blocks = w.fake.pages.get(w.fake.rowByTitle('Gates', 'G0')!.id)!.filter((b) => b.type === 'to_do');
    expect(blocks).toHaveLength(expected.g0_checklist.total);
    const checked = blocks
      .map((b) => b['to_do'] as { rich_text: { plain_text: string }[]; checked: boolean })
      .filter((t) => t.checked)
      .map((t) => t.rich_text[0]?.plain_text);
    expect(checked).toEqual(expected.g0_checklist.checked);
  });

  it('leaves a valid ledger row and event log, committed to the arima-state branch', async () => {
    const { readLedger } = await import('../../plugins/arima/scripts/src/ledger.js');
    const rows = readLedger(w.dir);
    expect(rows).toHaveLength(expected.ledger['rows'] as number);
    const { rows: _n, ...fields } = expected.ledger;
    void _n;
    expect(rows[0]).toMatchObject(fields);
    const types = readEvents(w.dir).map((e) => e.type);
    for (const t of expected.events_include) expect(types, t).toContain(t);
    expect(types.filter((t) => t === 'notion.push')).toHaveLength(expected.notion_push_events);
    const files = git('ls-tree', '-r', '--name-only', 'arima-state').split('\n');
    for (const f of expected.state_branch_files) expect(files, f).toContain(f);
  });

  it('/arima:status reports the expected state', async () => {
    const { buildStatus } = await import('../../plugins/arima/scripts/src/status.js');
    const s = buildStatus(w.dir);
    expect(s.phase).toBe(expected.status.phase);
    expect(s.gates).toHaveLength(expected.status.gates);
    expect(s.runs.total).toBe(expected.status.runs);
  });
});

describe('v0.1: hard stops are respected (spec §11.1)', async () => {
  const w = await setup(path.join(import.meta.dirname, 'brief.md'));
  cleanup.push(w.dir);
  await init(w);

  it('the kill switch stops the next run at preflight', async () => {
    const { setKillSwitch } = await import('../../plugins/arima/scripts/src/pause.js');
    const { runPreflight } = await import('../../plugins/arima/scripts/src/preflight.js');
    await setKillSwitch({ projectDir: w.dir, on: true, notion: { port: w.port, rootPageId: w.fake.rootId } });
    const pre = await runPreflight({ projectDir: w.dir, env: w.env, notion: w.port });
    expect(pre.exitCode).toBe(expected.hard_stops.kill_switch_preflight_exit);
    await setKillSwitch({ projectDir: w.dir, on: false, notion: { port: w.port, rootPageId: w.fake.rootId } });
  });

  it('an agent cannot write human-only fields through the outbox', async () => {
    const { enqueue, pushOutbox } = await import('../../plugins/arima/scripts/src/notion/outbox.js');
    const { readNotionMap } = await import('../../plugins/arima/scripts/src/notion/mirror.js');
    // WP-104: an outbox entry must belong to a run the engine started.
    const { appendEvent } = await import('../../plugins/arima/scripts/src/events.js');
    await appendEvent(w.dir, { type: 'run.start', actor: 'orchestrator', run_id: 'r-20261118-0500-01' });
    for (const [i, { database, property }] of expected.hard_stops.human_only_refused.entries()) {
      enqueue(w.dir, {
        id: `eval-${i}`,
        created_at: '2026-11-18T05:00:00.000Z',
        run_id: 'r-20261118-0500-01',
        role: 'orchestrator',
        op: 'update',
        database: database as 'gates',
        item_id: 'G1',
        properties: { [property]: ['someone'] },
      });
    }
    const report = await pushOutbox(w.dir, w.port, readNotionMap(w.dir));
    expect(report.applied).toEqual([]);
    expect(report.rejected[0]?.reason).toMatch(/human-only/);
  });

  it('delete, secrets and the mirror are guarded by hooks', async () => {
    const pre = (tool: string, input: Record<string, unknown>) =>
      handleHook('pre-tool-use', { tool_name: tool, tool_input: input, cwd: w.dir }, {});
    expect((await pre('mcp__notion__delete_page', {})).exitCode === 2).toBe(expected.hard_stops.notion_delete_blocked);
    expect((await pre('Read', { file_path: '.env' })).exitCode === 2).toBe(expected.hard_stops.secret_file_blocked);
    expect((await pre('Write', { file_path: '.arima/mirror/stories.json', content: '{}' })).exitCode === 2).toBe(
      expected.hard_stops.mirror_write_blocked,
    );
  });
});
