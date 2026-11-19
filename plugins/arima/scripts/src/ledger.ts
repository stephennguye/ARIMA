import path from 'node:path';
import { appendJsonl, readJsonl } from './lib/jsonl.js';
import type { ReasonCode } from './reasons.js';

export type Role =
  | 'orchestrator'
  | 'ba'
  | 'ux'
  | 'architect'
  | 'tech-lead'
  | 'developer'
  | 'qa'
  | 'security'
  | 'devops';

export type RunResult = 'pass' | 'fail' | 'error' | 'paused' | 'blocked';

export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface LedgerRow {
  run_id: string;
  session_id?: string;
  date: string;
  started_at?: string;
  project: string;
  phase: number;
  milestone?: string | null;
  item: string;
  role: Role;
  model_tier?: 'strong' | 'standard' | 'fast';
  attempt: number;
  is_rework: boolean;
  rework_reason?: 'failed_review' | 'failed_qa' | 'vetoed' | 'bug' | 'other' | null;
  subtype: string;
  num_turns: number;
  duration_ms: number;
  duration_api_ms?: number;
  tokens: Tokens;
  cost_usd: number;
  budget_usd: number;
  ci_minutes?: number;
  result: RunResult;
  /** Why a run failed, blocked or paused (03-contracts 9b). */
  reason?: ReasonCode;
}

/** The `type: "result"` object printed by `claude -p --output-format json`. */
export interface ClaudeResult {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  session_id?: string;
  total_cost_usd?: number;
  /** Older CLI versions. */
  cost_usd?: number;
  result?: string;
  /** Present on error results, e.g. "Reached maximum number of turns (1)". */
  errors?: string[];
  /** completed | max_turns | budget_exhausted | ... (seen in claude 2.1.326). */
  terminal_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** What the caller knows about the run; everything the CLI result cannot tell us. */
export interface RunContext {
  run_id: string;
  date: string;
  started_at?: string;
  project: string;
  phase: number;
  milestone?: string | null;
  item: string;
  role: Role;
  model_tier?: 'strong' | 'standard' | 'fast';
  attempt: number;
  is_rework: boolean;
  rework_reason?: LedgerRow['rework_reason'];
  budget_usd: number;
  ci_minutes?: number;
  /** Overrides the default outcome mapping (e.g. QA reports "fail" for a run that finished fine). */
  result?: RunResult;
}

export function ledgerFile(projectDir: string): string {
  return path.join(projectDir, '.arima', 'ledger.jsonl');
}

/**
 * Parses the stdout of `claude -p --output-format json`. Accepts a single result object or an
 * array of messages (uses the last `result` entry).
 */
export function parseClaudeResult(stdout: string): ClaudeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error('claude output is not valid JSON', { cause: e });
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i] as { type?: unknown; subtype?: unknown } | null;
    if (
      c !== null &&
      typeof c === 'object' &&
      c.type === 'result' &&
      typeof c.subtype === 'string'
    ) {
      return c as ClaudeResult;
    }
  }
  throw new Error('claude output contains no result message');
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const int = (n: number | undefined): number => Math.max(0, Math.round(n ?? 0));

/** Default mapping from CLI subtype to ledger outcome. */
export function outcomeOf(r: ClaudeResult): RunResult {
  if (r.subtype === 'success' && r.is_error !== true) return 'pass';
  if (r.subtype === 'error_max_turns' || r.subtype === 'error_max_budget_usd') return 'blocked';
  return 'error';
}

/**
 * Builds one ledger row. For a resumed session the CLI reports cumulative cost, so the row stores
 * the difference from what earlier rows of the same session already account for (spec §13.6).
 */
export function buildLedgerRow(
  result: ClaudeResult,
  ctx: RunContext,
  previousRows: readonly LedgerRow[] = [],
): LedgerRow {
  const total = result.total_cost_usd ?? result.cost_usd ?? 0;
  const sessionId = result.session_id;
  const already =
    sessionId === undefined
      ? 0
      : previousRows
          .filter((r) => r.session_id === sessionId)
          .reduce((sum, r) => sum + r.cost_usd, 0);
  const row: LedgerRow = {
    run_id: ctx.run_id,
    date: ctx.date,
    project: ctx.project,
    phase: ctx.phase,
    item: ctx.item,
    role: ctx.role,
    attempt: ctx.attempt,
    is_rework: ctx.is_rework,
    subtype: result.subtype,
    num_turns: int(result.num_turns),
    duration_ms: int(result.duration_ms),
    tokens: {
      input: int(result.usage?.input_tokens),
      output: int(result.usage?.output_tokens),
      cache_read: int(result.usage?.cache_read_input_tokens),
      cache_creation: int(result.usage?.cache_creation_input_tokens),
    },
    cost_usd: round6(Math.max(0, total - already)),
    budget_usd: ctx.budget_usd,
    result: ctx.result ?? outcomeOf(result),
  };
  if (sessionId !== undefined) row.session_id = sessionId;
  if (ctx.started_at !== undefined) row.started_at = ctx.started_at;
  if (ctx.milestone !== undefined) row.milestone = ctx.milestone;
  if (ctx.model_tier !== undefined) row.model_tier = ctx.model_tier;
  if (ctx.rework_reason !== undefined) row.rework_reason = ctx.rework_reason;
  if (result.duration_api_ms !== undefined) row.duration_api_ms = int(result.duration_api_ms);
  if (ctx.ci_minutes !== undefined) row.ci_minutes = ctx.ci_minutes;
  return row;
}

export async function appendLedgerRow(projectDir: string, row: LedgerRow): Promise<void> {
  await appendJsonl(ledgerFile(projectDir), 'ledger', row);
}

export function readLedger(projectDir: string): LedgerRow[] {
  return readJsonl<LedgerRow>(ledgerFile(projectDir), 'ledger');
}

/** Parse + build + append in one step, using the existing ledger for resumed-session math. */
export async function recordRun(
  projectDir: string,
  stdout: string,
  ctx: RunContext,
): Promise<LedgerRow> {
  const row = buildLedgerRow(parseClaudeResult(stdout), ctx, readLedger(projectDir));
  await appendLedgerRow(projectDir, row);
  return row;
}
