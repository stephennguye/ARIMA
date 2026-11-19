import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import type { Io } from './config-cli.js';
import { UNIT_KINDS, isUnitKind } from '../kinds.js';
import { isRole, ROLES } from '../roles.js';
import { createNotionPortFromToken } from '../notion/port.js';
import type { PauseSwitchPort } from '../notion/port.js';
import { DispatchRefused, EXIT, agentConfigFrom, runAgent } from '../run-agent.js';
import type { DispatchKillSwitch } from '../run-agent.js';

export interface RunAgentCliDeps {
  env?: NodeJS.ProcessEnv;
  portFactory?: (token: string) => PauseSwitchPort;
}

export const USAGE = `Usage: arima-run-agent --role <role> --item <ID|none> --budget <usd> --max-turns <n> --prompt-file <file>
         [--cwd <worktree>] [--project <dir>] [--phase <0-8>] [--attempt <n>] [--milestone MS-NN]
         [--rework-reason failed_review|failed_qa|vetoed|bug|other] [--session <id>] [--agent <name>]
         [--kind <unit kind>]   (the final message must then end in a valid arima-report block)
Roles: ${ROLES.join(' ')}
Exit codes: 0 pass, 1 failed/error, 2 usage or config, 3 blocked (turn or budget cap), 12 kill switch is on, 13 budget used up, 75 paused (usage limit)`;

const REWORK = ['failed_review', 'failed_qa', 'vetoed', 'bug', 'other'] as const;

/**
 * Variables named in ARIMA_PASSTHROUGH_ENV (comma separated) are passed to the child as given, on
 * top of the allow-list. An explicit, visible opt-in for the human running the command; the tests
 * use it to steer the stub CLI.
 */
function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const names = (process.env['ARIMA_PASSTHROUGH_ENV'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** Runs `arima-run-agent`; prints one JSON summary line on stdout. */
export async function runAgentCli(
  argv: string[],
  io: Io,
  deps: RunAgentCliDeps = {},
): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        role: { type: 'string' },
        item: { type: 'string' },
        budget: { type: 'string' },
        'max-turns': { type: 'string' },
        'prompt-file': { type: 'string' },
        cwd: { type: 'string' },
        project: { type: 'string' },
        phase: { type: 'string' },
        attempt: { type: 'string' },
        milestone: { type: 'string' },
        'rework-reason': { type: 'string' },
        session: { type: 'string' },
        agent: { type: 'string' },
        kind: { type: 'string' },
      },
    }).values as Record<string, string | undefined>;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return EXIT.usage;
  }

  const role = values['role'];
  const item = values['item'];
  const budget = Number(values['budget']);
  const maxTurns = Number(values['max-turns']);
  const promptFile = values['prompt-file'];
  const phase = values['phase'] === undefined ? 4 : Number(values['phase']);
  const attempt = values['attempt'] === undefined ? 1 : Number(values['attempt']);
  const rework = values['rework-reason'];
  const kind = values['kind'];

  const problems: string[] = [];
  if (role === undefined || !isRole(role))
    problems.push(`--role must be one of: ${ROLES.join(', ')}`);
  if (item === undefined || !/^(none|[A-Z]{1,4}-\d+)$/.test(item))
    problems.push('--item must be an ID like US-112, or "none"');
  if (!(budget > 0)) problems.push('--budget must be a positive number (USD)');
  if (!Number.isInteger(maxTurns) || maxTurns <= 0)
    problems.push('--max-turns must be a positive integer');
  if (promptFile === undefined) problems.push('--prompt-file is required');
  if (!Number.isInteger(phase) || phase < 0 || phase > 8) problems.push('--phase must be 0-8');
  if (!Number.isInteger(attempt) || attempt < 1)
    problems.push('--attempt must be a positive integer');
  if (kind !== undefined && !isUnitKind(kind))
    problems.push(`--kind must be one of: ${UNIT_KINDS.join(', ')}`);
  if (rework !== undefined && !(REWORK as readonly string[]).includes(rework)) {
    problems.push(`--rework-reason must be one of: ${REWORK.join(', ')}`);
  }
  if (
    problems.length > 0 ||
    role === undefined ||
    !isRole(role) ||
    item === undefined ||
    promptFile === undefined
  ) {
    io.err(`${problems.join('\n')}\n${USAGE}\n`);
    return EXIT.usage;
  }

  const projectDir = path.resolve(io.cwd, values['project'] ?? '.');
  const config = validateProject(projectDir);
  if (!config.ok || config.arima === undefined) {
    for (const e of config.errors) io.err(`${e.file}:${e.line}: ${e.message}\n`);
    io.err('refusing to run with an invalid config (run: arima-config validate)\n');
    return EXIT.usage;
  }

  // The dispatch re-checks the Notion switch, so the wrapper needs the token and the root page. A
  // missing token is said out loud; the local PAUSE file and the state branch are still checked.
  const arimaDoc = config.arima as { notion?: { root_page_id?: string; token_env?: string } };
  const token = (deps.env ?? process.env)[arimaDoc.notion?.token_env ?? 'ARIMA_NOTION_TOKEN'];
  const rootPageId = arimaDoc.notion?.root_page_id;
  let killSwitch: DispatchKillSwitch = { notion: null };
  if (token && rootPageId) {
    killSwitch = {
      notion: {
        port: (deps.portFactory ?? createNotionPortFromToken)(token),
        rootPageId,
      },
    };
  } else {
    io.err(
      'warning: the Notion token is not set here, so the Notion kill switch is not re-checked before this run (the PAUSE file and the state branch still are)\n',
    );
  }

  try {
    const outcome = await runAgent({
      projectDir,
      role,
      item,
      budgetUsd: budget,
      maxTurns,
      promptFile: path.resolve(io.cwd, promptFile),
      phase,
      attempt,
      config: agentConfigFrom(config.arima, role),
      killSwitch,
      extraEnv: passthroughEnv(),
      ...(values['cwd'] !== undefined ? { cwd: path.resolve(io.cwd, values['cwd']) } : {}),
      ...(values['milestone'] !== undefined ? { milestone: values['milestone'] } : {}),
      ...(rework !== undefined ? { reworkReason: rework as (typeof REWORK)[number] } : {}),
      ...(values['session'] !== undefined ? { sessionId: values['session'] } : {}),
      ...(values['agent'] !== undefined ? { agent: values['agent'] } : {}),
      ...(kind !== undefined && isUnitKind(kind) ? { kind } : {}),
    });
    io.out(
      `${JSON.stringify({
        run_id: outcome.runId,
        result: outcome.result,
        subtype: outcome.subtype,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        cost_usd: outcome.costUsd,
        ...(outcome.sessionId !== undefined ? { session_id: outcome.sessionId } : {}),
      })}\n`,
    );
    return outcome.exitCode;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof DispatchRefused ? e.exitCode : EXIT.usage;
  }
}
