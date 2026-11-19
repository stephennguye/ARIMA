// WP-103: the report collector in the run wrapper (03-contracts 3.3, spec 7.12).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../src/events.js';
import { readLedger } from '../src/ledger.js';
import { collectReport, extractReport, reportFile } from '../src/report-collector.js';
import { allowedTools } from '../src/roles.js';
import { ROLES } from '../src/roles.js';
import { runAgent, runUnit } from '../src/run-agent.js';
import type { AgentConfig, RunAgentOptions } from '../src/run-agent.js';
import { tempDir } from './helpers.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');
const FENCE = '```';

const goodReport = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  run_id: '__RUN_ID__',
  role: 'developer',
  item: 'US-112',
  status: 'done',
  summary: 'Cart summary implemented.',
  criteria_map: [{ criterion: 'AC-1', status: 'met', evidence: ['src/cart/summary.ts:41'] }],
  ...over,
});
const block = (r: Record<string, unknown>): string =>
  `Work finished.\n\n${FENCE}arima-report\n${JSON.stringify(r, null, 2)}\n${FENCE}\n`;

describe('extractReport', () => {
  it('finds exactly one arima-report block', () => {
    expect(extractReport(`text\n${FENCE}arima-report\n{"a":1}\n${FENCE}\n`)).toEqual({
      json: '{"a":1}',
    });
  });
  it('rejects none, several and an unclosed block', () => {
    expect(extractReport('no block here').error).toMatch(/no arima-report block/);
    expect(extractReport(`${FENCE}json\n{}\n${FENCE}`).error).toMatch(/no arima-report block/);
    const one = `${FENCE}arima-report\n{}\n${FENCE}\n`;
    expect(extractReport(one + one).error).toMatch(/2 arima-report blocks/);
    expect(extractReport(`${FENCE}arima-report\n{}\n`).error).toMatch(/never closed/);
  });
  it('a report quoted inside a longer fence does not count', () => {
    const quoted = `\`\`\`\`text\n${FENCE}arima-report\n{}\n${FENCE}\n\`\`\`\`\n`;
    expect(extractReport(quoted).error).toMatch(/no arima-report block/);
  });
});

describe('collectReport', () => {
  const input = (
    message: string | undefined,
    over: Partial<Parameters<typeof collectReport>[0]> = {},
  ) => ({
    projectDir: tempDir(),
    runId: 'r-20261119-0900-01',
    role: 'developer' as const,
    kind: 'develop' as const,
    item: 'US-112',
    message,
    ...over,
  });
  const withId = (r: Record<string, unknown>): string =>
    block({ ...r, run_id: 'r-20261119-0900-01' });

  it('stores a valid report and records report.accepted', async () => {
    const i = input(withId(goodReport()));
    const c = await collectReport(i);
    expect(c.ok).toBe(true);
    expect(JSON.parse(readFileSync(reportFile(i.projectDir, i.runId), 'utf8'))).toMatchObject({
      status: 'done',
    });
    expect(readEvents(i.projectDir).map((e) => e.type)).toEqual(['report.accepted']);
  });

  it('a missing report is report_invalid and nothing is stored', async () => {
    for (const msg of [undefined, '', 'All done, no block.']) {
      const i = input(msg);
      const c = await collectReport(i);
      expect(c).toMatchObject({ ok: false, reason: 'report_invalid' });
      expect(existsSync(reportFile(i.projectDir, i.runId))).toBe(false);
      expect(readEvents(i.projectDir).map((e) => e.type)).toEqual(['report.rejected']);
    }
  });

  it('invalid JSON, a wrong shape and a wrong run id or item are report_invalid', async () => {
    expect(await collectReport(input(`${FENCE}arima-report\n{nope\n${FENCE}\n`))).toMatchObject({
      reason: 'report_invalid',
    });
    expect(await collectReport(input(withId({ status: 'done' })))).toMatchObject({
      reason: 'report_invalid',
    });
    const other = await collectReport(input(block(goodReport({ run_id: 'r-20261119-0900-99' }))));
    expect(other.reason).toBe('report_invalid');
    expect(other.errors.join()).toMatch(/run_id/);
    const wrongItem = await collectReport(input(withId(goodReport({ item: 'US-999' }))));
    expect(wrongItem.errors.join()).toMatch(/item/);
  });

  it('a criterion met without evidence is evidence_missing', async () => {
    const r = goodReport({ criteria_map: [{ criterion: 'AC-1', status: 'met', evidence: [] }] });
    expect(await collectReport(input(withId(r)))).toMatchObject({
      ok: false,
      reason: 'evidence_missing',
    });
  });

  it('a message that holds a secret is dropped unread (secret_in_output)', async () => {
    const i = input(`${withId(goodReport({ summary: `token ntn_${'a'.repeat(30)}` }))}`);
    const c = await collectReport(i);
    expect(c.reason).toBe('secret_in_output');
    expect(existsSync(reportFile(i.projectDir, i.runId))).toBe(false);
    expect(JSON.stringify(readEvents(i.projectDir))).not.toContain('ntn_');
  });
});

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  projectKey: 'TAS',
  perRunCap: 2,
  maxRunMinutes: 1,
  notionTokenEnv: 'ARIMA_NOTION_TOKEN',
  projectCap: 100,
  dailyCap: 20,
  ...over,
});

function world(): { dir: string; prompt: string; msg: string; seq: string; counter: string } {
  const dir = tempDir();
  const prompt = path.join(dir, 'prompt.md');
  writeFileSync(prompt, 'Implement US-112.');
  return {
    dir,
    prompt,
    msg: path.join(dir, 'msg.txt'),
    seq: path.join(dir, 'seq.json'),
    counter: path.join(dir, 'n'),
  };
}

const opts = (
  w: ReturnType<typeof world>,
  env: Record<string, string>,
  over: Partial<RunAgentOptions> = {},
): RunAgentOptions => ({
  projectDir: w.dir,
  role: 'developer',
  item: 'US-112',
  budgetUsd: 1,
  maxTurns: 10,
  promptFile: w.prompt,
  phase: 4,
  kind: 'develop',
  config: config(),
  killSwitch: { notion: null },
  claudeBin: STUB,
  env: { ...process.env },
  extraEnv: env,
  now: new Date(2026, 10, 19, 9, 0),
  ...over,
});

describe('runAgent with a unit kind', () => {
  it('a valid report: pass, ledger row, report stored, outcome carries it', async () => {
    const w = world();
    writeFileSync(w.msg, block(goodReport()));
    const o = await runAgent(opts(w, { STUB_MODE: 'message', STUB_MESSAGE_FILE: w.msg }));
    expect(o).toMatchObject({ result: 'pass', exitCode: 0 });
    expect(o.report?.status).toBe('done');
    expect(readLedger(w.dir)).toHaveLength(1);
    expect(readLedger(w.dir)[0]).toMatchObject({ result: 'pass' });
    expect(existsSync(reportFile(w.dir, o.runId))).toBe(true);
    const types = readEvents(w.dir).map((e) => e.type);
    expect(types).toEqual(['run.start', 'report.accepted', 'run.end']);
  });

  it('a missing report: result fail, reason report_invalid, one ledger row, exit 1', async () => {
    const w = world();
    const o = await runAgent(opts(w, { STUB_MODE: 'success' }));
    expect(o).toMatchObject({ result: 'fail', reason: 'report_invalid', exitCode: 1 });
    const rows = readLedger(w.dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'fail', reason: 'report_invalid' });
    expect(existsSync(reportFile(w.dir, o.runId))).toBe(false);
    const run = JSON.parse(
      readFileSync(path.join(w.dir, '.arima', 'runs', `${o.runId}.json`), 'utf8'),
    );
    expect(run.reason).toBe('report_invalid');
    expect(run.report_errors.join()).toMatch(/no arima-report block/);
  });

  it('an invalid report, missing evidence and a secret each fail with their own reason', async () => {
    const cases: [string, string][] = [
      [block(goodReport({ status: 'done', criteria_map: undefined })), 'report_invalid'],
      [
        block(goodReport({ criteria_map: [{ criterion: 'AC-1', status: 'met', evidence: [] }] })),
        'evidence_missing',
      ],
      [block(goodReport({ summary: `ntn_${'b'.repeat(30)}` })), 'secret_in_output'],
    ];
    for (const [message, reason] of cases) {
      const w = world();
      writeFileSync(w.msg, message);
      const o = await runAgent(opts(w, { STUB_MODE: 'message', STUB_MESSAGE_FILE: w.msg }));
      expect(o.result, reason).toBe('fail');
      expect(o.reason).toBe(reason);
      expect(readLedger(w.dir)).toHaveLength(1);
    }
  });

  it('report status maps to the ledger result: failed -> fail, needs_input -> blocked', async () => {
    const w = world();
    writeFileSync(
      w.msg,
      block(goodReport({ status: 'failed', criteria_map: undefined, summary: 'could not' })),
    );
    expect(
      (
        await runAgent(
          opts(w, { STUB_MODE: 'message', STUB_MESSAGE_FILE: w.msg }, { kind: 'skeleton' }),
        )
      ).result,
    ).toBe('fail');
    const w2 = world();
    const q = { question: 'Q?', options: [{ label: 'A', recommendation: true }], blocking: true };
    writeFileSync(
      w2.msg,
      block(goodReport({ status: 'needs_input', criteria_map: undefined, questions: [q] })),
    );
    const o = await runAgent(
      opts(w2, { STUB_MODE: 'message', STUB_MESSAGE_FILE: w2.msg }, { kind: 'skeleton' }),
    );
    expect(o.result).toBe('blocked');
    expect(o.exitCode).toBe(3);
  });

  it('without a kind nothing is collected (old behaviour)', async () => {
    const w = world();
    const o = await runAgent(opts(w, { STUB_MODE: 'success' }, { kind: undefined as never }));
    expect(o.result).toBe('pass');
    expect(readEvents(w.dir).map((e) => e.type)).toEqual(['run.start', 'run.end']);
  });

  it('cap stops and pauses carry their reason codes and are not collected', async () => {
    for (const [mode, reason] of [
      ['max_turns', 'cap_turns'],
      ['max_budget', 'cap_budget'],
      ['usage_limit', 'usage_limit'],
    ] as const) {
      const w = world();
      const o = await runAgent(opts(w, { STUB_MODE: mode }));
      expect(o.reason, mode).toBe(reason);
      expect(readEvents(w.dir).some((e) => e.type.startsWith('report.'))).toBe(false);
    }
  });
});

describe('runUnit: retry once, second failure blocks (spec 7.12)', () => {
  const steps = (...s: { message: string; cost?: number }[]): string => JSON.stringify(s);

  it('a first failure is retried once with the reduced budget and can then pass', async () => {
    const w = world();
    writeFileSync(
      w.seq,
      steps({ message: 'no report', cost: 0.5 }, { message: block(goodReport()), cost: 0.25 }),
    );
    const fresh: string[] = [];
    const u = await runUnit(
      {
        ...opts(w, { STUB_MODE: 'sequence', STUB_SEQ_FILE: w.seq, STUB_SEQ_COUNTER: w.counter }),
        kind: 'develop',
        storyRemainingUsd: 1.5,
      },
      { beforeRetry: (f) => void fresh.push(f.runId) },
    );
    expect(u.blocked).toBe(false);
    expect(u.result).toBe('pass');
    expect(u.runs.map((r) => r.result)).toEqual(['fail', 'pass']);
    expect(fresh).toEqual([u.runs[0]?.runId]);
    expect(readLedger(w.dir)).toHaveLength(2);
    const retried = readEvents(w.dir).filter((e) => e.type === 'unit.retried');
    expect(retried).toHaveLength(1);
    expect(retried[0]?.data).toMatchObject({ reason: 'report_invalid', budget_usd: 1 });
  });

  it('a second failure blocks the unit; two ledger rows exist', async () => {
    const w = world();
    writeFileSync(w.seq, steps({ message: 'no report' }, { message: 'still none' }));
    const u = await runUnit({
      ...opts(w, { STUB_MODE: 'sequence', STUB_SEQ_FILE: w.seq, STUB_SEQ_COUNTER: w.counter }),
      kind: 'develop',
    });
    expect(u.blocked).toBe(true);
    expect(u.result).toBe('fail');
    expect(u.runs).toHaveLength(2);
    expect(readLedger(w.dir).map((r) => r.result)).toEqual(['fail', 'fail']);
    expect(readEvents(w.dir).filter((e) => e.type === 'unit.retried')).toHaveLength(1);
  });

  it('no retry when the story budget is gone: blocked with story_budget', async () => {
    const w = world();
    writeFileSync(w.seq, steps({ message: 'no report', cost: 0.5 }));
    const u = await runUnit({
      ...opts(w, { STUB_MODE: 'sequence', STUB_SEQ_FILE: w.seq, STUB_SEQ_COUNTER: w.counter }),
      kind: 'develop',
      storyRemainingUsd: 0.5,
    });
    expect(u.blocked).toBe(true);
    expect(u.reason).toBe('story_budget');
    expect(u.runs).toHaveLength(1);
  });

  it('a cap stop, a pause and a pass are never retried', async () => {
    for (const mode of ['max_turns', 'usage_limit']) {
      const w = world();
      const u = await runUnit({ ...opts(w, { STUB_MODE: mode }), kind: 'develop' });
      expect(u.runs, mode).toHaveLength(1);
      expect(u.blocked, mode).toBe(false);
    }
    const w = world();
    writeFileSync(w.msg, block(goodReport()));
    const u = await runUnit({
      ...opts(w, { STUB_MODE: 'message', STUB_MESSAGE_FILE: w.msg }),
      kind: 'develop',
    });
    expect(u.runs).toHaveLength(1);
  });

  it('a crash (non-zero, no result) counts as a run failure and is retried once', async () => {
    const w = world();
    const u = await runUnit({ ...opts(w, { STUB_MODE: 'crash' }), kind: 'develop' });
    expect(u.runs).toHaveLength(2);
    expect(u.blocked).toBe(true);
  });
});

describe('G-06: the orchestrator cannot hand-write engine state', () => {
  it('its write patterns reach only the outbox and overrides under .arima/', () => {
    const tools = allowedTools('orchestrator', '/p/scripts/dist');
    const arima = tools.filter((t) => /^(Write|Edit)\(\.\/\.arima/.test(t));
    expect(arima.sort()).toEqual(
      [
        'Edit(./.arima/overrides/**)',
        'Write(./.arima/outbox/**)',
        'Write(./.arima/overrides/**)',
      ].sort(),
    );
    for (const t of tools) expect(t).not.toMatch(/\.arima\/\*\*\)$/);
  });

  it('no role may write events, ledger, mirror, runs or state by pattern', () => {
    for (const role of ROLES)
      for (const t of allowedTools(role, '/p/scripts/dist'))
        expect(t, `${role}: ${t}`).not.toMatch(
          /^(Write|Edit)\(.*\.arima\/(events|ledger|mirror|runs|state|items|findings|notion-map)/,
        );
  });
});
