import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import type { Io } from './config-cli.js';
import { isRole, ROLES } from '../roles.js';
import { DispatchRefused, EXIT, agentConfigFrom, runAgent } from '../run-agent.js';

export const USAGE = `Usage: arima-run-agent --role <role> --item <ID|none> --budget <usd> --max-turns <n> --prompt-file <file>
         [--cwd <worktree>] [--project <dir>] [--phase <0-8>] [--attempt <n>] [--milestone MS-NN]
         [--rework-reason failed_review|failed_qa|vetoed|bug|other] [--session <id>] [--agent <name>]
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
export async function runAgentCli(argv: string[], io: Io): Promise<number> {
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
      extraEnv: passthroughEnv(),
      ...(values['cwd'] !== undefined ? { cwd: path.resolve(io.cwd, values['cwd']) } : {}),
      ...(values['milestone'] !== undefined ? { milestone: values['milestone'] } : {}),
      ...(rework !== undefined ? { reworkReason: rework as (typeof REWORK)[number] } : {}),
      ...(values['session'] !== undefined ? { sessionId: values['session'] } : {}),
      ...(values['agent'] !== undefined ? { agent: values['agent'] } : {}),
    });
    io.out(
      `${JSON.stringify({
        run_id: outcome.runId,
        result: outcome.result,
        subtype: outcome.subtype,
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
