import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import { appendEvent } from '../events.js';
import { guardInteractive } from '../interactive.js';
import type { WaitOptions } from '../interactive.js';
import { checkKillSwitch } from '../killswitch.js';
import {
  MILESTONE_MAX_POINTS,
  MILESTONE_MIN_POINTS,
  planMilestone,
  queueMilestone,
  remainingBudget,
  storiesForPlan,
} from '../plan.js';
import type { MilestonePlan } from '../plan.js';
import { issueRunId } from '../runid.js';
import type { Io } from './config-cli.js';

export const PLAN_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  nothing: 4,
  config: 10,
  locked: 11,
  killSwitch: 12,
  budget: 13,
} as const;

export const PLAN_USAGE = `Usage: arima-plan [--milestone MS-NN] [--dry-run] [--json] [--run-id <id>] [--project <dir>]
Builds (or revises, with --milestone) a milestone of ${MILESTONE_MIN_POINTS} to ${MILESTONE_MAX_POINTS} points (S 1, M 2, L 4), filled by priority; a story is never split.
Queues the Notion Milestones row; run arima-notion push to apply. --dry-run writes nothing.
Exit codes: 0 ok, 1 failed, 2 usage, 4 nothing to plan, 10 config invalid, 11 a run holds the lock, 12 kill switch is on, 13 the story budgets exceed the remaining project budget`;

export interface PlanCliDeps {
  lock?: Partial<WaitOptions>;
}

function describe(p: MilestonePlan, remaining: number): string {
  const lines = [
    `${p.revise ?? 'new milestone'}: ${p.points} points, ${p.stories.length} stories, budget ${p.budget} USD (remaining project budget ${remaining} USD)`,
    ...p.stories.map(
      (s) =>
        `  ${s.id}\t${s.size}\t${s.points}\t${s.budget} USD${s.pinned ? '\t(already started, kept)' : ''}`,
    ),
    ...p.skipped.map((s) => `  skipped ${s.id}: ${s.reason}`),
    ...p.warnings.map((w) => `  warning: ${w}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** `arima-plan`: the milestone planner (WP-216). */
export async function runPlanCli(argv: string[], io: Io, deps: PlanCliDeps = {}): Promise<number> {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        milestone: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        'run-id': { type: 'string' },
        project: { type: 'string' },
      },
    }).values;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${PLAN_USAGE}\n`);
    return PLAN_EXIT.usage;
  }
  const revise = typeof v['milestone'] === 'string' ? v['milestone'] : undefined;
  if (revise !== undefined && !/^MS-\d{2,}$/.test(revise)) {
    io.err(`--milestone must look like MS-01\n${PLAN_USAGE}\n`);
    return PLAN_EXIT.usage;
  }
  const rid = typeof v['run-id'] === 'string' ? v['run-id'] : undefined;
  if (rid !== undefined && !/^r-\d{8}-\d{4}-\d{2,}$/.test(rid)) {
    io.err(`--run-id is not a run id\n${PLAN_USAGE}\n`);
    return PLAN_EXIT.usage;
  }
  const projectDir = path.resolve(io.cwd, typeof v['project'] === 'string' ? v['project'] : '.');
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    return PLAN_EXIT.config;
  }
  const budget = (
    cfg.arima as unknown as {
      budget: { per_story_default: number; by_size?: Record<string, number>; project_cap: number };
    }
  ).budget;
  const dry = v['dry-run'] === true;

  if (revise !== undefined) {
    const { readMirror, findRow } = await import('../notion/mirror.js');
    if (findRow(readMirror(projectDir, 'milestones'), revise) === undefined) {
      io.err(`${revise} is not in the Notion mirror; run arima-notion pull first\n`);
      return PLAN_EXIT.failed;
    }
  }

  const remaining = remainingBudget(projectDir, budget.project_cap);
  const plan = planMilestone({
    stories: storiesForPlan(projectDir, {
      perStoryDefault: budget.per_story_default,
      ...(budget.by_size
        ? { bySize: budget.by_size as { S?: number; M?: number; L?: number } }
        : {}),
    }),
    ...(revise !== undefined ? { revise } : {}),
    remainingBudget: remaining,
  });

  const show = (): void =>
    io.out(
      v['json'] === true
        ? `${JSON.stringify({ plan, remaining_budget: remaining })}\n`
        : describe(plan, remaining),
    );

  if (plan.stories.length === 0) {
    show();
    io.err('nothing to plan: no sized, unstarted story fits\n');
    return PLAN_EXIT.nothing;
  }
  if (plan.overBudget !== undefined) {
    show();
    io.err(
      `refusing: the story budgets need ${plan.overBudget.needed} USD but ${plan.overBudget.remaining} USD of the project budget remain (spec 13.5)\n`,
    );
    return PLAN_EXIT.budget;
  }
  if (dry) {
    show();
    return PLAN_EXIT.ok;
  }

  // Writing: the kill switch first, then wait for a live run, as the other interactive commands do.
  if ((await checkKillSwitch(projectDir, null)).on) {
    io.err('refusing: the kill switch is on\n');
    return PLAN_EXIT.killSwitch;
  }
  const stop = await guardInteractive({
    projectDir,
    command: 'arima-plan',
    holderRunId: rid,
    ...(deps.lock ?? {}),
    err: io.err,
    note: io.err,
  });
  if (stop !== undefined) return stop;
  let runId = rid;
  if (runId === undefined) {
    runId = await issueRunId(projectDir);
    await appendEvent(projectDir, {
      type: 'run.start',
      actor: 'orchestrator',
      run_id: runId,
      data: { command: 'plan' },
    });
  }
  try {
    const q = await queueMilestone({ projectDir, runId, plan });
    show();
    io.out(`queued ${q.milestone} (run arima-notion push to apply)\n`);
    return PLAN_EXIT.ok;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return PLAN_EXIT.failed;
  }
}
