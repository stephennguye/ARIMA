import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { guardInteractive } from '../interactive.js';
import type { WaitOptions } from '../interactive.js';
import { StateError, pullState, pushState, stateStatus } from '../state.js';
import type { Io } from './config-cli.js';

export const USAGE = `Usage: arima-state pull [--project <dir>]
       arima-state push --run-id <r-YYYYMMDD-HHMM-NN> [--project <dir>]
       arima-state status [--project <dir>]
Keeps .arima/ on the orphan branch from github.state_branch (default arima-state). Never touches main.`;

function branchesFromConfig(projectDir: string): {
  branch?: string;
  defaultBranch?: string;
  allowPublic?: boolean;
} {
  const file = path.join(projectDir, 'arima.yaml');
  if (!existsSync(file)) return {};
  try {
    const doc = parse(readFileSync(file, 'utf8')) as {
      github?: { state_branch?: string; default_branch?: string; allow_public_state?: boolean };
    };
    return {
      ...(doc.github?.allow_public_state === true ? { allowPublic: true } : {}),
      ...(doc.github?.state_branch ? { branch: doc.github.state_branch } : {}),
      ...(doc.github?.default_branch ? { defaultBranch: doc.github.default_branch } : {}),
    };
  } catch {
    return {};
  }
}

/** Runs `arima-state`; exit 0 ok, 1 failure, 2 usage, 11 a run holds the lock (pull and push wait up to 60 s). */
export async function runStateCli(
  argv: string[],
  io: Io,
  deps: { lock?: Pick<WaitOptions, 'maxWaitMs' | 'pollMs' | 'sleep' | 'clock'> } = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'pull' && command !== 'push' && command !== 'status') {
    io.err(`${USAGE}\n`);
    return 2;
  }
  let values: { project?: string; 'run-id'?: string };
  try {
    values = parseArgs({
      args: rest,
      allowPositionals: false,
      options: { project: { type: 'string' }, 'run-id': { type: 'string' } },
    }).values;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }
  const projectDir = path.resolve(io.cwd, values.project ?? '.');
  const opts = { projectDir, ...branchesFromConfig(projectDir) };
  if (command === 'pull' || command === 'push') {
    // Spec 12.4: wait for a live run (exit 11). The run saving its own state names its id with --run-id.
    const stop = await guardInteractive({
      projectDir,
      command: `arima-state ${command}`,
      holderRunId: values['run-id'],
      ...(deps.lock ?? {}),
      err: io.err,
      note: io.err,
    });
    if (stop !== undefined) return stop;
  }

  try {
    if (command === 'pull') {
      const r = await pullState(opts);
      io.out(r.updated ? `state updated to ${r.head.slice(0, 8)}\n` : 'state already up to date\n');
    } else if (command === 'push') {
      if (values['run-id'] === undefined) {
        io.err(`--run-id is required\n${USAGE}\n`);
        return 2;
      }
      const r = await pushState({ ...opts, runId: values['run-id'] });
      io.out(
        r.committed
          ? `state committed (${r.files} file(s), ${(r.commit ?? '').slice(0, 8)})${r.pushed ? ' and pushed' : ' (no remote, not pushed)'}\n`
          : 'nothing to push\n',
      );
    } else {
      const s = stateStatus(opts);
      io.out(`${JSON.stringify(s)}\n`);
    }
    return 0;
  } catch (e) {
    io.err(`${e instanceof StateError || e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
