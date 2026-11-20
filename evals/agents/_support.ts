// Support for the real-agent evals (WP-150, F10 5.4, G-52). These call `claude -p`, so they spend seat
// usage: they are never part of `npm run eval` or CI, and they do nothing unless ARIMA_REAL_EVALS=1.
// Run by hand:  npm run build && ARIMA_REAL_EVALS=1 npm run eval:agents
//   ARIMA_REAL_EVALS_RUNS   runs per scenario (default 1; the card thresholds assume 5)
//   ARIMA_REAL_EVALS_CAP_USD   total estimated cost allowed for one test file (default 3)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { outputContractFor, taskFor } from '../../plugins/arima/scripts/src/dispatch-units.js';
import type { UnitKind } from '../../plugins/arima/scripts/src/kinds.js';
import type { Role } from '../../plugins/arima/scripts/src/ledger.js';
import { renderPacket } from '../../plugins/arima/scripts/src/packet.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const realEnabled = process.env['ARIMA_REAL_EVALS'] === '1';
export const RUNS = Math.max(1, Number(process.env['ARIMA_REAL_EVALS_RUNS'] ?? 1));
const CAP = Number(process.env['ARIMA_REAL_EVALS_CAP_USD'] ?? 3);

let spent = 0;
export const spentUsd = (): number => spent;

export const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A scratch app repo with the example config, a branch to work on, and the given files committed. */
export function scratchProject(
  files: Record<string, string>,
  branch = 'chore/eval',
  o: { key?: string; stagingPort?: number } = {},
): { dir: string; base: string } {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'arima-real-eval-')), 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Eval'], ['user.email', 'eval@example.com'], ['core.autocrlf', 'false']] as const)
    git(dir, 'config', k, v);
  writeFileSync(
    path.join(dir, 'arima.yaml'),
    readFileSync(path.join(ROOT, 'examples/arima.yaml'), 'utf8')
      .replace('https://staging.example.com', `http://localhost:${o.stagingPort ?? 3000}`)
      .replace('key: TAS', `key: ${o.key ?? 'TAS'}`),
  );
  copyFileSync(path.join(ROOT, 'examples/team.yaml'), path.join(dir, 'team.yaml'));
  writeFileSync(path.join(dir, '.gitignore'), '.arima/\n');
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', branch);
  return { dir, base };
}

export interface RealUnit {
  dir: string;
  role: Role;
  kind: UnitKind;
  item: string;
  phase: number;
  inputs: { ref: string; why: string }[];
  conditions?: string[];
  budgetUsd: number;
  maxTurns: number;
  runId?: string;
  untrusted?: { label: string; source: string; text: string }[];
  /** Replaces the dispatcher's task text for the kind (a scenario that needs a different ask). */
  task?: string;
}

export interface RealResult {
  exit: number;
  costUsd: number;
  packetRunId: string;
  /** The id the engine gave the run (the ledger's), which tags its events. */
  runId: string;
  /** The final message of the run (an `arima-report` block is at its end). */
  message: string;
}

/** Renders the same packet the dispatcher would, runs one real role through the built `arima-run-agent`, returns its final message. */
export function runRealUnit(u: RealUnit): RealResult {
  if (!realEnabled) throw new Error('real-agent evals need ARIMA_REAL_EVALS=1');
  if (spent >= CAP) throw new Error(`the real-eval cost cap (${CAP} USD) is reached; raise ARIMA_REAL_EVALS_CAP_USD on purpose`);
  const packetRunId = u.runId ?? 'r-20261120-0900-01';
  const text = renderPacket({
    run_id: packetRunId,
    max_minutes: 15,
    unit: {
      unit_id: `${packetRunId}-u1`,
      role: u.role,
      item: u.item,
      kind: u.kind,
      phase: u.phase,
      attempt: 1,
      budget_usd: u.budgetUsd,
      max_turns: u.maxTurns,
      worktree: u.dir,
      branch: git(u.dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
      inputs: u.inputs.map((i) => i.ref),
      profile: 'solo-lite',
    },
    inputs: u.inputs,
    conditions: u.conditions ?? ['The profile is solo-lite'],
    task: u.task ?? taskFor({ kind: u.kind, role: u.role, item: u.item, why: 'real-agent eval' }),
    output_contract: outputContractFor(u.kind),
    web: { hosts: [], local_origins: [] },
    untrusted: u.untrusted ?? [],
  });
  const promptFile = path.join(path.dirname(u.dir), `packet-${Math.random().toString(16).slice(2)}.md`);
  writeFileSync(promptFile, text);
  const cli = path.join(ROOT, 'plugins/arima/scripts/dist/arima-run-agent.mjs');
  let exit = 0;
  try {
    execFileSync(
      process.execPath,
      [cli, '--role', u.role, '--item', u.item, '--budget', String(u.budgetUsd), '--max-turns', String(u.maxTurns), '--phase', String(u.phase), '--prompt-file', promptFile, '--cwd', u.dir, '--project', u.dir],
      { stdio: 'pipe', timeout: 20 * 60_000 },
    );
  } catch (e) {
    exit = typeof (e as { status?: number }).status === 'number' ? (e as { status: number }).status : 1;
  }
  const runsDir = path.join(u.dir, '.arima', 'runs');
  const last = readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort().at(-1);
  const rec = JSON.parse(readFileSync(path.join(runsDir, last as string), 'utf8')) as { result_text?: string };
  const ledger = readFileSync(path.join(u.dir, '.arima', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cost_usd: number; run_id: string });
  const costUsd = ledger.at(-1)?.cost_usd ?? 0;
  const runId = ledger.at(-1)?.run_id ?? '';
  spent += costUsd;
  return { exit, costUsd, packetRunId, runId, message: rec.result_text ?? '' };
}
