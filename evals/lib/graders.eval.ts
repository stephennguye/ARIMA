// The graders grade the graders (F10 5.2 step 5): each one must fail on bad data, or a scenario that
// passes proves nothing. Pure, free, part of `npm run eval`.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArimaEvent } from '../../plugins/arima/scripts/src/events.js';
import type { LedgerRow } from '../../plugins/arima/scripts/src/ledger.js';
import {
  costEquals,
  eventSubsequence,
  ledgerRows,
  noAttribution,
  noDuplicateRows,
  snapshotDiff,
  snapshotFiles,
  stateTrace,
  withNegativeControl,
} from './graders.js';

const ev = (type: string, extra: Partial<ArimaEvent> = {}): ArimaEvent =>
  ({ ts: 't', type, actor: 'orchestrator', ...extra }) as ArimaEvent;
const edge = (item: string, from: string, to: string, actor: string): ArimaEvent =>
  ev('item.status', { item, actor, data: { from, to } });
const row = (run_id: string, item: string, cost: number): LedgerRow => ({ run_id, item, cost_usd: cost }) as LedgerRow;

describe('eventSubsequence', () => {
  it('passes in order with other events between, fails out of order or short', () => {
    const e = [ev('run.start'), ev('notion.pull'), ev('unit.dispatched'), ev('run.end')];
    expect(eventSubsequence(e, ['run.start', 'unit.dispatched', 'run.end'])).toEqual([]);
    expect(eventSubsequence(e, ['run.end', 'run.start']).length).toBe(1);
    expect(eventSubsequence(e, ['run.start', 'merge.done']).length).toBe(1);
  });
});

describe('stateTrace', () => {
  const good = [
    edge('US-1', 'Backlog', 'Ready', 'ba'),
    edge('US-1', 'Ready', 'In Progress', 'orchestrator'),
  ];
  it('passes a legal path for its actors', () => expect(stateTrace(good, 'US-1', ['Ready', 'In Progress'])).toEqual([]));
  it('fails a wrong path, an edge not in the table, and an actor that may not make the edge', () => {
    expect(stateTrace(good, 'US-1', ['Ready']).join()).toMatch(/path/);
    expect(stateTrace([edge('US-1', 'Backlog', 'Done', 'orchestrator')], 'US-1', ['Done']).join()).toMatch(/not in the table/);
    expect(stateTrace([edge('US-1', 'Backlog', 'Ready', 'developer')], 'US-1', ['Ready']).join()).toMatch(/may not make/);
  });
});

describe('ledgerRows and costEquals', () => {
  it('one row per run, no duplicate run id, no bad cost', () => {
    expect(ledgerRows([row('r-1', 'US-1', 1), row('r-2', 'US-1', 1)], 2)).toEqual([]);
    expect(ledgerRows([row('r-1', 'US-1', 1)], 2).join()).toMatch(/1 ledger rows for 2 runs/);
    expect(ledgerRows([row('r-1', 'US-1', 1), row('r-1', 'US-1', 1)], 2).join()).toMatch(/twice/);
    expect(ledgerRows([row('r-1', 'US-1', -1)], 1).join()).toMatch(/bad cost/);
    expect(ledgerRows([row('r-1', 'US-1', Number.NaN)], 1).join()).toMatch(/bad cost/);
  });
  it('the reported cost must equal the ledger sum', () => {
    const rows = [row('r-1', 'US-1', 0.25), row('r-2', 'US-1', 0.5), row('r-3', 'US-2', 9)];
    expect(costEquals(rows, 'US-1', 0.75)).toEqual([]);
    expect(costEquals(rows, 'US-1', 0.7).join()).toMatch(/ledger sums to 0.75/);
  });
});

describe('noAttribution and noDuplicateRows', () => {
  it('catches an AI attribution line, and passes clean text', () => {
    expect(noAttribution(['feat(US-1): x', 'docs: y'])).toEqual([]);
    expect(noAttribution(['feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>']).length).toBe(1);
    expect(noAttribution(['Generated with Claude Code']).length).toBe(1);
  });
  it('a changed row count is a duplicate', () => {
    expect(noDuplicateRows({ stories: 5 }, { stories: 5 })).toEqual([]);
    expect(noDuplicateRows({ stories: 5 }, { stories: 6 }).join()).toMatch(/5 rows became 6/);
  });
});

describe('snapshots', () => {
  it('see a change in a state file, but not in the event log, the lock or the run counter', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arima-snap-'));
    mkdirSync(path.join(dir, '.arima', 'state'), { recursive: true });
    writeFileSync(path.join(dir, '.arima', 'ledger.jsonl'), 'a\n');
    const before = snapshotFiles(dir);
    writeFileSync(path.join(dir, '.arima', 'events.jsonl'), 'refusal\n');
    writeFileSync(path.join(dir, '.arima', 'run.lock'), 'x');
    writeFileSync(path.join(dir, '.arima', 'state', 'run-seq.json'), '{}');
    expect(snapshotDiff(before, snapshotFiles(dir))).toEqual([]);
    writeFileSync(path.join(dir, '.arima', 'ledger.jsonl'), 'a\nb\n');
    expect(snapshotDiff(before, snapshotFiles(dir))).toEqual(['.arima/ledger.jsonl']);
  });
});

describe('withNegativeControl', () => {
  const refusal = (r: string): boolean => r === 'refused';
  it('passes when the bad form is refused and the good form is not', async () => {
    expect(await withNegativeControl({ refused: async () => 'refused', allowed: async () => 'ok' }, refusal)).toEqual([]);
  });
  it('fails when the bad form is NOT refused', async () => {
    expect((await withNegativeControl({ refused: async () => 'ok', allowed: async () => 'ok' }, refusal)).join()).toMatch(/was not refused/);
  });
  it('fails when the harness refuses everything', async () => {
    expect((await withNegativeControl({ refused: async () => 'refused', allowed: async () => 'refused' }, refusal)).join()).toMatch(/refuses everything/);
  });
});
