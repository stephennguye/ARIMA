import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, eventsFile, readEvents } from '../src/events.js';
import {
  appendLedgerRow,
  buildLedgerRow,
  ledgerFile,
  parseClaudeResult,
  readLedger,
  recordRun,
} from '../src/ledger.js';
import type { RunContext } from '../src/ledger.js';
import { issueRunId } from '../src/runid.js';
import { findSecrets } from '../src/lib/secrets.js';
import { tempDir } from './helpers.js';

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude', `${name}.json`), 'utf8');

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  run_id: 'r-20261117-0603-07',
  date: '2026-11-17',
  project: 'TAS',
  phase: 4,
  milestone: 'MS-02',
  item: 'US-112',
  role: 'developer',
  model_tier: 'standard',
  attempt: 1,
  is_rework: false,
  budget_usd: 3,
  ...over,
});

describe('parseClaudeResult', () => {
  it('reads a single result object', () => {
    expect(parseClaudeResult(fixture('success')).subtype).toBe('success');
  });

  it('takes the last result from a message array', () => {
    const r = parseClaudeResult(fixture('resumed-first'));
    expect(r.total_cost_usd).toBe(0.5);
  });

  it('rejects non-JSON and output without a result', () => {
    expect(() => parseClaudeResult('not json')).toThrow(/not valid JSON/);
    expect(() => parseClaudeResult('[{"type":"assistant"}]')).toThrow(/no result message/);
    expect(() => parseClaudeResult('{"hello":1}')).toThrow(/no result message/);
  });
});

describe('buildLedgerRow (spec §13.2, fixtures)', () => {
  it('success -> pass with cost, tokens and timings', () => {
    const row = buildLedgerRow(parseClaudeResult(fixture('success')), ctx());
    expect(row).toMatchObject({
      subtype: 'success',
      result: 'pass',
      num_turns: 14,
      duration_ms: 412000,
      duration_api_ms: 301000,
      cost_usd: 1.87,
      budget_usd: 3,
      tokens: { input: 182000, output: 21000, cache_read: 940000, cache_creation: 61000 },
    });
  });

  it('error_max_turns -> blocked; rounds fractional ms and cost', () => {
    const row = buildLedgerRow(parseClaudeResult(fixture('error_max_turns')), ctx());
    expect(row.subtype).toBe('error_max_turns');
    expect(row.result).toBe('blocked');
    expect(row.duration_ms).toBe(98000);
    expect(row.cost_usd).toBe(0.912346);
  });

  it('error_max_budget_usd -> blocked', () => {
    const row = buildLedgerRow(parseClaudeResult(fixture('error_max_budget_usd')), ctx());
    expect(row.subtype).toBe('error_max_budget_usd');
    expect(row.result).toBe('blocked');
    expect(row.cost_usd).toBe(2.04);
  });

  it('unknown error subtype -> error', () => {
    const r = {
      ...parseClaudeResult(fixture('success')),
      subtype: 'error_during_execution',
      is_error: true,
    };
    expect(buildLedgerRow(r, ctx()).result).toBe('error');
  });

  it('lets the caller override the outcome (e.g. a QA fail)', () => {
    const row = buildLedgerRow(parseClaudeResult(fixture('success')), ctx({ result: 'fail' }));
    expect(row.result).toBe('fail');
  });

  it('stores only the cost difference for a resumed session', () => {
    const first = buildLedgerRow(
      parseClaudeResult(fixture('resumed-first')),
      ctx({ run_id: 'r-20261117-0603-01' }),
    );
    expect(first.cost_usd).toBe(0.5);
    const second = buildLedgerRow(
      parseClaudeResult(fixture('resumed-second')),
      ctx({ run_id: 'r-20261117-0604-02' }),
      [first],
    );
    expect(second.cost_usd).toBe(0.7);
  });

  it('does not subtract cost from a different session, and never goes negative', () => {
    const other = buildLedgerRow(parseClaudeResult(fixture('success')), ctx());
    const row = buildLedgerRow(parseClaudeResult(fixture('resumed-second')), ctx(), [other]);
    expect(row.cost_usd).toBe(1.2);
    const odd = buildLedgerRow(parseClaudeResult(fixture('resumed-second')), ctx(), [
      { ...first(), cost_usd: 9 },
    ]);
    expect(odd.cost_usd).toBe(0);

    function first() {
      return buildLedgerRow(parseClaudeResult(fixture('resumed-first')), ctx());
    }
  });
});

describe('ledger file', () => {
  it('appends validated rows and reads them back', async () => {
    const dir = tempDir();
    const a = await recordRun(dir, fixture('success'), ctx());
    const b = await recordRun(
      dir,
      fixture('error_max_turns'),
      ctx({
        run_id: 'r-20261117-0610-08',
        attempt: 2,
        is_rework: true,
        rework_reason: 'failed_qa',
      }),
    );
    expect(readLedger(dir)).toEqual([a, b]);
    expect(readFileSync(ledgerFile(dir), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('records the cost difference when a session is resumed across recordRun calls', async () => {
    const dir = tempDir();
    await recordRun(dir, fixture('resumed-first'), ctx({ run_id: 'r-20261117-0603-01' }));
    const second = await recordRun(
      dir,
      fixture('resumed-second'),
      ctx({ run_id: 'r-20261117-0604-02' }),
    );
    expect(second.cost_usd).toBe(0.7);
    const total = readLedger(dir).reduce((s, r) => s + r.cost_usd, 0);
    expect(Math.round(total * 100) / 100).toBe(1.2);
  });

  it('rejects an invalid row and writes nothing', async () => {
    const dir = tempDir();
    const bad = { ...buildLedgerRow(parseClaudeResult(fixture('success')), ctx()), project: 'tas' };
    await expect(appendLedgerRow(dir, bad)).rejects.toThrow(/Invalid ledger record/);
    expect(existsSync(ledgerFile(dir))).toBe(false);
  });

  it('names the line of a corrupt ledger when reading', async () => {
    const dir = tempDir();
    await recordRun(dir, fixture('success'), ctx());
    writeFileSync(ledgerFile(dir), `${readFileSync(ledgerFile(dir), 'utf8')}{broken\n`);
    expect(() => readLedger(dir)).toThrow(/ledger\.jsonl:2: not valid JSON/);
  });
});

describe('event log', () => {
  it('appends validated events with a timestamp', async () => {
    const dir = tempDir();
    const e = await appendEvent(dir, {
      type: 'run.start',
      actor: 'orchestrator',
      run_id: 'r-20261117-0603-07',
      data: { phase: 4 },
    });
    expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    await appendEvent(dir, { type: 'id.issued', actor: 'system', item: 'US-001' });
    const all = readEvents(dir);
    expect(all.map((x) => x.type)).toEqual(['run.start', 'id.issued']);
    expect(existsSync(eventsFile(dir))).toBe(true);
  });

  it('rejects unknown types and unknown properties', async () => {
    const dir = tempDir();
    await expect(appendEvent(dir, { type: 'made.up' as never, actor: 'system' })).rejects.toThrow(
      /Invalid event/,
    );
    await expect(
      appendEvent(dir, { type: 'run.end', actor: 'system', extra: 1 } as never),
    ).rejects.toThrow(/Invalid event/);
    expect(existsSync(eventsFile(dir))).toBe(false);
  });

  it('refuses to log anything that looks like a secret', async () => {
    const dir = tempDir();
    await expect(
      appendEvent(dir, { type: 'tool.used', actor: 'qa', data: { env: `ntn_${'a'.repeat(30)}` } }),
    ).rejects.toThrow(/looks like a secret/);
    await expect(
      appendEvent(dir, { type: 'tool.used', actor: 'qa', data: { k: `ghp_${'b'.repeat(30)}` } }),
    ).rejects.toThrow(/secret/);
    expect(existsSync(eventsFile(dir))).toBe(false);
  });

  it('keeps lines intact under concurrent appends', async () => {
    const dir = tempDir();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        appendEvent(dir, { type: 'tool.used', actor: 'developer', data: { i } }),
      ),
    );
    const events = readEvents(dir);
    expect(events).toHaveLength(30);
    expect(new Set(events.map((e) => (e.data as { i: number }).i)).size).toBe(30);
  });
});

describe('secrets heuristic', () => {
  it('flags common token shapes and ignores ordinary text', () => {
    expect(findSecrets(`token github_pat_${'x'.repeat(30)}`)).toContain(
      'github fine-grained token',
    );
    expect(findSecrets('-----BEGIN RSA PRIVATE KEY-----')).toContain('private key block');
    expect(findSecrets('US-112 added checkout summary, cost 1.87')).toEqual([]);
  });
});

describe('issueRunId', () => {
  it('formats r-YYYYMMDD-HHMM-NN and counts within a day', async () => {
    const dir = tempDir();
    const t = new Date(2026, 10, 17, 6, 3);
    expect(await issueRunId(dir, t)).toBe('r-20261117-0603-01');
    expect(await issueRunId(dir, t)).toBe('r-20261117-0603-02');
    expect(await issueRunId(dir, new Date(2026, 10, 17, 14, 9))).toBe('r-20261117-1409-03');
    expect(await issueRunId(dir, new Date(2026, 10, 18, 2, 0))).toBe('r-20261118-0200-01');
  });

  it('produces ids the ledger schema accepts', async () => {
    const dir = tempDir();
    const run_id = await issueRunId(dir, new Date(2026, 10, 17, 6, 3));
    await expect(
      appendLedgerRow(dir, buildLedgerRow(parseClaudeResult(fixture('success')), ctx({ run_id }))),
    ).resolves.toBeUndefined();
  });
});
