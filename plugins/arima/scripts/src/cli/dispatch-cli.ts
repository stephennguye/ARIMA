import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import { rebuildStagingAfterMerge, settingsFrom } from '../env.js';
import { DISPATCH_EXIT, githubFactsFromGh, runDispatch } from '../dispatch.js';
import type { DispatchDeps, DispatchResult } from '../dispatch.js';
import { createNotionPortFromToken } from '../notion/port.js';
import { ghRunner } from '../publish.js';
import type { Io } from './config-cli.js';

export const DISPATCH_USAGE = `Usage: arima-dispatch [--dry-run] [--only <ID>] [--yes-plan <hash>] [--project <dir>] [--json]
  --dry-run   steps 1 to 4 only: print the plan and its hash; writes nothing (no lock, no ledger row, no outbox, no Notion, no git)
  --only      limit the plan to one item (US-, BUG-, INC-, CR-, MS-); every guard still applies
  --yes-plan  assisted mode: the plan hash the human confirmed
Exit codes: 0 ok, 1 run done but sync out or state push failed, 2 usage, 4 nothing to do, 5 phase refusal (not Phase 4 or operations), 10 config invalid, 11 a run holds the lock, 12 kill switch on, 13 budget used up, 14 environment variable missing, 75 usage limit reached`;

export interface DispatchCliDeps extends DispatchDeps {
  /** Test seam: a ready-made DispatchDeps replaces the real Notion and GitHub wiring. */
  wired?: boolean;
}

function render(r: DispatchResult, dry: boolean): string {
  const L: string[] = [];
  if (r.message) L.push(r.message);
  if (r.plan.length > 0 || dry) {
    L.push(
      `Plan (${r.plan.length} unit${r.plan.length === 1 ? '' : 's'}${r.planHash ? `, hash ${r.planHash}` : ''}):`,
    );
    for (const u of r.plan)
      L.push(
        `  ${String(u.order).padStart(2)}. rank ${u.rank} ${u.kind.padEnd(11)} ${u.role.padEnd(10)} ${u.item}${u.reworkReason ? ` (rework: ${u.reworkReason})` : ''}  - ${u.why}`,
      );
    for (const s of r.skipped) L.push(`  skipped ${s.item}: ${s.reason}`);
  }
  for (const d of r.dispatched)
    L.push(
      `  ${d.unit.kind} ${d.unit.item}: ${d.result}${d.reason ? ` (${d.reason})` : ''}${d.note ? ` - ${d.note}` : ''}`,
    );
  for (const w of r.warnings) L.push(`warning: ${w}`);
  if (r.degraded)
    L.push('The run was degraded: Notion was not reachable, so only in-flight work was finished.');
  return `${L.join('\n')}\n`;
}

/** `arima-dispatch`: the daily run (spec 7.2, 14). */
export async function runDispatchCli(
  argv: string[],
  io: Io,
  deps: DispatchCliDeps = {},
): Promise<number> {
  let v: {
    'dry-run'?: boolean;
    only?: string;
    'yes-plan'?: string;
    project?: string;
    json?: boolean;
  };
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        'dry-run': { type: 'boolean' },
        only: { type: 'string' },
        'yes-plan': { type: 'string' },
        project: { type: 'string' },
        json: { type: 'boolean' },
      },
    }).values;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${DISPATCH_USAGE}\n`);
    return DISPATCH_EXIT.usage;
  }
  const projectDir = path.resolve(io.cwd, v.project ?? '.');
  const env = deps.env ?? process.env;
  let wired: DispatchDeps = deps;
  if (deps.wired !== true) {
    const cfg = validateProject(projectDir);
    const a = cfg.arima as unknown as
      | { notion?: { token_env?: string }; github?: { repo: string; machine_token_env?: string } }
      | undefined;
    const nt = a?.notion?.token_env ? env[a.notion.token_env] : undefined;
    const gt = a?.github?.machine_token_env ? env[a.github.machine_token_env] : undefined;
    wired = {
      ...deps,
      env,
      notion: nt ? { port: createNotionPortFromToken(nt) } : null,
      token: gt,
      gh: deps.gh ?? ghRunner,
      // D-47, G-28: after a merge the host rebuilds staging from the default branch (WP-213).
      ...(deps.afterMerge === undefined && cfg.ok && cfg.arima !== undefined
        ? {
            afterMerge: async (): Promise<void> => {
              await rebuildStagingAfterMerge(settingsFrom(projectDir, cfg.arima), { env });
            },
          }
        : {}),
      ...(gt && a?.github
        ? {
            github:
              deps.github ??
              githubFactsFromGh({
                projectDir,
                repo: a.github.repo,
                token: gt,
                gh: deps.gh ?? ghRunner,
              }),
          }
        : {}),
    };
  }
  const r = await runDispatch({
    projectDir,
    ...(v['dry-run'] ? { dryRun: true } : {}),
    ...(v.only ? { only: v.only } : {}),
    ...(v['yes-plan'] ? { yesPlan: v['yes-plan'] } : {}),
    deps: wired,
  });
  if (v.json)
    io.out(
      `${JSON.stringify({ exit: r.exitCode, run_id: r.runId, plan_hash: r.planHash, plan: r.plan, skipped: r.skipped, dispatched: r.dispatched.map((d) => ({ item: d.unit.item, kind: d.unit.kind, result: d.result, reason: d.reason })), warnings: r.warnings, degraded: r.degraded, message: r.message })}\n`,
    );
  else
    (r.exitCode !== 0 && r.exitCode !== 4 && !r.plan.length ? io.err : io.out)(
      render(r, v['dry-run'] === true),
    );
  return r.exitCode;
}
