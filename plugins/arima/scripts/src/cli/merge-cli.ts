import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import type { TeamConfig } from '../config.js';
import { MERGE_EXIT, MergeRefused, mergePr } from '../merge.js';
import { PublishError } from '../publish.js';
import type { GhRunner } from '../publish.js';
import type { Io } from './config-cli.js';

export const MERGE_USAGE = `Usage: arima-merge --pr <number> --item <ID> --run-id <id> [--project <dir>]
Exit codes: 0 merged, 2 usage, 12 kill switch is on, 14 GitHub token missing, 30 refused (a condition is missing; each is named), 32 GitHub refused or unreachable`;

export interface MergeCliDeps {
  env?: NodeJS.ProcessEnv;
  gh?: GhRunner;
}

/** `arima-merge`: host only, the only merger (D-38). No role can run it. */
export async function runMergeCli(
  argv: string[],
  io: Io,
  deps: MergeCliDeps = {},
): Promise<number> {
  let v: Record<string, string | undefined>;
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        pr: { type: 'string' },
        item: { type: 'string' },
        'run-id': { type: 'string' },
        project: { type: 'string' },
      },
    }).values as Record<string, string | undefined>;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${MERGE_USAGE}\n`);
    return MERGE_EXIT.usage;
  }
  const usage = (m: string): number => {
    io.err(`${m}\n${MERGE_USAGE}\n`);
    return MERGE_EXIT.usage;
  };
  const pr = Number(v['pr']);
  if (!Number.isInteger(pr) || pr < 1) return usage('--pr must be a pull request number');
  if (v['item'] === undefined || !/^[A-Z]{2,4}-\d+$|^none$/.test(v['item']))
    return usage('--item must be an item id like US-112');
  if (v['run-id'] === undefined) return usage('--run-id is required');
  const projectDir = path.resolve(io.cwd, v['project'] ?? '.');
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined || cfg.team === undefined) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    return usage('refusing to run with an invalid config (run: arima-config validate)');
  }
  const github = (
    cfg.arima as unknown as {
      github: {
        repo: string;
        default_branch: string;
        machine_account?: string;
        machine_token_env?: string;
      };
    }
  ).github;
  const env = deps.env ?? process.env;
  try {
    const r = await mergePr({
      projectDir,
      runId: v['run-id'],
      pr,
      item: v['item'],
      repo: github.repo,
      defaultBranch: github.default_branch,
      machineAccount: github.machine_account,
      team: cfg.team as TeamConfig,
      token: github.machine_token_env ? env[github.machine_token_env] : undefined,
      ...(deps.gh ? { gh: deps.gh } : {}),
    });
    io.out(`${JSON.stringify({ merged: true, pr, sha: r.sha, item: r.item })}\n`);
    return MERGE_EXIT.ok;
  } catch (e) {
    if (e instanceof MergeRefused) {
      io.err(`${e.message}\n`);
      return e.exitCode;
    }
    if (e instanceof PublishError) {
      io.err(`${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
}
