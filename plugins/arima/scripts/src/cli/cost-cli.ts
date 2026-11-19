import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import {
  filterRows,
  costAlerts,
  estimateAccuracy,
  metrics,
  readManualCosts,
  recordCostAlerts,
  rollup,
  storyMetas,
  syncCostLog,
  totalCostOfOwnership,
  usd,
} from '../cost.js';
import type { Filter, Totals } from '../cost.js';
import { appendEvent, readEvents } from '../events.js';
import { delivery, describeDelivery } from '../metrics.js';
import { readLedger } from '../ledger.js';
import { issueRunId } from '../runid.js';
import type { Io } from './config-cli.js';

export const COST_EXIT = { ok: 0, failed: 1, usage: 2, config: 10, locked: 11 } as const;

export const COST_USAGE = `Usage: arima-cost [--by role|phase|item] [--milestone MS-nn] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json] [--project <dir>]
       arima-cost --sync [--run-id <id>] [--project <dir>]   queue the Notion Cost log rows and record cost alerts
All amounts are estimated USD: consumption, not spend on a seat plan (spec 13.6).
Exit codes: 0 ok, 1 ledger or bills file unreadable, 2 usage, 10 config invalid, 11 a run holds the lock (reserved, WP-160)`;

const money = (m: number): string => `$${usd(m).toFixed(2)}`;
const pct = (x: number | undefined): string =>
  x === undefined ? 'n/a' : `${(x * 100).toFixed(0)}%`;

function table(title: string, rows: Map<string | number, Totals>): string[] {
  const sorted = [...rows.entries()].sort((a, b) => b[1].cost_micro - a[1].cost_micro);
  return [
    '',
    title,
    ...sorted.map(
      ([k, t]) =>
        `  ${String(k).padEnd(12)} ${money(t.cost_micro).padStart(10)}  ${String(t.runs).padStart(4)} runs  rework ${money(t.rework_micro)}`,
    ),
  ];
}

/** `arima-cost`: cost per story, role and phase, estimate accuracy, alerts, total cost of ownership; `--sync` queues the Cost log. */
export async function runCostCli(argv: string[], io: Io): Promise<number> {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        by: { type: 'string' },
        milestone: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        json: { type: 'boolean' },
        sync: { type: 'boolean' },
        'run-id': { type: 'string' },
        project: { type: 'string' },
      },
    }).values as Record<string, string | boolean | undefined>;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${COST_USAGE}\n`);
    return COST_EXIT.usage;
  }
  const usage = (m: string): number => {
    io.err(`${m}\n${COST_USAGE}\n`);
    return COST_EXIT.usage;
  };
  const by = v['by'] as string | undefined;
  if (by !== undefined && !['role', 'phase', 'item'].includes(by))
    return usage('--by must be role, phase or item');
  const date = /^\d{4}-\d{2}-\d{2}$/;
  for (const k of ['from', 'to'] as const)
    if (v[k] !== undefined && !date.test(v[k] as string)) return usage(`--${k} must be YYYY-MM-DD`);
  if (v['milestone'] !== undefined && !/^MS-\d{2,}$/.test(v['milestone'] as string))
    return usage('--milestone must look like MS-02');

  const projectDir = path.resolve(io.cwd, (v['project'] as string | undefined) ?? '.');
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    return COST_EXIT.config;
  }
  const budget = (
    cfg.arima as unknown as {
      budget: { per_story_default: number; by_size?: Record<string, number>; project_cap: number };
    }
  ).budget;
  const budgetCfg = {
    perStoryDefault: budget.per_story_default,
    ...(budget.by_size ? { bySize: budget.by_size as { S?: number; M?: number; L?: number } } : {}),
  };

  try {
    const rows = readLedger(projectDir);
    const filter: Filter = {
      ...(v['from'] ? { from: v['from'] as string } : {}),
      ...(v['to'] ? { to: v['to'] as string } : {}),
      ...(v['milestone'] ? { milestone: v['milestone'] as string } : {}),
    };

    if (v['sync'] === true) {
      let runId = v['run-id'] as string | undefined;
      if (runId === undefined) {
        runId = await issueRunId(projectDir);
        await appendEvent(projectDir, {
          type: 'run.start',
          actor: 'orchestrator',
          run_id: runId,
          data: { command: 'cost' },
        });
      }
      const sync = await syncCostLog({ projectDir, runId, rows });
      const fresh = await recordCostAlerts(
        projectDir,
        costAlerts(rows, storyMetas(projectDir, budgetCfg)),
      );
      const out = {
        run_id: runId,
        created: sync.created,
        updated: sync.updated,
        unchanged: sync.unchanged,
        new_alerts: fresh.map((a) => a.detail),
      };
      io.out(
        v['json'] === true
          ? `${JSON.stringify(out)}\n`
          : `cost log: ${sync.created} to create, ${sync.updated} to update, ${sync.unchanged} unchanged (run arima-notion push to apply)\n${fresh.map((a) => `alert: ${a.detail}\n`).join('')}`,
      );
      return COST_EXIT.ok;
    }

    const r = rollup(rows, filter);
    const stories = storyMetas(projectDir, budgetCfg);
    const m = metrics(rows, filter);
    const acc = estimateAccuracy(rows, stories);
    const alerts = costAlerts(rows, stories);
    const tco = totalCostOfOwnership(rows, readManualCosts(projectDir), filter);
    const deliv = delivery({
      events: readEvents(projectDir),
      rows: filterRows(rows, filter),
      projectCap: budget.project_cap,
      humanHours: tco.humanHours,
    });

    if (v['json'] === true) {
      const obj = (mp: Map<string | number, Totals>): Record<string, unknown> =>
        Object.fromEntries(
          [...mp].map(([k, t]) => [
            String(k),
            {
              runs: t.runs,
              cost_usd: usd(t.cost_micro),
              rework_usd: usd(t.rework_micro),
              turns: t.turns,
              duration_ms: t.duration_ms,
            },
          ]),
        );
      io.out(
        `${JSON.stringify({
          estimated: true,
          filter,
          total_usd: usd(r.total.cost_micro),
          runs: r.total.runs,
          overhead_usd: usd(r.overhead.cost_micro),
          by_item: obj(r.byItem),
          by_role: obj(r.byRole),
          by_phase: obj(r.byPhase),
          metrics: m,
          estimate_accuracy: acc,
          alerts: alerts.map((a) => a.detail),
          tco,
          delivery: { ...deliv, items: undefined },
        })}\n`,
      );
      return COST_EXIT.ok;
    }
    if (r.total.runs === 0) {
      io.out('no runs yet: nothing has been spent\n');
      return COST_EXIT.ok;
    }
    const L: string[] = [
      `Cost (estimated USD: consumption, not spend on a seat plan)${Object.keys(filter).length ? ` for ${JSON.stringify(filter)}` : ''}`,
      `Total ${money(r.total.cost_micro)} over ${r.total.runs} runs; overhead with no item ${money(r.overhead.cost_micro)}; project cap ${budget.project_cap}`,
    ];
    if (by === undefined || by === 'role') L.push(...table('By role', r.byRole));
    if (by === undefined || by === 'phase') L.push(...table('By phase', r.byPhase));
    if (by === undefined || by === 'item') L.push(...table('By item', r.byItem));
    L.push(
      '',
      `Rework share ${pct(m.reworkShare)}; cache efficiency ${pct(m.cacheEfficiency)}; turns per run ${m.turnsPerRun?.toFixed(1) ?? 'n/a'}; run failure rate ${pct(m.runFailureRate)}; first-pass QA ${m.firstPassQa.passed}/${m.firstPassQa.of}`,
    );
    L.push(
      '',
      'Estimate accuracy (actual / story budget)',
      ...acc.map(
        (a) =>
          `  ${a.size}  n=${a.n}  ${a.tooFew ? 'too few stories' : `${(a.ratio as number).toFixed(2)}x (${a.actual.toFixed(2)} of ${a.budget.toFixed(2)})`}`,
      ),
    );
    L.push(
      '',
      `Total cost of ownership: agents ${tco.agents.toFixed(2)} + infrastructure ${tco.infrastructure.toFixed(2)} + human ${tco.humanHours}h = ${tco.humanCost.toFixed(2)}${tco.rateMissing ? ' (no hourly rate in .arima/manual-costs.json)' : ''} = ${tco.total.toFixed(2)}`,
    );
    L.push('', ...describeDelivery(deliv));
    if (alerts.length > 0) L.push('', 'Alerts', ...alerts.map((a) => `  ${a.detail}`));
    io.out(`${L.join('\n')}\n`);
    return COST_EXIT.ok;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return COST_EXIT.failed;
  }
}
