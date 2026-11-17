import { readEvents } from './events.js';
import type { ArimaEvent } from './events.js';
import { readLedger } from './ledger.js';

export interface BudgetLimits {
  projectCap: number;
  dailyCap: number;
  alertThresholds: number[];
}

export interface BudgetStatus {
  projectSpent: number;
  projectCap: number;
  daySpent: number;
  dailyCap: number;
  /** True while both the project and the daily budget have something left (spec §13.5). */
  ok: boolean;
  exhausted: ('project' | 'daily')[];
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Spend so far, from the run ledger. `today` is a YYYY-MM-DD string. */
export function budgetStatus(
  projectDir: string,
  limits: BudgetLimits,
  today: string,
): BudgetStatus {
  const rows = readLedger(projectDir);
  const projectSpent = round(rows.reduce((s, r) => s + r.cost_usd, 0));
  const daySpent = round(rows.filter((r) => r.date === today).reduce((s, r) => s + r.cost_usd, 0));
  const exhausted: BudgetStatus['exhausted'] = [];
  if (projectSpent >= limits.projectCap) exhausted.push('project');
  if (daySpent >= limits.dailyCap) exhausted.push('daily');
  return {
    projectSpent,
    projectCap: limits.projectCap,
    daySpent,
    dailyCap: limits.dailyCap,
    ok: exhausted.length === 0,
    exhausted,
  };
}

export interface BudgetAlert {
  scope: 'project' | 'daily';
  threshold: number;
  spent: number;
  cap: number;
}

/**
 * Threshold alerts (50/80/100% by default) that have been crossed and not yet logged.
 * Project alerts fire once; daily alerts fire once per day.
 */
export function newBudgetAlerts(
  status: BudgetStatus,
  thresholds: number[],
  existing: readonly ArimaEvent[],
  today: string,
): BudgetAlert[] {
  const seen = new Set(
    existing
      .filter((e) => e.type === 'budget.alert')
      .map((e) => {
        const d = e.data as { scope?: string; threshold?: number; date?: string } | undefined;
        return `${d?.scope}|${d?.threshold}|${d?.scope === 'daily' ? d.date : ''}`;
      }),
  );
  const out: BudgetAlert[] = [];
  for (const threshold of [...thresholds].sort((a, b) => a - b)) {
    for (const [scope, spent, cap] of [
      ['project', status.projectSpent, status.projectCap],
      ['daily', status.daySpent, status.dailyCap],
    ] as const) {
      const key = `${scope}|${threshold}|${scope === 'daily' ? today : ''}`;
      if (spent >= cap * threshold && !seen.has(key)) out.push({ scope, threshold, spent, cap });
    }
  }
  return out;
}

export function readAlertHistory(projectDir: string): ArimaEvent[] {
  return readEvents(projectDir).filter((e) => e.type === 'budget.alert');
}
