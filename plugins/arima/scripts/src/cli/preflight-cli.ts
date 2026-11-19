import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import { createNotionPortFromToken } from '../notion/port.js';
import type { PauseSwitchPort } from '../notion/port.js';
import { PREFLIGHT_EXIT, runPreflight } from '../preflight.js';
import { releaseRunLock } from '../runlock.js';
import type { Io } from './config-cli.js';

export const USAGE = `Usage: arima-preflight [check] [--project <dir>] [--acquire <run-id>] [--skip-notion] [--no-github] [--json]
       arima-preflight release --run-id <run-id> [--project <dir>]
Exit codes: 0 ok, 2 usage, 10 config invalid, 11 run lock held, 12 kill switch on, 13 budget exhausted, 14 env var missing`;

export interface PreflightCliDeps {
  /** Overrides how the Notion port is built (tests). */
  notionFactory?: (token: string) => PauseSwitchPort;
  env?: NodeJS.ProcessEnv;
}

/** Runs `arima-preflight`. */
export async function runPreflightCli(
  argv: string[],
  io: Io,
  deps: PreflightCliDeps = {},
): Promise<number> {
  const [first, ...rest] = argv;
  const command = first === 'release' || first === 'check' ? first : 'check';
  const args = first === 'release' || first === 'check' ? rest : argv;
  let values: {
    project?: string;
    acquire?: string;
    'skip-notion'?: boolean;
    json?: boolean;
    'no-github'?: boolean;
    'run-id'?: string;
  };
  try {
    values = parseArgs({
      args,
      allowPositionals: false,
      options: {
        project: { type: 'string' },
        acquire: { type: 'string' },
        'run-id': { type: 'string' },
        'skip-notion': { type: 'boolean' },
        json: { type: 'boolean' },
        'no-github': { type: 'boolean' },
      },
    }).values;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return PREFLIGHT_EXIT.usage;
  }
  const projectDir = path.resolve(io.cwd, values.project ?? '.');
  const env = deps.env ?? process.env;

  if (command === 'release') {
    if (values['run-id'] === undefined) {
      io.err(`--run-id is required\n${USAGE}\n`);
      return PREFLIGHT_EXIT.usage;
    }
    const released = releaseRunLock(projectDir, values['run-id']);
    io.out(released ? 'lock released\n' : 'no lock held by that run\n');
    return PREFLIGHT_EXIT.ok;
  }

  // Build the Notion port only when the token is present; its absence is reported by the env check.
  let notion: PauseSwitchPort | null = null;
  if (values['skip-notion'] !== true) {
    const cfg = validateProject(projectDir);
    const tokenEnv = (cfg.arima as { notion?: { token_env?: string } } | undefined)?.notion
      ?.token_env;
    const token = tokenEnv ? env[tokenEnv] : undefined;
    if (token) notion = (deps.notionFactory ?? createNotionPortFromToken)(token);
  }

  const result = await runPreflight({
    projectDir,
    env,
    notion,
    needs: { github: values['no-github'] !== true },
    ...(values.acquire !== undefined ? { acquireFor: values.acquire } : {}),
  });

  if (values.json === true) {
    io.out(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const c of result.checks) {
      io.out(`${c.ok ? 'PASS' : 'FAIL'} ${c.check}: ${c.detail}\n`);
      if (c.warning) io.out(`     warning: ${c.warning}\n`);
    }
    io.out(result.ok ? 'preflight ok\n' : `preflight failed (exit ${result.exitCode})\n`);
  }
  return result.exitCode;
}
