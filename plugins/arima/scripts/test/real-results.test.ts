// Real `claude -p --output-format json` results, recorded on 2026-11-18 with claude 2.1.326 and
// scrubbed (fixed IDs, no credential timestamp). They replace the hand-written shapes as the
// ground truth the parser and the ledger are tested against.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSecrets } from '../src/lib/secrets.js';
import { buildLedgerRow, parseClaudeResult } from '../src/ledger.js';
import type { RunContext } from '../src/ledger.js';
import { isUsageLimit } from '../src/run-agent.js';

const real = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude-real', `${name}.json`), 'utf8');

const ctx: RunContext = {
  run_id: 'r-20261118-0200-01',
  date: '2026-11-18',
  project: 'TAS',
  phase: 4,
  item: 'US-1',
  role: 'qa',
  attempt: 1,
  is_rework: false,
  budget_usd: 1,
};

describe('real claude results', () => {
  it('contain nothing that looks like a secret', () => {
    for (const f of ['success', 'max_turns', 'max_budget'])
      expect(findSecrets(real(f)), f).toEqual([]);
  });

  it('success: a single result object, parsed into a passing ledger row', () => {
    const r = parseClaudeResult(real('success'));
    expect(r).toMatchObject({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });
    const row = buildLedgerRow(r, ctx);
    expect(row).toMatchObject({ subtype: 'success', result: 'pass', num_turns: 1 });
    expect(row.cost_usd).toBeGreaterThan(0);
    expect(row.tokens.cache_creation + row.tokens.cache_read).toBeGreaterThan(0);
    expect(row.session_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('error_max_turns: is_error is true on the real thing, and the run is "blocked" not "error"', () => {
    const r = parseClaudeResult(real('max_turns'));
    expect(r).toMatchObject({ subtype: 'error_max_turns', is_error: true });
    expect(r.errors).toEqual(['Reached maximum number of turns (1)']);
    expect(r.terminal_reason).toBe('max_turns');
    expect(buildLedgerRow(r, ctx).result).toBe('blocked');
  });

  it('error_max_budget_usd: blocked, and the real cost overshoots a tiny cap (caps below about $0.20 cannot hold)', () => {
    const r = parseClaudeResult(real('max_budget'));
    expect(r).toMatchObject({
      subtype: 'error_max_budget_usd',
      is_error: true,
      terminal_reason: 'budget_exhausted',
    });
    expect(buildLedgerRow(r, { ...ctx, budget_usd: 0.0001 }).result).toBe('blocked');
    expect(r.total_cost_usd).toBeGreaterThan(0.0001 * 100);
  });

  it('an error result with no text is not mistaken for a usage-limit stop', () => {
    for (const f of ['max_turns', 'max_budget'])
      expect(isUsageLimit(parseClaudeResult(real(f)), '', real(f)), f).toBe(false);
  });
});
