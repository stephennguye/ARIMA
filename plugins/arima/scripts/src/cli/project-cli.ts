import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { INIT_EXIT, runInit } from '../init.js';
import { setKillSwitch } from '../pause.js';
import { createNotionPortFromToken } from '../notion/port.js';
import type { NotionPort, PauseSwitchPort } from '../notion/port.js';
import { StatusError, buildStatus, formatStatus } from '../status.js';
import type { Io } from './config-cli.js';

export interface ProjectCliDeps {
  portFactory?: (token: string) => NotionPort;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

interface Settings {
  rootPageId?: string;
  tokenEnv: string;
  branch?: string;
  defaultBranch?: string;
}

function settingsOf(projectDir: string): Settings {
  const out: Settings = { tokenEnv: 'ARIMA_NOTION_TOKEN' };
  const file = path.join(projectDir, 'arima.yaml');
  if (!existsSync(file)) return out;
  try {
    const doc = parse(readFileSync(file, 'utf8')) as {
      notion?: { root_page_id?: string; token_env?: string };
      github?: { state_branch?: string; default_branch?: string };
    };
    if (doc.notion?.root_page_id && !doc.notion.root_page_id.startsWith('<'))
      out.rootPageId = doc.notion.root_page_id;
    if (doc.notion?.token_env) out.tokenEnv = doc.notion.token_env;
    if (doc.github?.state_branch) out.branch = doc.github.state_branch;
    if (doc.github?.default_branch) out.defaultBranch = doc.github.default_branch;
  } catch {
    /* validation reports a broken arima.yaml */
  }
  return out;
}

const bad = (io: Io, usage: string, message: string): number => {
  io.err(`${message}\n${usage}\n`);
  return 2;
};

export const INIT_USAGE = `Usage: arima-init --brief <file> [--project <dir>] [--root <notion-page-id>] [--skip-state] [--json]
Exit codes: 0 ok, 2 usage, 3 brief has gaps, 4 Notion workspace does not match the template, 5 Notion writes failed, 6 brief contains a secret, 10-14 preflight failed (see arima-preflight)`;

/** `arima-init`: the deterministic core of /arima:init. */
export async function runInitCli(
  argv: string[],
  io: Io,
  deps: ProjectCliDeps = {},
): Promise<number> {
  let v: {
    brief?: string;
    project?: string;
    root?: string;
    'skip-state'?: boolean;
    json?: boolean;
  };
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        brief: { type: 'string' },
        project: { type: 'string' },
        root: { type: 'string' },
        'skip-state': { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }).values;
  } catch (e) {
    return bad(io, INIT_USAGE, e instanceof Error ? e.message : String(e));
  }
  if (v.brief === undefined) return bad(io, INIT_USAGE, '--brief is required');
  const projectDir = path.resolve(io.cwd, v.project ?? '.');
  const briefFile = path.resolve(io.cwd, v.brief);
  if (!existsSync(briefFile)) return bad(io, INIT_USAGE, `brief file not found: ${briefFile}`);

  const s = settingsOf(projectDir);
  const env = deps.env ?? process.env;
  const token = env[s.tokenEnv];
  if (!token)
    return bad(
      io,
      INIT_USAGE,
      `environment variable ${s.tokenEnv} is not set (the Notion integration token)`,
    );

  const result = await runInit({
    projectDir,
    briefFile,
    port: (deps.portFactory ?? createNotionPortFromToken)(token),
    env,
    ...(v.root !== undefined ? { rootPageId: v.root } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(v['skip-state'] === true ? { skipState: true } : {}),
    log: (l) => (v.json === true ? undefined : io.out(`${l}\n`)),
  });

  if (v.json === true) {
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    return result.exitCode;
  }
  if (result.gaps.length > 0) {
    io.out('The brief is not complete. Fill these in and run again:\n');
    for (const g of result.gaps) io.out(`  - ${g}\n`);
  }
  for (const p of result.problems) io.out(`problem: ${p}\n`);
  for (const w of result.warnings) io.out(`warning: ${w}\n`);
  if (result.ok) {
    io.out(
      `init ok (run ${result.runId ?? '?'}): ${result.created.length} created, ${result.existed.length} already present\n`,
    );
    for (const c of result.created) io.out(`  + ${c}\n`);
    for (const c of result.existed) io.out(`  = ${c}\n`);
    io.out('Next steps for you:\n');
    for (const n of result.nextSteps) io.out(`  - ${n}\n`);
  } else {
    io.out(`init failed (exit ${result.exitCode})\n`);
  }
  return result.exitCode === INIT_EXIT.ok ? 0 : result.exitCode;
}

export const STATUS_USAGE = 'Usage: arima-status [--project <dir>] [--json]';

/** `arima-status`: phase, gates, open questions, board and budget from the mirror and ledger. */
export function runStatusCli(argv: string[], io: Io, deps: ProjectCliDeps = {}): number {
  let v: { project?: string; json?: boolean };
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: { project: { type: 'string' }, json: { type: 'boolean' } },
    }).values;
  } catch (e) {
    return bad(io, STATUS_USAGE, e instanceof Error ? e.message : String(e));
  }
  try {
    const report = buildStatus(path.resolve(io.cwd, v.project ?? '.'), deps.now);
    io.out(v.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));
    return 0;
  } catch (e) {
    if (e instanceof StatusError) {
      io.err(`${e.message}\n`);
      for (const p of e.problems) io.err(`  ${p}\n`);
      return 10;
    }
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export const PAUSE_USAGE =
  'Usage: arima-pause [--resume] [--reason <text>] [--project <dir>] [--skip-notion] [--no-state]';

/** `arima-pause`: sets or clears the kill switch (Notion to-do and PAUSE file). */
export async function runPauseCli(
  argv: string[],
  io: Io,
  deps: ProjectCliDeps = {},
): Promise<number> {
  let v: {
    resume?: boolean;
    reason?: string;
    project?: string;
    'skip-notion'?: boolean;
    'no-state'?: boolean;
  };
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        resume: { type: 'boolean' },
        reason: { type: 'string' },
        project: { type: 'string' },
        'skip-notion': { type: 'boolean' },
        'no-state': { type: 'boolean' },
      },
    }).values;
  } catch (e) {
    return bad(io, PAUSE_USAGE, e instanceof Error ? e.message : String(e));
  }
  const projectDir = path.resolve(io.cwd, v.project ?? '.');
  const s = settingsOf(projectDir);
  const token = (deps.env ?? process.env)[s.tokenEnv];
  let notion: { port: PauseSwitchPort; rootPageId: string } | null = null;
  if (v['skip-notion'] !== true && token && s.rootPageId) {
    notion = {
      port: (deps.portFactory ?? createNotionPortFromToken)(token),
      rootPageId: s.rootPageId,
    };
  }
  const on = v.resume !== true;
  const r = await setKillSwitch({
    projectDir,
    on,
    ...(v.reason !== undefined ? { reason: v.reason } : {}),
    notion,
    saveState: v['no-state'] !== true,
    ...(s.branch ? { branch: s.branch } : {}),
    ...(s.defaultBranch ? { defaultBranch: s.defaultBranch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  for (const m of r.messages) io.out(`${m}\n`);
  if (on) {
    io.out('ARIMA is paused: the next run will stop at preflight.\n');
    return 0;
  }
  if (r.stillPausedInNotion) {
    io.err(
      'Resumed locally, but the Notion switch could not be cleared: untick "Pause ARIMA" on the Notion root page.\n',
    );
    return 1;
  }
  io.out('ARIMA is resumed.\n');
  return 0;
}
