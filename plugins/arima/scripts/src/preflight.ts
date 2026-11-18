import { appendEvent } from './events.js';
import { budgetStatus, newBudgetAlerts, readAlertHistory } from './budget.js';
import { validateProject } from './config.js';
import { checkKillSwitch } from './killswitch.js';
import type { NotionPort } from './notion/port.js';
import { acquireRunLock, lockStatus } from './runlock.js';

/** Exit codes of `arima-preflight`; each failing condition has its own (spec §7.2 step 1). */
export const PREFLIGHT_EXIT = {
  ok: 0,
  usage: 2,
  config: 10,
  locked: 11,
  killSwitch: 12,
  budget: 13,
  env: 14,
} as const;

export type CheckName = 'config' | 'kill_switch' | 'run_lock' | 'budget' | 'env';

export interface CheckResult {
  check: CheckName;
  ok: boolean;
  detail: string;
  /** Present when ok but worth a human's attention, e.g. Notion unreachable. */
  warning?: string;
}

export interface PreflightResult {
  ok: boolean;
  exitCode: number;
  checks: CheckResult[];
  acquired: boolean;
}

export interface PreflightOptions {
  projectDir: string;
  /** Environment to inspect; defaults to process.env. Only variable *names* are ever reported. */
  env?: NodeJS.ProcessEnv;
  /** Notion access for the kill switch; null skips the Notion check (PAUSE file only). */
  notion?: NotionPort | null;
  /** Create the run lock for this run id when every check passes. */
  acquireFor?: string;
  now?: Date;
}

const CODE: Record<CheckName, number> = {
  config: PREFLIGHT_EXIT.config,
  kill_switch: PREFLIGHT_EXIT.killSwitch,
  run_lock: PREFLIGHT_EXIT.locked,
  budget: PREFLIGHT_EXIT.budget,
  env: PREFLIGHT_EXIT.env,
};

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Runs the daily-run preflight: valid config, kill switch off, no other run holds the lock,
 * budget left, required environment variables present. Every failure is logged as a
 * `preflight.fail` event. Checks run in a fixed order and the exit code is the first failure's.
 */
export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const checks: CheckResult[] = [];

  // 1. config
  const cfg = validateProject(opts.projectDir);
  checks.push({
    check: 'config',
    ok: cfg.ok,
    detail: cfg.ok
      ? 'arima.yaml and team.yaml are valid'
      : `${cfg.errors.length} error(s): ${cfg.errors[0]?.message ?? ''}`,
  });
  const arima = cfg.arima as
    | {
        schedule: { max_run_minutes: number };
        budget: { project_cap: number; daily_cap: number; alert_thresholds: number[] };
        notion: { root_page_id: string; token_env: string };
        github: { machine_token_env?: string };
        runtime: { auth: string };
        telemetry?: { otel_enabled?: boolean; endpoint_env?: string };
      }
    | undefined;

  // 2. kill switch (works without a valid config: the PAUSE file needs none)
  const notionTarget =
    opts.notion && arima ? { port: opts.notion, rootPageId: arima.notion.root_page_id } : null;
  const ks = await checkKillSwitch(opts.projectDir, notionTarget);
  const ksCheck: CheckResult = {
    check: 'kill_switch',
    ok: !ks.on,
    detail: ks.on ? `paused: ${ks.detail}` : 'kill switch is off',
  };
  if (!ks.on && ks.detail !== '') ksCheck.warning = ks.detail;
  if (!ks.on && ks.notion === 'unchecked' && opts.notion === null) {
    ksCheck.warning = 'Notion kill switch not checked; only the PAUSE file was consulted';
  }
  checks.push(ksCheck);

  // 3. run lock
  const staleMs = ((arima?.schedule.max_run_minutes ?? 240) + 30) * 60_000;
  const lock = lockStatus(opts.projectDir, staleMs, now.getTime());
  checks.push({
    check: 'run_lock',
    ok: !lock.held,
    detail: lock.held
      ? `another run holds .arima/run.lock (run ${lock.lock?.run_id ?? '?'}, pid ${lock.lock?.pid ?? '?'})`
      : lock.stale
        ? 'a stale run.lock from a dead run will be replaced'
        : 'no other run holds the lock',
  });

  // 4. budget (needs config)
  if (arima) {
    const limits = {
      projectCap: arima.budget.project_cap,
      dailyCap: arima.budget.daily_cap,
      alertThresholds: arima.budget.alert_thresholds,
    };
    const status = budgetStatus(opts.projectDir, limits, today);
    const check: CheckResult = {
      check: 'budget',
      ok: status.ok,
      detail: status.ok
        ? `project ${status.projectSpent}/${status.projectCap}, today ${status.daySpent}/${status.dailyCap} (est. USD)`
        : `budget exhausted: ${status.exhausted.join(' and ')} (project ${status.projectSpent}/${status.projectCap}, today ${status.daySpent}/${status.dailyCap})`,
    };
    for (const a of newBudgetAlerts(
      status,
      limits.alertThresholds,
      readAlertHistory(opts.projectDir),
      today,
    )) {
      await appendEvent(opts.projectDir, {
        type: 'budget.alert',
        actor: 'system',
        data: { scope: a.scope, threshold: a.threshold, spent: a.spent, cap: a.cap, date: today },
      });
      check.warning = `${a.scope} budget passed ${Math.round(a.threshold * 100)}%`;
    }
    checks.push(check);
  }

  // 5. required environment variables (names only; values are never read into output)
  if (arima) {
    const required = [arima.notion.token_env];
    if (arima.github.machine_token_env) required.push(arima.github.machine_token_env);
    if (arima.telemetry?.otel_enabled && arima.telemetry.endpoint_env)
      required.push(arima.telemetry.endpoint_env);
    if (arima.runtime.auth === 'api_key') required.push('ANTHROPIC_API_KEY');
    const missing = required.filter((n) => !env[n]);
    checks.push({
      check: 'env',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `all ${required.length} required variables are set`
          : `missing environment variable(s): ${missing.join(', ')}`,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  for (const f of failed) {
    await appendEvent(opts.projectDir, {
      type: 'preflight.fail',
      actor: 'system',
      data: { check: f.check, detail: f.detail },
    });
  }

  const exitCode = failed[0] ? CODE[failed[0].check] : PREFLIGHT_EXIT.ok;
  let acquired = false;
  if (failed.length === 0 && opts.acquireFor !== undefined) {
    acquired = acquireRunLock(opts.projectDir, opts.acquireFor, staleMs);
    if (!acquired) {
      const c: CheckResult = {
        check: 'run_lock',
        ok: false,
        detail: 'lost the race for .arima/run.lock',
      };
      checks.push(c);
      await appendEvent(opts.projectDir, {
        type: 'preflight.fail',
        actor: 'system',
        data: { check: c.check, detail: c.detail },
      });
      return { ok: false, exitCode: PREFLIGHT_EXIT.locked, checks, acquired };
    }
  }
  return { ok: failed.length === 0, exitCode, checks, acquired };
}
