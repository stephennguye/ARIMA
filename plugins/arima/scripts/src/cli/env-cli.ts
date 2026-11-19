import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import {
  ENV_EXIT,
  EnvError,
  backupEnv,
  checkCompose,
  downEnv,
  logsEnv,
  restoreTest,
  settingsFrom,
  smokeEnv,
  statusEnv,
  upEnv,
} from '../env.js';
import type { EnvDeps } from '../env.js';
import type { Io } from './config-cli.js';

export const ENV_USAGE = `Usage: arima-env check [--file <compose file>] [--project <dir>]
       arima-env status <staging|preview-N> [--json]
       arima-env logs <staging|preview-N> [--tail <n>] [--service <name>]
       arima-env smoke <staging|preview-N> [--timeout <seconds>]
       arima-env up <staging|preview-N> [--ref <branch or sha>] [--run-id <id>] [--timeout <seconds>] [--json]
       arima-env down <staging|preview-N>
       arima-env backup <staging|preview-N>
       arima-env restore-test <staging|preview-N>
Environments: staging and preview-<pr> only. Production is refused (exit 70); it deploys only through arima-release.
Exit codes: 0 ok, 1 failed, 2 usage, 10 config invalid, 12 kill switch on, 14 Docker not running, 70 refused (production or unknown environment), 71 smoke failed (staging: previous version restored), 72 capacity limit`;

/** `arima-env`: the only way a container is started, stopped or removed for staging and preview. */
export async function runEnvCli(argv: string[], io: Io, deps: EnvDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  let p: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    p = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        file: { type: 'string' },
        ref: { type: 'string' },
        tail: { type: 'string' },
        service: { type: 'string' },
        timeout: { type: 'string' },
        'run-id': { type: 'string' },
        project: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${ENV_USAGE}\n`);
    return ENV_EXIT.usage;
  }
  const v = p.values;
  const str = (k: string): string | undefined =>
    typeof v[k] === 'string' ? (v[k] as string) : undefined;
  const num = (k: string): number | undefined => {
    const s = str(k);
    return s === undefined || !/^[0-9]+$/.test(s) ? undefined : Number(s);
  };
  const usage = (m: string): number => {
    io.err(`${m}\n${ENV_USAGE}\n`);
    return ENV_EXIT.usage;
  };
  const rid = str('run-id');
  if (rid !== undefined && !/^r-[0-9]{8}-[0-9]{4}-[0-9]{2,}$/.test(rid))
    return usage('--run-id is not a run id (r-YYYYMMDD-HHMM-NN)');
  const commands = ['check', 'status', 'logs', 'smoke', 'up', 'down', 'backup', 'restore-test'];
  if (command === undefined || !commands.includes(command)) return usage('unknown command');

  const target = p.positionals[0];
  if (command !== 'check') {
    if (target === undefined || p.positionals.length !== 1)
      return usage('exactly one environment is required');
  } else if (p.positionals.length > 0) return usage('check takes no environment');

  const projectDir = path.resolve(io.cwd, str('project') ?? '.');
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    io.err('refusing to run with an invalid config (run: arima-config validate)\n');
    return ENV_EXIT.config;
  }
  const s = settingsFrom(projectDir, cfg.arima);
  const d: EnvDeps = { ...deps, ...(str('run-id') ? { runId: str('run-id') as string } : {}) };
  const json = v['json'] === true;

  try {
    switch (command) {
      case 'check': {
        const r = await checkCompose(s, str('file'), d);
        if (json) io.out(`${JSON.stringify(r)}\n`);
        else {
          for (const x of r.violations) io.out(`${x.rule}\t${x.where}\t${x.detail}\n`);
          io.out(
            r.ok
              ? `compose file passes the design check (docker compose config: ${r.validated})\n`
              : `compose file fails the design check${r.detail ? `: ${r.detail}` : ''}\n`,
          );
        }
        return r.ok ? ENV_EXIT.ok : ENV_EXIT.failed;
      }
      case 'status': {
        const r = await statusEnv(s, target as string, d);
        io.out(
          json
            ? `${JSON.stringify(r)}\n`
            : `${r.environment} (${r.project})${r.deployed ? ` at ${r.deployed.ref.slice(0, 12)} port ${r.deployed.port}` : ''}\n${r.services.map((x) => `  ${x.service}\t${x.state}\t${x.health}\n`).join('') || '  not running\n'}`,
        );
        return ENV_EXIT.ok;
      }
      case 'logs': {
        const t = str('tail');
        if (t !== undefined && num('tail') === undefined) return usage('--tail must be a number');
        io.out(
          `${await logsEnv(s, target as string, {
            ...d,
            ...(num('tail') !== undefined ? { tail: num('tail') as number } : {}),
            ...(str('service') ? { service: str('service') as string } : {}),
          })}\n`,
        );
        return ENV_EXIT.ok;
      }
      case 'smoke': {
        const r = await smokeEnv(s, target as string, {
          ...d,
          ...(num('timeout') !== undefined ? { timeoutS: num('timeout') as number } : {}),
        });
        io.out(
          json
            ? `${JSON.stringify(r)}\n`
            : `smoke ok: ${r.url} ${r.status ?? ''} after ${r.attempts} attempt(s)\n`,
        );
        return ENV_EXIT.ok;
      }
      case 'up': {
        const r = await upEnv(s, target as string, {
          ...d,
          ...(str('ref') ? { ref: str('ref') as string } : {}),
          ...(num('timeout') !== undefined ? { timeoutS: num('timeout') as number } : {}),
        });
        io.out(
          json
            ? `${JSON.stringify(r)}\n`
            : `${r.environment} is up at ${r.ref.slice(0, 12)}: ${r.url} (smoke ok)${r.evicted ? `; removed the oldest preview ${r.evicted}` : ''}\n`,
        );
        return ENV_EXIT.ok;
      }
      case 'down':
        await downEnv(s, target as string, d);
        io.out(`${target as string} is down\n`);
        return ENV_EXIT.ok;
      case 'backup': {
        const files = await backupEnv(s, target as string, d);
        io.out(json ? `${JSON.stringify(files)}\n` : `${files.map((f) => `${f}\n`).join('')}`);
        return ENV_EXIT.ok;
      }
      default: {
        const r = await restoreTest(s, target as string, d);
        io.out(
          json
            ? `${JSON.stringify(r)}\n`
            : `restore test ${r.ok ? 'passed' : 'FAILED'}: ${r.checked.length} volume(s) restored${r.failed.length ? `, failed: ${r.failed.join(', ')}` : ''}\n`,
        );
        return r.ok ? ENV_EXIT.ok : ENV_EXIT.failed;
      }
    }
  } catch (e) {
    if (!(e instanceof EnvError)) throw e;
    io.err(`${e.message}\n`);
    return e.exit;
  }
}
