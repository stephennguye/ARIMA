import path from 'node:path';
import { formatIssue, validateProject } from '../config.js';

export const USAGE = 'Usage: arima-config validate [--project <dir>] [--json]';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
}

/** Runs `arima-config`; returns the process exit code (0 valid, 1 invalid, 2 usage). */
export function runConfigCli(argv: string[], io: Io): number {
  const [command, ...rest] = argv;
  if (command !== 'validate') {
    io.err(`${USAGE}\n`);
    return 2;
  }
  let project = io.cwd;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--project') {
      const value = rest[++i];
      if (value === undefined) {
        io.err(`--project needs a directory\n${USAGE}\n`);
        return 2;
      }
      project = path.resolve(io.cwd, value);
    } else if (arg === '--json') {
      json = true;
    } else {
      io.err(`Unknown argument: ${String(arg)}\n${USAGE}\n`);
      return 2;
    }
  }

  const result = validateProject(project);
  if (json) {
    io.out(
      `${JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings }, null, 2)}\n`,
    );
  } else {
    for (const w of result.warnings) io.err(`${formatIssue(w)}\n`);
    for (const e of result.errors) io.err(`${formatIssue(e)}\n`);
    if (result.ok) io.out('config valid\n');
    else io.err(`config invalid: ${result.errors.length} error(s)\n`);
  }
  return result.ok ? 0 : 1;
}
