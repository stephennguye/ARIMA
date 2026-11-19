import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { budgetStatus } from './budget.js';
import { appendEvent } from './events.js';
import { checkKillSwitch } from './killswitch.js';
import type { PauseSwitchPort } from './notion/port.js';
import { remotePauseFlag } from './state.js';
import { buildLedgerRow, appendLedgerRow, parseClaudeResult, readLedger } from './ledger.js';
import type { ClaudeResult, LedgerRow, Role, RunContext, RunResult } from './ledger.js';
import type { UnitKind } from './kinds.js';
import { recordStoryBudgetHit, unitBudget } from './story-budget.js';
import { pluginRoot } from './lib/paths.js';
import type { ReasonCode } from './reasons.js';
import { collectReport } from './report-collector.js';
import type { Collected } from './report-collector.js';
import type { AgentReport } from './report.js';
import { findSecrets } from './lib/secrets.js';
import {
  allowedTools,
  configKey,
  deniedTools,
  mayHoldGithubToken,
  mayHoldNotionToken,
} from './roles.js';
import { issueRunId } from './runid.js';
import { CONTAINER_PLUGIN, openSandbox } from './sandbox.js';
import type { Exec, Sandbox } from './sandbox.js';

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
  /**
   * runtime.isolate_user_settings (default true, WP-191): the child loads only the project's
   * settings, no user plugins, MCP servers or slash commands, so the person's own setup can neither
   * widen a role's tools nor cost tokens. The ARIMA plugin itself is always loaded with --plugin-dir.
   */
  isolateUserSettings?: boolean | undefined;
  /** runtime.sandbox (WP-190): `docker` runs the role in a container on a per-run clone. Default none. */
  sandbox?: 'docker' | 'none' | undefined;
  sandboxImage?: string | undefined;
  sandboxAllow?: string[] | undefined;
  /** runtime.auth: with 'api_key' the ANTHROPIC_* variables are passed to the child. */
  auth?: 'seat' | 'api_key' | undefined;
  /** Caps re-checked before every dispatch (spec §13.5). Required: a missing cap is not "no limit". */
  projectCap: number;
  dailyCap: number;
  /** The state branch and default branch, for reading the remote PAUSE flag. */
  stateBranch?: string | undefined;
  defaultBranch?: string | undefined;
}

/**
 * Where the dispatch re-check looks for the kill switch besides the local PAUSE file (spec §11.3):
 * the "Pause ARIMA" to-do on the Notion root page and the PAUSE file on the remote state branch.
 * `notion: null` is an explicit "Notion is not configured here" and is recorded as a warning.
 */
export interface DispatchKillSwitch {
  notion: { port: PauseSwitchPort; rootPageId: string } | null;
  /** Overrides the remote state-branch lookup (tests). */
  remotePause?: () => Promise<boolean | undefined>;
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
  /**
   * Builds the prompt once the run id exists (a run packet names its run id, and the report must
   * quote it). When set, `promptFile` is not read.
   */
  buildPrompt?: (runId: string) => string | Promise<string>;
  /** How often a running child is checked against the kill switch, in ms (default 30,000; 0 turns it off). RD-F02-9. */
  killSwitchPollMs?: number;
  cwd?: string;
  phase: number;
  attempt?: number;
  milestone?: string | null;
  reworkReason?: RunContext['rework_reason'];
  /** Resume an earlier session (cost in the ledger is then the difference, spec §13.6). */
  sessionId?: string;
  agent?: string;
  /**
   * The work-unit kind. When set, the final message must end in a valid `arima-report` block
   * (03-contracts 3.3): it is extracted, validated and stored, and a missing or invalid one makes
   * the run a `fail` with reason `report_invalid` (or `evidence_missing`, `secret_in_output`).
   */
  kind?: UnitKind;
  /**
   * The budget of the item's story (est. USD). When set, no run starts once the item has spent it
   * or has less than the run cost floor left, and `budgetUsd` may not exceed what is left (spec
   * 13.5 item 2; hard stop `story_budget`; exit 13).
   */
  storyBudgetUsd?: number;
  config: AgentConfig;
  killSwitch: DispatchKillSwitch;
  /** Executable to run instead of `claude` (tests, or a non-PATH install). */
  claudeBin?: string;
  /** Test seam for the docker and git commands of the sandbox (WP-190). */
  sandboxExec?: Exec;
  /** The `docker` executable (tests substitute a stub). */
  dockerBin?: string;
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
  /** Why a run failed, blocked or paused (03-contracts 9b). */
  reason?: ReasonCode;
  /** The validated report, when `kind` was set and the report was accepted. */
  report?: AgentReport;
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
    /** The unit kind, for stub agents and audit; informational. */
    kind?: string;
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
  // No role is given a GitHub token (D-49): the host publish and merge scripts hold it.
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
  if (o.kind !== undefined) env['ARIMA_KIND'] = o.kind;
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

/** What "hermetic" means for a role run (WP-191; recorded in docs/process/reviews/2026-11-19-wp191-hermetic-runs.md). Not --bare: that skips hooks, and the guard is a hook. */
export const ISOLATION_FLAGS: readonly string[] = [
  '--setting-sources',
  'project',
  '--strict-mcp-config',
  '--disable-slash-commands',
];

export function buildClaudeArgs(
  o: RunAgentOptions,
  agentName: string | undefined,
  scriptsGlob: string,
  pluginDir: string = pluginRoot(),
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
  args.push('--plugin-dir', pluginDir);
  if (o.config.isolateUserSettings !== false) args.push(...ISOLATION_FLAGS);
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
  /** The kill switch turned on while the child ran and the tree was killed (RD-F02-9). */
  switchKilled?: boolean;
  spawnError?: string;
}

function runProcess(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input: string;
    timeoutMs: number;
    poll?: { everyMs: number; isOn: () => Promise<boolean> };
    /** Called whenever the process tree is killed (a sandbox must also stop its container). */
    onKill?: () => void;
  },
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
    let switchKilled = false;
    let settled = false;
    let poller: ReturnType<typeof setInterval> | undefined;
    const finish = (r: Spawned): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poller !== undefined) clearInterval(poller);
      resolve(switchKilled ? { ...r, switchKilled: true } : r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      opts.onKill?.();
    }, opts.timeoutMs);
    if (opts.poll !== undefined && opts.poll.everyMs > 0) {
      let checking = false;
      poller = setInterval(() => {
        if (checking || settled) return;
        checking = true;
        opts.poll
          ?.isOn()
          .then((on) => {
            if (on && !settled) {
              switchKilled = true;
              killTree(child.pid);
              opts.onKill?.();
            }
          })
          .catch(() => undefined)
          .finally(() => (checking = false));
      }, opts.poll.everyMs);
    }
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
const remotePauseOf = (o: RunAgentOptions): (() => Promise<boolean | undefined>) =>
  o.killSwitch.remotePause ??
  ((): Promise<boolean | undefined> =>
    Promise.resolve(
      remotePauseFlag({
        projectDir: o.projectDir,
        ...(o.config.stateBranch ? { branch: o.config.stateBranch } : {}),
        ...(o.config.defaultBranch ? { defaultBranch: o.config.defaultBranch } : {}),
      }),
    ));

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
  const c = o.config as Partial<AgentConfig>;
  if (!Number.isFinite(c.projectCap) || !Number.isFinite(c.dailyCap)) {
    throw new Error('projectCap and dailyCap are required in the agent config (spec §13.5)');
  }
  const remotePause =
    o.killSwitch.remotePause ??
    ((): Promise<boolean | undefined> =>
      Promise.resolve(
        remotePauseFlag({
          projectDir: o.projectDir,
          ...(o.config.stateBranch ? { branch: o.config.stateBranch } : {}),
          ...(o.config.defaultBranch ? { defaultBranch: o.config.defaultBranch } : {}),
        }),
      ));
  const ks = await checkKillSwitch(o.projectDir, o.killSwitch.notion, remotePause);
  if (ks.on) {
    await refuse(
      'kill_switch',
      `refusing to start a run: the kill switch is on (${ks.detail})`,
      12,
    );
  }
  if (o.storyBudgetUsd !== undefined && o.item !== 'none') {
    const ub = unitBudget(o.projectDir, o.item, o.storyBudgetUsd, o.config.perRunCap);
    if (!ub.ok) {
      throw new DispatchRefused(await recordStoryBudgetHit(o.projectDir, o.item, ub, o.role), 13);
    }
    if (o.budgetUsd > ub.remaining) {
      await refuse(
        'story_budget',
        `refusing to start a run: its cap ${o.budgetUsd} is more than the ${ub.remaining} est. USD left of the story budget of ${o.item}`,
        13,
      );
    }
  }
  const s = budgetStatus(
    o.projectDir,
    { projectCap: c.projectCap as number, dailyCap: c.dailyCap as number, alertThresholds: [] },
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
  if (o.buildPrompt === undefined && !existsSync(o.promptFile))
    throw new Error(`prompt file not found: ${o.promptFile}`);
  const cwd = path.resolve(o.cwd ?? o.projectDir);
  const root = pluginRoot();
  const scriptsGlob = path.join(root, 'scripts', 'dist').replace(/\\/g, '/');
  const agentName =
    o.agent ??
    (existsSync(path.join(root, 'agents', `${o.role}.md`)) ? `arima:${o.role}` : undefined);

  const now = o.now ?? new Date();
  await assertMayDispatch(o, now);
  const runId = await issueRunId(o.projectDir, now);
  const prompt =
    o.buildPrompt !== undefined ? await o.buildPrompt(runId) : readFileSync(o.promptFile, 'utf8');
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
    ...(o.kind !== undefined ? { kind: o.kind } : {}),
  });
  Object.assign(env, o.extraEnv ?? {});
  const bin = o.claudeBin ?? process.env['ARIMA_CLAUDE_BIN'] ?? 'claude';
  const t0 = Date.now();
  let sandbox: Sandbox | undefined;
  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv } = {
    bin,
    args: buildClaudeArgs(o, agentName, scriptsGlob),
    env,
  };
  if (o.config.sandbox === 'docker') {
    const base = o.env ?? process.env;
    sandbox = await openSandbox({
      ...(o.sandboxExec ? { exec: o.sandboxExec } : {}),
      ...(o.config.sandboxImage ? { image: o.config.sandboxImage } : {}),
      ...(o.config.sandboxAllow ? { allow: o.config.sandboxAllow } : {}),
      pluginDir: root,
      worktree: cwd,
      projectDir: o.projectDir,
      runId,
      role: o.role,
      hostEnv: env,
      keep: Object.keys(o.extraEnv ?? {}),
      oauthToken: base['ARIMA_SANDBOX_OAUTH_TOKEN'] ?? base['CLAUDE_CODE_OAUTH_TOKEN'],
    });
    const inner = buildClaudeArgs(
      o,
      agentName,
      `${CONTAINER_PLUGIN}/scripts/dist`,
      CONTAINER_PLUGIN,
    );
    // The docker client needs the host's own environment; the role's variables go in the env file.
    launch = {
      bin: o.dockerBin ?? 'docker',
      args: sandbox.dockerArgs(['claude', ...inner]),
      env: { ...base },
    };
  }
  const box = sandbox;
  let spawned: Spawned;
  try {
    spawned = await runProcess(launch.bin, launch.args, {
      cwd,
      env: launch.env,
      ...(box ? { onKill: () => void box.kill() } : {}),
      input: prompt,
      timeoutMs: o.config.maxRunMinutes * 60_000,
      poll: {
        everyMs: o.killSwitchPollMs ?? 30_000,
        isOn: async () =>
          (await checkKillSwitch(o.projectDir, o.killSwitch.notion, remotePauseOf(o))).on,
      },
    });
  } finally {
    if (box) {
      const done = await box.finish().catch((e: unknown) => ({
        commits: { ok: false, commits: 0, detail: String(e) },
        imported: { outbox: 0, events: 0, rejected: [] as string[] },
      }));
      await appendEvent(o.projectDir, {
        type: 'sandbox.finished',
        actor: 'system',
        run_id: runId,
        data: {
          commits: done.commits.commits,
          commits_ok: done.commits.ok,
          outbox: done.imported.outbox,
          events: done.imported.events,
          rejected: done.imported.rejected.length,
        },
      }).catch(() => undefined);
    }
  }
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

  const switchKilled = spawned.switchKilled === true;
  const paused = switchKilled || isUsageLimit(parsed, spawned.stderr, spawned.stdout);
  let row: LedgerRow;
  if (parsed !== undefined) {
    row = buildLedgerRow(
      parsed,
      paused ? { ...ctx, result: 'paused' } : ctx,
      readLedger(o.projectDir),
    );
    if (paused) row.subtype = switchKilled ? 'kill_switch' : 'usage_limit_pause';
  } else {
    const subtype = paused
      ? switchKilled
        ? 'kill_switch'
        : 'usage_limit_pause'
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
  let collected: Collected | undefined;
  if (row.result === 'paused') row.reason = switchKilled ? 'kill_switch' : 'usage_limit';
  else if (row.subtype === 'error_max_turns') row.reason = 'cap_turns';
  else if (row.subtype === 'error_max_budget_usd') row.reason = 'cap_budget';
  else if (o.kind !== undefined && row.result === 'pass') {
    try {
      collected = await collectReport({
        projectDir: o.projectDir,
        runId,
        role: o.role,
        kind: o.kind,
        item: o.item,
        message: parsed?.result,
      });
    } catch (e) {
      collected = {
        ok: false,
        reason: 'report_invalid',
        errors: [e instanceof Error ? e.message : String(e)],
      };
    }
    if (!collected.ok) {
      row.result = 'fail';
      if (collected.reason) row.reason = collected.reason;
    } else if (collected.report?.status === 'failed') row.result = 'fail';
    else if (collected.report?.status !== 'done') row.result = 'blocked';
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
    reason: row.reason,
    report_errors: collected?.ok === false ? collected.errors : undefined,
    stderr_tail: spawned.stderr.slice(-2000),
  });

  if (row.result === 'paused') {
    await appendEvent(o.projectDir, {
      type: 'run.paused',
      actor: o.role,
      run_id: runId,
      item: o.item,
      data: { reason: switchKilled ? 'kill_switch' : 'usage_limit', cost_usd: row.cost_usd },
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
  if (row.reason !== undefined) outcome.reason = row.reason;
  if (collected?.report !== undefined) outcome.report = collected.report;
  return outcome;
}

export interface UnitOptions extends RunAgentOptions {
  kind: UnitKind;
  /** Story budget left before this unit starts; defaults to `budgetUsd`. Caps the retry. */
  storyRemainingUsd?: number;
}

export interface UnitOutcome extends RunAgentOutcome {
  /** Every run of the unit, in order (one, or two when the first failed). */
  runs: RunAgentOutcome[];
  /** True when the unit failed twice (or could not be retried): the item must be Blocked and a question raised (spec 7.12). */
  blocked: boolean;
}

/**
 * Runs one work unit with the retry rule of spec 7.12: a failed run (error, or a missing or
 * invalid report) is retried once with the same packet and `min(per_run_cap, remaining story
 * budget)` after what the first run spent; a second failure blocks the unit. A pause, a cap stop
 * (`blocked`) or a refused dispatch is never retried. `beforeRetry` lets the dispatcher make a
 * fresh worktree.
 */
export async function runUnit(
  o: UnitOptions,
  hooks: { beforeRetry?: (first: RunAgentOutcome) => Promise<void> | void } = {},
): Promise<UnitOutcome> {
  const first = await runAgent(o);
  const failed = first.result === 'fail' || first.result === 'error';
  if (!failed) return { ...first, runs: [first], blocked: false };

  const remaining =
    o.storyBudgetUsd !== undefined && o.item !== 'none'
      ? unitBudgetRemaining(o)
      : (o.storyRemainingUsd ?? o.budgetUsd) - first.costUsd;
  const retryBudget = Math.min(o.config.perRunCap, remaining);
  if (!(retryBudget > 0)) {
    const out: UnitOutcome = { ...first, runs: [first], blocked: true };
    out.reason = 'story_budget';
    return out;
  }
  await appendEvent(o.projectDir, {
    type: 'unit.retried',
    actor: 'system',
    run_id: first.runId,
    ...(o.item !== 'none' ? { item: o.item } : {}),
    data: {
      role: o.role,
      kind: o.kind,
      reason: first.reason ?? first.subtype,
      budget_usd: retryBudget,
    },
  });
  await hooks.beforeRetry?.(first);
  const second = await runAgent({ ...o, budgetUsd: retryBudget });
  const failedAgain = second.result === 'fail' || second.result === 'error';
  return { ...second, runs: [first, second], blocked: failedAgain };
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
    isolateUserSettings: get('runtime.isolate_user_settings') === false ? false : true,
    sandbox: get('runtime.sandbox') === 'docker' ? 'docker' : 'none',
    sandboxImage:
      typeof get('runtime.sandbox_image') === 'string'
        ? (get('runtime.sandbox_image') as string)
        : undefined,
    sandboxAllow: Array.isArray(get('runtime.sandbox_allow'))
      ? (get('runtime.sandbox_allow') as unknown[]).map(String)
      : undefined,
    projectCap: Number(get('budget.project_cap')),
    dailyCap: Number(get('budget.daily_cap')),
    stateBranch:
      typeof get('github.state_branch') === 'string'
        ? (get('github.state_branch') as string)
        : undefined,
    defaultBranch:
      typeof get('github.default_branch') === 'string'
        ? (get('github.default_branch') as string)
        : undefined,
    notionTokenEnv: String(get('notion.token_env')),
    githubTokenEnv: typeof githubEnv === 'string' ? githubEnv : undefined,
  };
}

/** What is left of the story budget for a retry; 0 when under the run cost floor (no run is started). */
function unitBudgetRemaining(o: UnitOptions): number {
  const b = unitBudget(o.projectDir, o.item, o.storyBudgetUsd as number, o.config.perRunCap);
  return b.ok ? b.remaining : 0;
}
