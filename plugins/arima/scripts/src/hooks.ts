import { existsSync } from 'node:fs';
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

const READ_ONLY_PROTECTED =
  /(^|\/)\.arima\/(mirror\/|ledger\.jsonl$|events\.jsonl$|notion-map\.json$)/;

/** Paths agents must never write directly: the Notion mirror and the append-only logs. */
export function isProtectedStatePath(p: string): boolean {
  return READ_ONLY_PROTECTED.test(norm(p));
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

/** Rules for a Bash command. Returns the first rule that matches. */
export function guardBash(command: string): Guard | undefined {
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
  if (/\.arima[/\\](mirror|ledger\.jsonl|events\.jsonl)/.test(c) && WRITE_VERBS.test(c)) {
    return {
      rule: 'protected-state',
      reason:
        'the Notion mirror and the ledger/event logs are written only by ARIMA scripts; propose Notion changes through .arima/outbox/',
    };
  }
  return undefined;
}

/** Rules for a tool call, whatever the tool. */
export function guardTool(tool: string, input: Record<string, unknown>): Guard | undefined {
  if (/^mcp__.*notion/i.test(tool) && /(delete|archive|remove|trash)/i.test(tool)) {
    return {
      rule: 'notion-delete',
      reason:
        'Notion delete is a hard stop: ARIMA never deletes in Notion, it retires items by status (spec §9.3, §11.1)',
    };
  }
  if (FILE_TOOLS.has(tool)) {
    for (const p of pathsOf(input)) {
      if (isSecretPath(p))
        return {
          rule: 'secret-file',
          reason: `${path.basename(norm(p))} may hold secrets; ARIMA agents must not read or change secret files (spec §11.3)`,
        };
      if (WRITE_TOOLS.has(tool) && isProtectedStatePath(p)) {
        return {
          rule: 'protected-state',
          reason: `${norm(p)} is written only by ARIMA scripts; propose Notion changes through .arima/outbox/ instead`,
        };
      }
    }
  }
  if (tool === 'Bash' && typeof input['command'] === 'string') return guardBash(input['command']);
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

function actorFor(env: NodeJS.ProcessEnv): string {
  return env['ARIMA_ROLE'] || 'human';
}

/** A short, secret-free description of a tool call for the event log. */
function describe(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { tool };
  const p = pathsOf(input)[0];
  if (p !== undefined) data['path'] = norm(p).slice(0, 300);
  if (typeof input['command'] === 'string') data['command'] = input['command'].slice(0, 300);
  if (findSecrets(JSON.stringify(data)).length > 0)
    return { tool, note: 'details withheld: looked like a secret' };
  return data;
}

async function log(
  projectDir: string,
  type: 'tool.blocked' | 'tool.used' | 'agent.stop',
  input: HookInput,
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
  void input;
}

/**
 * Handles one Claude Code hook call. Pure apart from appending to .arima/events.jsonl. Outside an
 * ARIMA project (no arima.yaml up the tree) every hook allows and logs nothing.
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
    const hit = guardTool(tool, toolInput);
    if (hit === undefined) return { exitCode: 0 };
    await log(projectDir, 'tool.blocked', input, env, {
      ...describe(tool, toolInput),
      rule: hit.rule,
      reason: hit.reason,
    });
    return {
      exitCode: 2,
      stderr: `ARIMA blocked this action (${hit.rule}): ${hit.reason}. This is a safety rule, not a glitch; do not try to work around it. If it is genuinely needed, ask the human.`,
    };
  }

  if (kind === 'post-tool-use') {
    const changesState =
      WRITE_TOOLS.has(tool) ||
      (tool === 'Bash' &&
        typeof toolInput['command'] === 'string' &&
        !isReadOnlyBash(toolInput['command']));
    if (changesState) await log(projectDir, 'tool.used', input, env, describe(tool, toolInput));
    return { exitCode: 0 };
  }

  await log(projectDir, 'agent.stop', input, env, {
    kind: kind === 'stop' ? 'session' : 'subagent',
    ...(input.agent_type ? { agent_type: input.agent_type } : {}),
  });
  return { exitCode: 0 };
}
