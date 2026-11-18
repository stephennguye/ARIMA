import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from './events.js';
import { findSecrets } from './lib/secrets.js';

/** What Claude Code sends a hook on stdin (the fields ARIMA uses). */
export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  agent_type?: string;
  session_id?: string;
}

export interface HookOutcome {
  /** 0 allow, 2 block (stderr is shown to the model as the reason). */
  exitCode: 0 | 2;
  stderr?: string;
}

export interface Guard {
  rule: string;
  reason: string;
}

/**
 * Who is acting. `role` is set (from ARIMA_ROLE) only inside a headless ARIMA agent run; an
 * interactive human session has no role and is allowed the things an agent must never do, such as
 * resuming the kill switch or editing arima.yaml.
 */
export interface GuardContext {
  role?: string | undefined;
  defaultBranch?: string | undefined;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

/** Files that may hold credentials (spec §11.3). `.env.example`-style templates are fine. */
export function isSecretPath(p: string): boolean {
  const f = norm(p);
  const base = f.split('/').pop() ?? '';
  if (/^\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks|ppk)$/i.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(base) && !base.endsWith('.pub')) return true;
  if (/(^|\/)\.ssh\//.test(f) || /(^|\/)\.aws\/credentials$/.test(f) || /(^|\/)\.gnupg\//.test(f))
    return true;
  if (/(^|\/)\.config\/arima\/env$/.test(f) || /^ARIMA_[A-Z0-9_]*(TOKEN|KEY|SECRET)/.test(base))
    return true;
  if (/(^|\/)(credentials|secrets?)\.(json|ya?ml|toml|txt)$/i.test(base)) return true;
  return false;
}

/** ARIMA's own state: written only by ARIMA scripts, never by an agent's file tools. */
const PROTECTED_STATE =
  /(^|\/)\.arima\/(mirror\/|ledger\.jsonl$|events\.jsonl$|notion-map\.json$|PAUSE$|run\.lock$|state\/|runs\/)/;

export function isProtectedStatePath(p: string): boolean {
  return PROTECTED_STATE.test(norm(p));
}

/**
 * Files that decide who may approve things and what the guards do. Agents never edit them
 * (spec §5.7 "must not edit CI, hooks or infrastructure"); only devops edits `.github/`.
 */
export function isProtectedConfigPath(p: string, role?: string): boolean {
  const f = norm(p);
  if (/(^|\/)(arima|team)\.yaml$/.test(f)) return true;
  if (/(^|\/)\.claude\//.test(f) || /(^|\/)\.githooks\//.test(f)) return true;
  if (/(^|\/)\.github\//.test(f)) return role !== 'devops';
  return false;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = input[k];
    if (typeof v === 'string' && v !== '') out.push(v);
  }
  return out;
}

const SECRET_WORDS = '(?:TOKEN|SECRET|API_?KEY|PASSWORD|PASSWD|CREDENTIAL)';
const WRITE_VERBS =
  /(?:>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bdel\b|\btruncate\b|\bsed\s+-i|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bRemove-Item\b|\bClear-Content\b)/;

const PROTECTED_BRANCHES = ['main', 'master', 'trunk'];

/** Splits a command line into words, honouring simple quotes. Good enough to read git/gh options. */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** Each simple command in a pipeline or `&&` chain, as words. */
function simpleCommands(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((c) => words(c.trim()))
    .filter((w) => w.length > 0);
}

function gitSubcommand(w: string[]): { sub: string; rest: string[] } | undefined {
  if (w[0] !== 'git') return undefined;
  let i = 1;
  while (i < w.length) {
    const t = w[i] as string;
    if (t === '-C' || t === '-c') i += 2;
    else if (t.startsWith('-')) i += 1;
    else break;
  }
  const sub = w[i];
  return sub === undefined ? undefined : { sub, rest: w.slice(i + 1) };
}

/** Rules for the git and GitHub CLI parts of a command. */
function guardVcs(command: string, ctx: GuardContext): Guard | undefined {
  const protectedBranches = new Set([
    ...PROTECTED_BRANCHES,
    ...(ctx.defaultBranch ? [ctx.defaultBranch] : []),
  ]);
  for (const w of simpleCommands(command)) {
    const g = gitSubcommand(w);
    if (g !== undefined) {
      if (g.rest.includes('--no-verify') || (g.sub === 'commit' && g.rest.includes('-n'))) {
        return { rule: 'vcs', reason: 'skipping git hooks (--no-verify) is not allowed' };
      }
      if (g.sub === 'config' && g.rest.some((a) => /core\.hookspath|hooks/i.test(a))) {
        return { rule: 'vcs', reason: 'changing where git hooks run from is not allowed' };
      }
      if (g.sub === 'push') {
        const opts = g.rest.filter((a) => a.startsWith('-'));
        if (
          opts.some((a) =>
            /^(-f|--force|--force-with-lease.*|--delete|-d|--mirror|--all|--prune)$/.test(a),
          )
        ) {
          return {
            rule: 'vcs',
            reason: 'force pushes, deleting remote branches and mirror pushes are not allowed',
          };
        }
        const args = g.rest.filter((a) => !a.startsWith('-'));
        const refspecs = args.slice(1); // args[0] is the remote
        if (refspecs.length === 0) {
          return {
            rule: 'vcs',
            reason:
              'push needs an explicit remote and branch (git push -u origin <your-branch>), so it cannot land on the default branch by accident',
          };
        }
        for (const spec of refspecs) {
          if (spec.startsWith(':') || spec.startsWith('+')) {
            return {
              rule: 'vcs',
              reason: 'deleting or force-updating a remote branch is not allowed',
            };
          }
          const [source = '', target = source] = spec.split(':');
          const strip = (b: string): string => b.replace(/^refs\/heads\//, '');
          if (protectedBranches.has(strip(target)) || protectedBranches.has(strip(source))) {
            return {
              rule: 'vcs',
              reason: `pushing to ${strip(target) || strip(source)} is not allowed; push your feature branch and open a pull request`,
            };
          }
        }
      }
      continue;
    }
    if (w[0] === 'gh') {
      const rest = w.slice(1);
      const [a, b] = [rest[0], rest[1]];
      if (a === 'pr' && b === 'merge') {
        return {
          rule: 'vcs',
          reason: "merging is done only by ARIMA's merge script after human approval (spec §10.3)",
        };
      }
      if (a === 'api') {
        const method = rest.findIndex((x) => x === '-X' || x === '--method');
        const verb = method >= 0 ? (rest[method + 1] ?? '').toUpperCase() : 'GET';
        const hasBody = rest.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x));
        if (verb !== 'GET' || hasBody) {
          return {
            rule: 'vcs',
            reason:
              '`gh api` calls that change anything are not allowed (they could merge, delete or change settings)',
          };
        }
      }
      if (a === 'workflow' && b === 'run') {
        return {
          rule: 'vcs',
          reason: 'starting workflows (which can deploy) is not allowed for agents',
        };
      }
      if (
        a === 'release' ||
        a === 'secret' ||
        a === 'repo' ||
        a === 'auth' ||
        a === 'ssh-key' ||
        a === 'gpg-key'
      ) {
        return {
          rule: 'vcs',
          reason: `\`gh ${a}\` can publish, delete or change credentials and settings; it is not allowed for agents`,
        };
      }
    }
  }
  return undefined;
}

/** Rules for a Bash command. Returns the first rule that matches. */
export function guardBash(command: string, ctx: GuardContext = {}): Guard | undefined {
  const c = command;
  if (
    /(^|[\s"'=:/\\])\.env(\.(?!example\b|sample\b|template\b|dist\b)[A-Za-z0-9_-]+)?(?=$|[\s"';|&)<>])/.test(
      c,
    )
  ) {
    return {
      rule: 'secret-file',
      reason: 'the command touches a .env file, which can hold secrets',
    };
  }
  if (
    /\.(pem|key|p12|pfx|keystore|ppk)(?=$|[\s"';|&)])/i.test(c) ||
    /(^|[\s"'/\\])id_(rsa|dsa|ecdsa|ed25519)(?=$|[\s"';|&)])/.test(c)
  ) {
    return { rule: 'secret-file', reason: 'the command touches a private key or certificate file' };
  }
  if (
    /\.config[/\\]arima[/\\]env\b/.test(c) ||
    /[/\\]\.ssh[/\\]/.test(c) ||
    /\.aws[/\\]credentials/.test(c)
  ) {
    return { rule: 'secret-file', reason: 'the command touches a credentials file' };
  }
  if (
    new RegExp(`\\$\\{?[A-Za-z0-9_]*${SECRET_WORDS}[A-Za-z0-9_]*\\}?`, 'i').test(c) ||
    new RegExp(`\\$env:[A-Za-z0-9_]*${SECRET_WORDS}`, 'i').test(c) ||
    /\$\{?ARIMA_[A-Za-z0-9_]*\}?/.test(c)
  ) {
    return {
      rule: 'secret-env',
      reason: 'the command expands an environment variable that holds a secret',
    };
  }
  if (
    /\bprintenv\b/.test(c) ||
    /\bGet-ChildItem\s+env:/i.test(c) ||
    /\bdir\s+env:/i.test(c) ||
    /^\s*(env|set)\s*($|\|)/.test(c)
  ) {
    return { rule: 'secret-env', reason: 'listing the environment would expose secrets' };
  }
  if (
    /api\.notion\.com/i.test(c) &&
    /(-X\s*DELETE|--request\s+DELETE|in_trash|archived)/i.test(c)
  ) {
    return {
      rule: 'notion-delete',
      reason:
        'deleting or archiving in Notion is never allowed; retire items by status instead (spec §9.3)',
    };
  }
  if (
    /\.arima[/\\](mirror|ledger\.jsonl|events\.jsonl|PAUSE|run\.lock)/.test(c) &&
    WRITE_VERBS.test(c)
  ) {
    return {
      rule: 'protected-state',
      reason:
        'the Notion mirror, the logs, the lock and the kill switch are written only by ARIMA scripts; propose Notion changes through .arima/outbox/',
    };
  }
  // Inside an agent run, nobody but a human may touch the kill switch or restart a project.
  if (ctx.role !== undefined && /arima-(pause|init)\.mjs/.test(c)) {
    return {
      rule: 'kill-switch',
      reason: 'only a human may pause, resume or initialise ARIMA; agents escalate instead',
    };
  }
  return guardVcs(c, ctx);
}

/** Rules for a tool call, whatever the tool. */
export function guardTool(
  tool: string,
  input: Record<string, unknown>,
  ctx: GuardContext = {},
): Guard | undefined {
  if (/^mcp__.*notion/i.test(tool) && /(delete|archive|remove|trash)/i.test(tool)) {
    return {
      rule: 'notion-delete',
      reason:
        'Notion delete is a hard stop: ARIMA never deletes in Notion, it retires items by status (spec §9.3, §11.1)',
    };
  }
  if (FILE_TOOLS.has(tool)) {
    for (const p of pathsOf(input)) {
      if (isSecretPath(p)) {
        return {
          rule: 'secret-file',
          reason: `${path.basename(norm(p))} may hold secrets; ARIMA agents must not read or change secret files (spec §11.3)`,
        };
      }
      if (WRITE_TOOLS.has(tool) && isProtectedStatePath(p)) {
        return {
          rule: 'protected-state',
          reason: `${norm(p)} is written only by ARIMA scripts; propose Notion changes through .arima/outbox/ instead`,
        };
      }
      if (WRITE_TOOLS.has(tool) && ctx.role !== undefined && isProtectedConfigPath(p, ctx.role)) {
        return {
          rule: 'protected-config',
          reason: `${norm(p)} decides who may approve work or what the guards do; agents never edit it (spec §5.7)`,
        };
      }
    }
  }
  if (tool === 'Bash' && typeof input['command'] === 'string')
    return guardBash(input['command'], ctx);
  return undefined;
}

/** The ARIMA project a hook belongs to, or undefined outside one (hooks then do nothing). */
export function findProjectDir(
  input: HookInput,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const fromEnv of [env['ARIMA_PROJECT_DIR'], env['CLAUDE_PROJECT_DIR']]) {
    if (fromEnv && existsSync(path.join(fromEnv, 'arima.yaml'))) return path.resolve(fromEnv);
  }
  let dir = path.resolve(input.cwd ?? process.cwd());
  for (;;) {
    if (existsSync(path.join(dir, 'arima.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The default branch named in arima.yaml, if it can be read cheaply. */
function defaultBranchOf(projectDir: string): string | undefined {
  try {
    const m = /^\s*default_branch:\s*["']?([A-Za-z0-9._/-]+)/m.exec(
      readFileSync(path.join(projectDir, 'arima.yaml'), 'utf8'),
    );
    return m?.[1];
  } catch {
    return undefined;
  }
}

const READ_ONLY_COMMANDS = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'pwd',
  'echo',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'which',
  'where',
  'cd',
  'true',
]);

function isReadOnlyBash(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? '';
  if (READ_ONLY_COMMANDS.has(first))
    return !/[>|]/.test(command.replace(/\|\s*(head|tail|wc|grep|rg)\b[^|]*/g, ''));
  if (first === 'git')
    return /^git\s+(-C\s+\S+\s+)?(status|diff|log|show|branch(\s+--list)?|rev-parse|ls-files|remote(\s+-v)?)\b/.test(
      command.trim(),
    );
  return false;
}

/** Who to record as the actor. An unset role is "unknown" in a headless run: it could be a lost variable. */
function actorFor(env: NodeJS.ProcessEnv): string {
  if (env['ARIMA_ROLE']) return env['ARIMA_ROLE'];
  return env['ARIMA_RUN_ID'] ? 'unknown' : 'human';
}

/** A short, secret-free description of a tool call for the event log (scans before truncating). */
function describe(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { tool };
  const p = pathsOf(input)[0];
  if (p !== undefined) data['path'] = norm(p);
  if (typeof input['command'] === 'string') data['command'] = input['command'];
  if (findSecrets(JSON.stringify(data)).length > 0)
    return { tool, note: 'details withheld: looked like a secret' };
  if (typeof data['path'] === 'string') data['path'] = data['path'].slice(0, 300);
  if (typeof data['command'] === 'string') data['command'] = data['command'].slice(0, 300);
  return data;
}

async function log(
  projectDir: string,
  type: 'tool.blocked' | 'tool.used' | 'agent.stop',
  env: NodeJS.ProcessEnv,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await appendEvent(projectDir, {
      type,
      actor: actorFor(env),
      ...(env['ARIMA_RUN_ID'] ? { run_id: env['ARIMA_RUN_ID'] } : {}),
      ...(env['ARIMA_ITEM'] && env['ARIMA_ITEM'] !== 'none' ? { item: env['ARIMA_ITEM'] } : {}),
      data,
    });
  } catch {
    // Logging must never break the tool call; the guard decision stands either way.
  }
}

/**
 * Handles one Claude Code hook call. Outside an ARIMA project (no arima.yaml up the tree) every
 * hook allows and logs nothing. Inside one, the PreToolUse guard FAILS CLOSED: if it cannot decide
 * (an internal error), it blocks, because a hard stop that silently turns off is worse than a
 * stopped tool call (spec principle 10). The audit hooks stay fail-open.
 */
export async function handleHook(
  kind: 'pre-tool-use' | 'post-tool-use' | 'stop' | 'subagent-stop',
  input: HookInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutcome> {
  const projectDir = findProjectDir(input, env);
  if (projectDir === undefined) return { exitCode: 0 };
  const tool = input.tool_name ?? '';
  const toolInput = input.tool_input ?? {};

  if (kind === 'pre-tool-use') {
    try {
      const ctx: GuardContext = {
        role: env['ARIMA_ROLE'],
        defaultBranch: defaultBranchOf(projectDir),
      };
      const hit = guardTool(tool, toolInput, ctx);
      if (hit === undefined) return { exitCode: 0 };
      await log(projectDir, 'tool.blocked', env, {
        ...describe(tool, toolInput),
        rule: hit.rule,
        reason: hit.reason,
      });
      return {
        exitCode: 2,
        stderr: `ARIMA blocked this action (${hit.rule}): ${hit.reason}. This is a safety rule, not a glitch; do not try to work around it. If it is genuinely needed, ask the human.`,
      };
    } catch (e) {
      return {
        exitCode: 2,
        stderr: `ARIMA guard error, so this action is blocked to be safe (${e instanceof Error ? e.message : String(e)}). Ask the human to check the ARIMA plugin.`,
      };
    }
  }

  if (kind === 'post-tool-use') {
    const changesState =
      WRITE_TOOLS.has(tool) ||
      (tool === 'Bash' &&
        typeof toolInput['command'] === 'string' &&
        !isReadOnlyBash(toolInput['command']));
    if (changesState) await log(projectDir, 'tool.used', env, describe(tool, toolInput));
    return { exitCode: 0 };
  }

  await log(projectDir, 'agent.stop', env, {
    kind: kind === 'stop' ? 'session' : 'subagent',
    ...(input.agent_type ? { agent_type: input.agent_type } : {}),
  });
  return { exitCode: 0 };
}
