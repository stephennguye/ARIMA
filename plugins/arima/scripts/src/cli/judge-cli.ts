import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { JUDGE_EXIT, JUDGE_MAX_BUDGET_USD, runJudge } from '../judge.js';
import type { Io } from './config-cli.js';

export const JUDGE_USAGE = `Usage: arima-judge --checkpoint <J0..J5|J-agent:<role>> --paths <file> --questions <file> [--ref <commit>] [--max-budget-usd <n>] [--repo <dir>]
Runs the independent judge (docs/process/JUDGE.md) on a COPY of the repository at a commit: read-only, no Notion or GitHub token, a hard budget cap (at most ${JUDGE_MAX_BUDGET_USD} USD, default ${JUDGE_MAX_BUDGET_USD}).
--paths is a file with one path per line; --questions is a file with the questions (not conclusions). The report is saved under docs/process/reviews/ with a response table.
Exit codes: 0 proceed, 1 proceed after fixes, 2 usage, 3 the judge failed or its report is not in the required shape (nothing saved), 20 stop (the builder halts until the owner has read it)`;

/** `arima-judge`: human or builder run; no role may run it (it spends seat usage). */
export async function runJudgeCli(argv: string[], io: Io): Promise<number> {
  let v: Record<string, string | undefined>;
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        checkpoint: { type: 'string' },
        paths: { type: 'string' },
        questions: { type: 'string' },
        ref: { type: 'string' },
        'max-budget-usd': { type: 'string' },
        repo: { type: 'string' },
      },
    }).values as Record<string, string | undefined>;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${JUDGE_USAGE}\n`);
    return JUDGE_EXIT.usage;
  }
  const need = ['checkpoint', 'paths', 'questions'].filter((k) => v[k] === undefined);
  if (need.length > 0) {
    io.err(`missing: ${need.map((k) => `--${k}`).join(', ')}\n${JUDGE_USAGE}\n`);
    return JUDGE_EXIT.usage;
  }
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(path.resolve(io.cwd, f), 'utf8');
    } catch {
      io.err(`cannot read ${f}\n`);
      return undefined;
    }
  };
  const paths = read(v['paths'] as string);
  const questions = read(v['questions'] as string);
  if (paths === undefined || questions === undefined) return JUDGE_EXIT.usage;
  const cap = v['max-budget-usd'] === undefined ? undefined : Number(v['max-budget-usd']);
  if (cap !== undefined && !Number.isFinite(cap)) {
    io.err(`--max-budget-usd must be a number\n${JUDGE_USAGE}\n`);
    return JUDGE_EXIT.usage;
  }
  const r = await runJudge({
    repoDir: path.resolve(io.cwd, v['repo'] ?? '.'),
    checkpoint: v['checkpoint'] as string,
    paths: paths
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
    questions,
    ...(v['ref'] ? { ref: v['ref'] } : {}),
    ...(cap !== undefined ? { maxBudgetUsd: cap } : {}),
  });
  (r.exit === JUDGE_EXIT.proceed || r.exit === JUDGE_EXIT.fixes || r.exit === JUDGE_EXIT.stop
    ? io.out
    : io.err)(
    `${r.message}${r.costUsd !== undefined ? ` (about ${r.costUsd.toFixed(2)} USD)` : ''}\n`,
  );
  return r.exit;
}
