import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { budgetStatus } from './budget.js';
import { appendEvent } from './events.js';
import { pauseFile } from './killswitch.js';
import { buildLedgerRow, appendLedgerRow, parseClaudeResult, readLedger } from './ledger.js';
import type { ClaudeResult, LedgerRow, Role, RunContext, RunResult } from './ledger.js';
import { pluginRoot } from './lib/paths.js';
import { findSecrets } from './lib/secrets.js';
import {
  allowedTools,
  configKey,
  deniedTools,
  mayHoldGithubToken,
  mayHoldNotionToken,
} from './roles.js';
import { issueRunId } from './runid.js';

/** Process exit codes of `arima-run-agent`. */
export const EXIT = { ok: 0, failed: 1, usage: 2, blocked: 3, paused: 75 } as const;

export interface AgentConfig {
  projectKey: string;
  perRunCap: number;
  maxRunMinutes: number;
  /** Model id for the role, or undefined when the config still holds a placeholder. */
  model?: string | undefined;
  tier?: 'strong' | 'standard' | 'fast' | undefined;
  notionTokenEnv: string;
  githubTokenEnv?: string | undefined;
  /** runtime.auth: with 'api_key' the ANTHROPIC_* variables are passed to the child. */
  auth?: 'seat' | 'api_key' | undefined;
  /** Caps re-checked before every dispatch (spec §13.5). Optional so callers may omit them. */
  projectCap?: number | undefined;
  dailyCap?: number | undefined;
}

/** A dispatch the wrapper refuses because a hard stop is on. `exitCode` matches arima-preflight. */
export class DispatchRefused extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export interface RunAgentOptions {
  projectDir: string;
  role: Role;
  item: string;
  budgetUsd: number;
  maxTurns: number;
  promptFile: string;
  cwd?: string;
  phase: number;
  attempt?: number;
  milestone?: string | null;
  reworkReason?: RunContext['rework_reason'];
  /** Resume an earlier session (cost in the ledger is then the difference, spec §13.6). */
  sessionId?: string;
  agent?: string;
  config: AgentConfig;
  /** Executable to run instead of `claude` (tests, or a non-PATH install). */
  claudeBin?: string;
  /** The environment the child is built FROM (an allow-list is applied); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Variables passed to the child as given, on top of the allow-list (tests, explicit opt-ins). */
  extraEnv?: Record<string, string>;
  now?: Date;
}

export interface RunAgentOutcome {
  runId: string;
  result: RunResult;
  subtype: string;
  costUsd: number;
  sessionId?: string;
  exitCode: number;
}

const USAGE_LIMIT_RE =
  /usage limit|limit reached|hit your (?:\w+ )?limit|limit (?:will )?resets?|5-hour limit|weekly limit|session limit/i;

/** True when claude stopped because the seat's session or weekly limit was reached (spec §4.4). */
export function isUsageLimit(
  result: ClaudeResult | undefined,
  stderr: string,
  stdout: string,
): boolean {
  if (result !== undefined) {
    return result.is_error === true && USAGE_LIMIT_RE.test(result.result ?? '');
  }
  return USAGE_LIMIT_RE.test(stderr) || USAGE_LIMIT_RE.test(stdout);
}

/** Kills a process and everything it started (a hung claude can have children). */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Variables every child run may inherit: how to find programs, the home folder, locale, proxies. */
const PASS_THROUGH = new Set(
  [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'windir',
    'COMSPEC',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'ALLUSERSPROFILE',
    'PUBLIC',
    'SystemDrive',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERNAME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'TERM',
    'COLORTERM',
    'TZ',
    'NO_COLOR',
    'FORCE_COLOR',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'DISPLAY',
  ].map((n) => n.toLowerCase()),
);
const PASS_THROUGH_PREFIXES = ['lc_', 'claude_', 'otel_'];

function isPassThrough(name: string): boolean {
  const n = name.toLowerCase();
  return PASS_THROUGH.has(n) || PASS_THROUGH_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * Environment for the child run (spec §11.3, §13.1): an allow-list, role-specific tokens, ARIMA's
 * own control variables, and OTEL attribution.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  o: {
    role: Role;
    item: string;
    phase: number;
    runId: string;
    projectKey: string;
    config: AgentConfig;
    /** Lets the hooks find .arima/ from a worktree (spec §11.3 audit). */
    projectDir?: string;
  },
): NodeJS.ProcessEnv {
  // An ALLOW-LIST, not a block-list: a run gets what it needs to work and nothing else, so cloud
  // keys, database URLs and other tokens in the parent environment never reach an agent.
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && isPassThrough(name)) env[name] = value;
  }
  if (o.config.auth === 'api_key') {
    for (const [name, value] of Object.entries(base)) {
      if (value !== undefined && /^ANTHROPIC_/i.test(name)) env[name] = value;
    }
  }
  if (mayHoldNotionToken(o.role)) {
    const v = base[o.config.notionTokenEnv];
    if (v !== undefined) env[o.config.notionTokenEnv] = v;
  }
  if (mayHoldGithubToken(o.role) && o.config.githubTokenEnv !== undefined) {
    const v = base[o.config.githubTokenEnv];
    if (v !== undefined) {
      env[o.config.githubTokenEnv] = v;
      env['GH_TOKEN'] = v; // what the gh CLI reads
    }
  }
  if (o.projectDir !== undefined) env['ARIMA_PROJECT_DIR'] = o.projectDir;
  env['ARIMA_RUN_ID'] = o.runId;
  env['ARIMA_ROLE'] = o.role;
  env['ARIMA_ITEM'] = o.item;
  const attrs = [
    `arima.project=${safe(o.projectKey)}`,
    `arima.phase=${o.phase}`,
    `arima.item=${safe(o.item)}`,
    `arima.role=${safe(o.role)}`,
    `arima.run_id=${safe(o.runId)}`,
  ].join(',');
  env['OTEL_RESOURCE_ATTRIBUTES'] = env['OTEL_RESOURCE_ATTRIBUTES']
    ? `${env['OTEL_RESOURCE_ATTRIBUTES']},${attrs}`
    : attrs;
  return env;
}

export function buildClaudeArgs(
  o: RunAgentOptions,
  agentName: string | undefined,
  scriptsGlob: string,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--max-budget-usd',
    String(o.budgetUsd),
    '--max-turns',
    String(o.maxTurns),
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    allowedTools(o.role, scriptsGlob).join(','),
    '--disallowedTools',
    deniedTools(o.role).join(','),
  ];
  // Load this plugin explicitly, so the guard hooks and the arima:<role> agents are active in the
  // run even if the plugin is not installed for this user (development, CI, another machine).
  args.push('--plugin-dir', pluginRoot());
  if (o.config.model !== undefined) args.push('--model', o.config.model);
  if (agentName !== undefined) args.push('--agent', agentName);
  if (o.sessionId !== undefined) args.push('--resume', o.sessionId);
  return args;
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number },
): Promise<Spawned> {
  return new Promise((resolve) => {
    const isScript = /\.(?:m?js|cjs)$/.test(bin);
    const child = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...args] : args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: its own process group, so a timeout can kill the whole tree.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: Spawned): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) =>
      finish({ code: null, stdout, stderr, timedOut, spawnError: e.message }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input);
  });
}

function exitFor(result: RunResult): number {
  switch (result) {
    case 'pass':
      return EXIT.ok;
    case 'paused':
      return EXIT.paused;
    case 'blocked':
      return EXIT.blocked;
    default:
      return EXIT.failed;
  }
}

function writeRunReport(projectDir: string, runId: string, body: Record<string, unknown>): void {
  const dir = path.join(projectDir, '.arima', 'runs');
  mkdirSync(dir, { recursive: true });
  let text = JSON.stringify(body, null, 2);
  if (findSecrets(text).length > 0) {
    text = JSON.stringify(
      { run_id: runId, note: 'report withheld: content looked like a secret' },
      null,
      2,
    );
  }
  writeFileSync(path.join(dir, `${runId}.json`), `${text}\n`, 'utf8');
}

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * A second layer under the daily preflight (spec §13.5: budgets are checked "before each
 * dispatch"): refuses to start a run while the kill switch file is present or the daily or project
 * budget is used up. Records a hardstop.hit event when it refuses.
 */
async function assertMayDispatch(o: RunAgentOptions, now: Date): Promise<void> {
  const refuse = async (stop: string, message: string, exitCode: number): Promise<never> => {
    await appendEvent(o.projectDir, {
      type: 'hardstop.hit',
      actor: 'system',
      ...(o.item !== 'none' ? { item: o.item } : {}),
      data: { stop, role: o.role, message },
    });
    throw new DispatchRefused(message, exitCode);
  };
  if (existsSync(pauseFile(o.projectDir))) {
    await refuse(
      'kill_switch',
      'refusing to start a run: the kill switch is on (.arima/PAUSE)',
      12,
    );
  }
  if (o.config.projectCap !== undefined && o.config.dailyCap !== undefined) {
    const s = budgetStatus(
      o.projectDir,
      { projectCap: o.config.projectCap, dailyCap: o.config.dailyCap, alertThresholds: [] },
      localDay(now),
    );
    if (!s.ok) {
      await refuse(
        'budget_exceeded',
        `refusing to start a run: the ${s.exhausted.join(' and ')} budget is used up (project ${s.projectSpent}/${s.projectCap}, today ${s.daySpent}/${s.dailyCap})`,
        13,
      );
    }
  }
}

/**
 * Runs one headless Claude Code session for one role and one item, then records exactly one
 * ledger row plus start/end (or paused) events, whatever happened (spec §7.2 step 5, §13).
 */
export async function runAgent(o: RunAgentOptions): Promise<RunAgentOutcome> {
  if (o.budgetUsd <= 0 || o.maxTurns <= 0) throw new Error('budget and max-turns must be positive');
  if (o.budgetUsd > o.config.perRunCap) {
    throw new Error(
      `budget ${o.budgetUsd} exceeds budget.per_run_cap ${o.config.perRunCap} in arima.yaml (spec §13.5)`,
    );
  }
  if (!existsSync(o.promptFile)) throw new Error(`prompt file not found: ${o.promptFile}`);
  const prompt = readFileSync(o.promptFile, 'utf8');
  const cwd = path.resolve(o.cwd ?? o.projectDir);
  const root = pluginRoot();
  const scriptsGlob = path.join(root, 'scripts', 'dist').replace(/\\/g, '/');
  const agentName =
    o.agent ??
    (existsSync(path.join(root, 'agents', `${o.role}.md`)) ? `arima:${o.role}` : undefined);

  const now = o.now ?? new Date();
  await assertMayDispatch(o, now);
  const runId = await issueRunId(o.projectDir, now);
  const startedAt = now.toISOString();
  const attempt = o.attempt ?? 1;
  await appendEvent(o.projectDir, {
    type: 'run.start',
    actor: o.role,
    run_id: runId,
    item: o.item,
    data: { phase: o.phase, budget_usd: o.budgetUsd, max_turns: o.maxTurns, attempt },
  });

  const env = childEnv(o.env ?? process.env, {
    role: o.role,
    item: o.item,
    phase: o.phase,
    runId,
    projectKey: o.config.projectKey,
    projectDir: path.resolve(o.projectDir),
    config: o.config,
  });
  Object.assign(env, o.extraEnv ?? {});
  const bin = o.claudeBin ?? process.env['ARIMA_CLAUDE_BIN'] ?? 'claude';
  const t0 = Date.now();
  const spawned = await runProcess(bin, buildClaudeArgs(o, agentName, scriptsGlob), {
    cwd,
    env,
    input: prompt,
    timeoutMs: o.config.maxRunMinutes * 60_000,
  });
  const elapsed = Date.now() - t0;

  let parsed: ClaudeResult | undefined;
  try {
    parsed = parseClaudeResult(spawned.stdout);
  } catch {
    parsed = undefined;
  }

  const ctx: RunContext = {
    run_id: runId,
    date: startedAt.slice(0, 10),
    started_at: startedAt,
    project: o.config.projectKey,
    phase: o.phase,
    item: o.item,
    role: o.role,
    attempt,
    is_rework: attempt > 1 || o.reworkReason !== undefined,
    budget_usd: o.budgetUsd,
  };
  if (o.config.tier !== undefined) ctx.model_tier = o.config.tier;
  if (o.milestone !== undefined) ctx.milestone = o.milestone;
  if (o.reworkReason !== undefined) ctx.rework_reason = o.reworkReason;

  const paused = isUsageLimit(parsed, spawned.stderr, spawned.stdout);
  let row: LedgerRow;
  if (parsed !== undefined) {
    row = buildLedgerRow(
      parsed,
      paused ? { ...ctx, result: 'paused' } : ctx,
      readLedger(o.projectDir),
    );
    if (paused) row.subtype = 'usage_limit_pause';
  } else {
    const subtype = paused
      ? 'usage_limit_pause'
      : spawned.timedOut
        ? 'timeout'
        : spawned.spawnError !== undefined
          ? 'spawn_error'
          : 'unparseable_output';
    row = buildLedgerRow(
      { type: 'result', subtype, is_error: true, duration_ms: elapsed },
      { ...ctx, result: paused ? 'paused' : 'error' },
    );
  }
  await appendLedgerRow(o.projectDir, row);

  writeRunReport(o.projectDir, runId, {
    run_id: runId,
    subtype: row.subtype,
    result: row.result,
    exit_code: spawned.code,
    spawn_error: spawned.spawnError,
    result_text: parsed?.result,
    errors: parsed?.errors,
    terminal_reason: parsed?.terminal_reason,
    stderr_tail: spawned.stderr.slice(-2000),
  });

  if (row.result === 'paused') {
    await appendEvent(o.projectDir, {
      type: 'run.paused',
      actor: o.role,
      run_id: runId,
      item: o.item,
      data: { reason: 'usage_limit', cost_usd: row.cost_usd },
    });
  } else {
    await appendEvent(o.projectDir, {
      type: 'run.end',
      actor: o.role,
      run_id: runId,
      item: o.item,
      data: {
        result: row.result,
        subtype: row.subtype,
        cost_usd: row.cost_usd,
        num_turns: row.num_turns,
      },
    });
  }

  const outcome: RunAgentOutcome = {
    runId,
    result: row.result,
    subtype: row.subtype,
    costUsd: row.cost_usd,
    exitCode: exitFor(row.result),
  };
  if (row.session_id !== undefined) outcome.sessionId = row.session_id;
  return outcome;
}

/** Reads the fields the wrapper needs from a validated arima.yaml document. */
export function agentConfigFrom(arima: Record<string, unknown>, role: Role): AgentConfig {
  const get = (p: string): unknown =>
    p
      .split('.')
      .reduce<unknown>(
        (cur, k) =>
          cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined,
        arima,
      );
  const tier = get(`models.by_role.${configKey(role)}`);
  const modelId = typeof tier === 'string' ? get(`models.tiers.${tier}`) : undefined;
  const model =
    typeof modelId === 'string' && modelId.trim() !== '' && !modelId.startsWith('<')
      ? modelId
      : undefined;
  const githubEnv = get('github.machine_token_env');
  return {
    projectKey: String(get('project.key')),
    perRunCap: Number(get('budget.per_run_cap')),
    maxRunMinutes: Number(get('schedule.max_run_minutes')),
    model,
    tier: tier === 'strong' || tier === 'standard' || tier === 'fast' ? tier : undefined,
    auth: get('runtime.auth') === 'api_key' ? 'api_key' : 'seat',
    projectCap: Number(get('budget.project_cap')),
    dailyCap: Number(get('budget.daily_cap')),
    notionTokenEnv: String(get('notion.token_env')),
    githubTokenEnv: typeof githubEnv === 'string' ? githubEnv : undefined,
  };
}
