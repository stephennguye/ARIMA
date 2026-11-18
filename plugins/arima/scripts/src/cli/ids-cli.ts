import path from 'node:path';
import { ID_PREFIXES, formatId, nextId, readCounters } from '../ids.js';
import type { IdPrefix } from '../ids.js';
import type { Io } from './config-cli.js';

export const USAGE = `Usage: arima-ids next <PREFIX> [--project <dir>]
       arima-ids show [--project <dir>]
Prefixes: ${ID_PREFIXES.join(' ')}`;

/** Runs `arima-ids`; exit 0 ok, 1 runtime failure, 2 usage / unknown prefix. */
export async function runIdsCli(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  let project = io.cwd;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--project') {
      const value = rest[++i];
      if (value === undefined) {
        io.err(`--project needs a directory\n${USAGE}\n`);
        return 2;
      }
      project = path.resolve(io.cwd, value);
    } else if (arg.startsWith('--')) {
      io.err(`Unknown argument: ${arg}\n${USAGE}\n`);
      return 2;
    } else {
      positional.push(arg);
    }
  }

  if (command === 'next') {
    const prefix = positional[0];
    if (prefix === undefined || positional.length !== 1) {
      io.err(`${USAGE}\n`);
      return 2;
    }
    try {
      io.out(`${await nextId(project, prefix)}\n`);
      return 0;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      io.err(`${message}\n`);
      return message.startsWith('Unknown ID prefix') ? 2 : 1;
    }
  }

  if (command === 'show' && positional.length === 0) {
    try {
      const counters = readCounters(project);
      for (const p of ID_PREFIXES) {
        const n = counters[p as IdPrefix];
        if (n !== undefined) io.out(`${p}\t${n}\tlast ${formatId(p, n)}\n`);
      }
      return 0;
    } catch (e) {
      io.err(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  io.err(`${USAGE}\n`);
  return 2;
}
