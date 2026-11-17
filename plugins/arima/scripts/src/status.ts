import path from 'node:path';
import { budgetStatus } from './budget.js';
import type { BudgetStatus } from './budget.js';
import { validateProject } from './config.js';
import { PHASE_AFTER_GATE } from './gates.js';
import { pauseFile } from './killswitch.js';
import { readLedger } from './ledger.js';
import { readMirror } from './notion/mirror.js';
import { enforcedGates, loadProfile } from './profiles.js';
import type { GateId } from './profiles.js';
import { existsSync } from 'node:fs';

export interface StatusReport {
  project: { key: string; name: string; profile: string };
  /** Current phase, derived from which gates are approved. */
  phase: string;
  gates: { gate: GateId; status: string }[];
  questions: {
    open: number;
    blocking: number;
    top: { id: string; question: string; blocking: boolean }[];
  };
  board: Record<string, number>;
  budget: BudgetStatus;
  runs: { total: number; failed: number; paused: number; lastRunId?: string };
  paused: boolean;
  /** When the Notion mirror was last refreshed (ISO), if it exists. */
  mirrorFetchedAt?: string;
  warnings: string[];
}

export class StatusError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
  }
}

const STORY_STATUSES = [
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'In QA',
  'PO Acceptance',
  'Done',
  'Released',
  'Blocked',
  'Cancelled',
];
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Phase, gates, open questions, board, budget and run health from the mirror and the ledger. */
export function buildStatus(projectDir: string, now: Date = new Date()): StatusReport {
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined) {
    throw new StatusError(
      'config is invalid',
      cfg.errors.map((e) => `${path.basename(e.file)}:${e.line}: ${e.message}`),
    );
  }
  const a = cfg.arima as unknown as {
    project: { key: string; name: string };
    profile: string;
    budget: { project_cap: number; daily_cap: number; alert_thresholds: number[] };
  };
  const warnings: string[] = [];
  const profile = loadProfile(a.profile);

  const gateMirror = readMirror(projectDir, 'gates');
  const gates = enforcedGates(profile).map((gate) => {
    const row = gateMirror?.rows.find((r) => r.id === gate);
    return { gate, status: row ? String(row.properties['Status'] ?? 'Not ready') : 'no page' };
  });
  const approved = (s: string): boolean => s === 'Approved' || s === 'Approved with conditions';
  let phase = '0 Initiation';
  if (gateMirror === undefined) {
    phase = 'unknown (no Notion mirror yet; run /arima:init or arima-notion pull)';
    warnings.push('no Notion mirror: gates, questions and board are empty');
  } else {
    for (const g of gates) {
      if (!approved(g.status)) break;
      phase = PHASE_AFTER_GATE[g.gate];
    }
  }

  const qMirror = readMirror(projectDir, 'questions');
  const open = (qMirror?.rows ?? []).filter((r) => r.properties['Status'] === 'Open');
  const top = open
    .map((r) => ({
      id: r.id,
      question: String(r.properties['Question'] ?? ''),
      blocking: r.properties['Blocking'] === true,
    }))
    .sort((x, y) => Number(y.blocking) - Number(x.blocking) || x.id.localeCompare(y.id))
    .slice(0, 10);

  const board: Record<string, number> = {};
  for (const s of STORY_STATUSES) board[s] = 0;
  for (const r of readMirror(projectDir, 'stories')?.rows ?? []) {
    const s = String(r.properties['Status'] ?? 'Backlog');
    board[s] = (board[s] ?? 0) + 1;
  }

  const budget = budgetStatus(
    projectDir,
    {
      projectCap: a.budget.project_cap,
      dailyCap: a.budget.daily_cap,
      alertThresholds: a.budget.alert_thresholds,
    },
    localDate(now),
  );
  const ledger = readLedger(projectDir);
  const last = ledger[ledger.length - 1];
  const report: StatusReport = {
    project: { key: a.project.key, name: a.project.name, profile: a.profile },
    phase,
    gates,
    questions: {
      open: open.length,
      blocking: open.filter((r) => r.properties['Blocking'] === true).length,
      top,
    },
    board,
    budget,
    runs: {
      total: ledger.length,
      failed: ledger.filter((r) => r.result === 'error').length,
      paused: ledger.filter((r) => r.result === 'paused').length,
      ...(last ? { lastRunId: last.run_id } : {}),
    },
    paused: existsSync(pauseFile(projectDir)),
    warnings,
  };
  const fetched = gateMirror?.fetched_at ?? qMirror?.fetched_at;
  if (fetched !== undefined) report.mirrorFetchedAt = fetched;
  return report;
}

export function formatStatus(r: StatusReport): string {
  const L: string[] = [];
  L.push(
    `${r.project.name} (${r.project.key}) - profile ${r.project.profile}${r.paused ? '  [PAUSED]' : ''}`,
  );
  L.push(`Phase: ${r.phase}`);
  L.push('', 'Gates:');
  for (const g of r.gates) L.push(`  ${g.gate}  ${g.status}`);
  L.push('', `Open questions: ${r.questions.open} (${r.questions.blocking} blocking)`);
  for (const q of r.questions.top)
    L.push(`  ${q.id}${q.blocking ? ' [blocking]' : ''}: ${q.question}`);
  L.push('', 'Board:');
  L.push(
    `  ${Object.entries(r.board)
      .map(([k, v]) => `${k} ${v}`)
      .join(' | ')}`,
  );
  L.push('', 'Budget (estimated USD):');
  L.push(`  project ${r.budget.projectSpent} / ${r.budget.projectCap}`);
  L.push(
    `  today   ${r.budget.daySpent} / ${r.budget.dailyCap}${r.budget.ok ? '' : `  EXHAUSTED: ${r.budget.exhausted.join(', ')}`}`,
  );
  L.push(
    '',
    `Runs: ${r.runs.total} total, ${r.runs.failed} failed, ${r.runs.paused} paused${r.runs.lastRunId ? `; last ${r.runs.lastRunId}` : ''}`,
  );
  if (r.mirrorFetchedAt) L.push(`Notion mirror last refreshed: ${r.mirrorFetchedAt}`);
  for (const w of r.warnings) L.push(`warning: ${w}`);
  return `${L.join('\n')}\n`;
}
