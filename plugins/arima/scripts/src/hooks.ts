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
 * resuming the kill switch or editing arima.yaml. Agents are held to the stricter rules.
 */
export interface GuardContext {
  role?: string | undefined;
  defaultBranch?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * One canonical form for comparing paths: forward slashes, no NUL, no Windows alternate-stream or
 * trailing dots/spaces, `..` resolved, lower case (Windows and macOS file systems ignore case).
 */
export function canon(p: string): string {
  let s = p.replace(/\0/g, '').replace(/\\/g, '/');
  s = s.replace(/::\$[A-Za-z_]+$/, '').replace(/[. ]+$/, '');
  s = path.posix.normalize(s);
  return s.toLowerCase();
}

/** Files that may hold credentials (spec §11.3). `.env.example`-style templates are fine. */
export function isSecretPath(p: string): boolean {
  const f = canon(p);
  const base = f.split('/').pop() ?? '';
  if (/^\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks|ppk)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (/(^|\/)\.(ssh|gnupg)\//.test(f)) return true;
  if (/(^|\/)\.aws\/(credentials|config)$/.test(f)) return true;
  if (/(^|\/)\.config\/arima\/env$/.test(f) || /^arima_[a-z0-9_]*(token|key|secret)/.test(base))
    return true;
  if (/(^|\/)\.claude\/\.credentials\.json$/.test(f) || base === '.credentials.json') return true;
  if (/(^|\/)\.config\/gh\/hosts\.yml$/.test(f)) return true;
  if (/(^|\/)\.(npmrc|git-credentials|netrc|pypirc)$/.test(f)) return true;
  if (/(^|\/)\.docker\/config\.json$/.test(f) || /(^|\/)\.kube\/config$/.test(f)) return true;
  if (/^\/proc\/[^/]+\/environ$/.test(f)) return true;
  if (/(^|\/)(credentials|secrets?)\.(json|ya?ml|toml|txt)$/.test(f)) return true;
  return false;
}

/**
 * ARIMA's own state: written only by ARIMA scripts. Everything under `.arima/` is protected from
 * agents' file tools except top-level JSON files in `.arima/outbox/` (their proposals).
 */
export function isProtectedStatePath(p: string): boolean {
  const f = canon(p);
  if (!/(^|\/)\.arima(\/|$)/.test(f)) return false;
  return !/(^|\/)\.arima\/outbox\/[^/]+\.json$/.test(f);
}

/**
 * Files that decide who may approve things, what the guards do, or what code runs. Agents never
 * edit them (spec §5.7 "must not edit CI, hooks or infrastructure"); only devops edits `.github/`.
 * `.git/` is included: a changed hook or config there turns the next commit or push against us.
 */
export function isProtectedConfigPath(p: string, role?: string): boolean {
  const f = canon(p);
  if (/(^|\/)(arima|team)\.yaml$/.test(f)) return true;
  if (/(^|\/)\.(claude|githooks|husky|git)(\/|$)/.test(f)) return true;
  if (/(^|\/)(\.mcp\.json|\.npmrc|claude\.md)$/.test(f)) return true;
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

/** Glob-like arguments (Glob's pattern, Grep's glob) that would reach a secret file. */
function globsReachSecrets(input: Record<string, unknown>, tool: string): boolean {
  const globs: string[] = [];
  if (tool === 'Glob' && typeof input['pattern'] === 'string') globs.push(input['pattern']);
  if (tool === 'Grep' && typeof input['glob'] === 'string') globs.push(input['glob']);
  return globs.some((g) =>
    [g.replace(/[*?]+/g, ''), g.replace(/[*?]+/g, '.x')].some((v) => isSecretPath(v)),
  );
}

// ---------------------------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------------------------

interface Simple {
  words: string[];
  /** A word contains $, a backtick or a substitution: its real value is unknown to the guard. */
  dynamic: boolean;
}

/**
 * A small shell tokenizer: quotes (including adjacent fragments like 'ma''in'), backslashes,
 * separators (newline ; & | and parentheses, so `$(...)` and `( ... )` contents become their own
 * commands) and a flag for words that cannot be resolved statically.
 */
export function parseCommands(input: string): Simple[] {
  const out: Simple[] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let dyn = false;
  const endWord = (): void => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const endCmd = (): void => {
    endWord();
    if (words.length > 0) out.push({ words, dynamic: dyn });
    words = [];
    dyn = false;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as string;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      cur += input.slice(i + 1, end < 0 ? input.length : end);
      has = true;
      i = end < 0 ? input.length : end;
    } else if (c === '"') {
      has = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          cur += input[i + 1];
          i += 2;
          continue;
        }
        if (input[i] === '$' || input[i] === '`') dyn = true;
        cur += input[i];
        i++;
      }
    } else if (c === '\\' && i + 1 < input.length) {
      if (input[i + 1] !== '\n') {
        cur += input[i + 1];
        has = true;
      }
      i++;
    } else if (c === '$' || c === '`') {
      dyn = true;
      cur += c;
      has = true;
    } else if (/\s/.test(c) && c !== '\n') {
      endWord();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCmd();
    } else {
      cur += c;
      has = true;
    }
  }
  endCmd();
  return out;
}

const WRAPPERS = new Set([
  'env',
  'command',
  'sudo',
  'nohup',
  'exec',
  'time',
  'nice',
  'xargs',
  'builtin',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh']);

/** The real command of a simple command: leading VAR=value and wrapper commands skipped. */
function headOf(words: string[]): { head: string; rest: string[] } | undefined {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return undefined;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const base = (w.split(/[\\/]/).pop() ?? w).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    if (WRAPPERS.has(base)) {
      i++;
      while (words[i]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++;
      continue;
    }
    return { head: base, rest: words.slice(i + 1) };
  }
}

/** Every simple command in the text, including those inside `bash -c "..."`, `eval`, `cmd /c`. */
function expandCommands(command: string, depth = 0): Simple[] {
  const out: Simple[] = [];
  for (const s of parseCommands(command)) {
    out.push(s);
    const h = headOf(s.words);
    if (h === undefined || depth >= 3) continue;
    if (SHELLS.has(h.head)) {
      const i = h.rest.findIndex((a) => /^(-c|-lc|\/c|\/k|-command|-c)$/i.test(a));
      const body = i >= 0 ? h.rest.slice(i + 1).join(' ') : '';
      if (body !== '') out.push(...expandCommands(body, depth + 1));
    } else if (h.head === 'eval') {
      out.push(...expandCommands(h.rest.join(' '), depth + 1));
    }
  }
  return out;
}

/** Branch names an agent may push (spec §10.2 branch scheme). Never the default branch. */
const AGENT_BRANCH = /^(feat|fix|hotfix|chore|docs)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PROTECTED_BRANCHES = ['main', 'master', 'trunk'];
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function gitCommand(h: {
  head: string;
  rest: string[];
}): { sub: string; args: string[]; globalC: string[] } | undefined {
  if (h.head !== 'git') return undefined;
  const w = h.rest;
  const globalC: string[] = [];
  let i = 0;
  while (i < w.length) {
    const t = w[i] as string;
    if (t === '-c') {
      globalC.push(w[i + 1] ?? '');
      i += 2;
    } else if (
      t === '-C' ||
      t === '--git-dir' ||
      t === '--work-tree' ||
      t === '--namespace' ||
      t === '--exec-path'
    )
      i += 2;
    else if (t.startsWith('-')) i += 1;
    else break;
  }
  const sub = w[i];
  return sub === undefined ? undefined : { sub, args: w.slice(i + 1), globalC };
}

const DANGEROUS_GIT_KEY =
  /^(core\.(hookspath|sshcommand|fsmonitor|editor|pager|askpass)|alias\.|credential\.|url\..*insteadof|remote\..*\.(url|pushurl|push)|safe\.)/i;

/** Rules for one git command. */
function guardGit(
  g: { sub: string; args: string[]; globalC: string[] },
  dynamic: boolean,
  ctx: GuardContext,
): Guard | undefined {
  const vcs = (reason: string): Guard => ({ rule: 'vcs', reason });
  if (g.globalC.some((kv) => DANGEROUS_GIT_KEY.test(kv.split('=')[0] ?? ''))) {
    return vcs(
      'overriding git settings on the command line (hooks, aliases, credentials, remotes) is not allowed',
    );
  }
  if (g.args.includes('--no-verify')) return vcs('skipping git hooks (--no-verify) is not allowed');
  if (g.args.some((a) => a === '--output' || a.startsWith('--output='))) {
    return vcs('git options that write to an arbitrary file (--output) are not allowed');
  }
  switch (g.sub) {
    case 'commit':
      if (g.args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) && !a.startsWith('--'))) {
        return vcs('skipping git hooks (-n / --no-verify) is not allowed');
      }
      if (dynamic) return vcs('commit arguments must be literal text, not shell substitutions');
      return undefined;
    case 'config':
      if (
        g.args.some((a) =>
          /hookspath|alias\.|sshcommand|insteadof|credential|remote\..*\.(url|pushurl|push)|core\.fsmonitor/i.test(
            a,
          ),
        )
      ) {
        return vcs(
          'changing where git hooks run from, aliases, credentials or remotes is not allowed',
        );
      }
      return undefined;
    case 'push': {
      if (dynamic) return vcs('push arguments must be literal text, not shell substitutions');
      const flags = g.args.filter((a) => a.startsWith('-'));
      const positional = g.args.filter((a) => !a.startsWith('-'));
      const strict = ctx.role !== undefined;
      const allowedFlags = flags.every((f) => f === '-u' || f === '--set-upstream');
      if (!allowedFlags)
        return vcs(
          'push flags other than -u are not allowed (no force, delete, mirror, tags, receive-pack...)',
        );
      if (positional.length !== 2) {
        return vcs(
          'push needs an explicit remote and branch (git push -u origin <your-branch>), so it cannot land on the default branch by accident',
        );
      }
      const [remote = '', spec = ''] = positional;
      if (!SAFE_NAME.test(remote)) return vcs('the push remote must be a plain remote name');
      if (spec.startsWith(':') || spec.startsWith('+'))
        return vcs('deleting or force-updating a remote branch is not allowed');
      const protectedNames = new Set([
        ...PROTECTED_BRANCHES,
        ...(ctx.defaultBranch ? [ctx.defaultBranch] : []),
      ]);
      const strip = (b: string): string => b.replace(/^refs\/heads\//, '');
      const [source = '', target = source] = spec.split(':');
      for (const b of [source, target]) {
        if (protectedNames.has(strip(b).toLowerCase())) {
          return vcs(
            `pushing to ${strip(b)} is not allowed; push your feature branch and open a pull request`,
          );
        }
      }
      if (strict) {
        // Agents may push only branches named like ARIMA's own scheme, from the same name or HEAD.
        const okSource = source === 'HEAD' || AGENT_BRANCH.test(source);
        const okTarget = AGENT_BRANCH.test(target) && !target.includes('..');
        if (!okSource || !okTarget) {
          return vcs(
            'an agent may push only a branch named feat/..., fix/..., hotfix/..., chore/... or docs/... (spec §10.2)',
          );
        }
      }
      return undefined;
    }
    case 'remote':
      return ctx.role !== undefined &&
        /^(add|set-url|set-head|rename|remove|rm|prune)$/.test(g.args[0] ?? '')
        ? vcs('changing git remotes is not allowed for agents')
        : undefined;
    default:
      return undefined;
  }
}

/** Rules for one GitHub CLI command. */
function guardGh(h: { head: string; rest: string[] }, ctx: GuardContext): Guard | undefined {
  if (h.head !== 'gh') return undefined;
  const vcs = (reason: string): Guard => ({ rule: 'vcs', reason });
  // Drop global flags (--repo X, -R X, --hostname X) to find the command group and subcommand.
  const w: string[] = [];
  for (let i = 0; i < h.rest.length; i++) {
    const t = h.rest[i] as string;
    if (t === '--repo' || t === '-R' || t === '--hostname') i++;
    else if (!t.startsWith('--repo=') && !t.startsWith('--hostname=')) w.push(t);
  }
  const [a, b] = [w[0], w[1]];
  if (a === 'pr' && b === 'merge')
    return vcs("merging is done only by ARIMA's merge script after human approval (spec §10.3)");
  if (a === 'api') {
    if (ctx.role !== undefined)
      return vcs('agents do not use `gh api`: it can merge, delete or change settings');
    const rest = w.slice(1);
    const mIdx = rest.findIndex((x) => /^(-X|--method)/i.test(x));
    let verb = 'GET';
    if (mIdx >= 0) {
      const m = /^(?:-X|--method)=?(.*)$/i.exec(rest[mIdx] as string);
      verb = ((m?.[1] ? m[1] : rest[mIdx + 1]) ?? '').toUpperCase();
    }
    const hasBody = rest.some((x) => /^(-f|-F|--field|--raw-field|--input)/.test(x));
    if (verb !== 'GET' || hasBody)
      return vcs('`gh api` calls that change anything are not allowed');
  }
  if (a === 'workflow' && b === 'run')
    return vcs('starting workflows (which can deploy) is not allowed for agents');
  if (a !== undefined && /^(release|secret|repo|auth|ssh-key|gpg-key)$/.test(a)) {
    return vcs(
      `\`gh ${a}\` can publish, delete or change credentials and settings; it is not allowed for agents`,
    );
  }
  return undefined;
}

const SECRET_WORDS =
  '(?:TOKEN|SECRET|API_?KEY|SECRET_KEY|PRIVATE_KEY|ACCESS_KEY|PASSWORD|PASSWD|CREDENTIALS?)';
const WRITE_VERBS =
  /(?:>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bdel\b|\btruncate\b|\bunlink\b|\bln\b|\bdd\b|\binstall\b|\bsed\s+-i|\bperl\s+-p?i|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bRemove-Item\b|\bClear-Content\b|\bNew-Item\b|\bCopy-Item\b|\bMove-Item\b|-delete\b|\bfind\b.*-exec|\bri\b|\bsc\b|\bni\b|\bcurl\b.*\s-o\b|unlinkSync|rmSync|os\.remove|shutil\.)/i;

/** The command with the text of commit messages blanked out, so prose about .env is not "touching" it. */
function withoutMessages(command: string): string {
  return command.replace(/(?:-m|--message)(?:=|\s+)(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g, '-m MSG');
}

/** Rules for a Bash command. Returns the first rule that matches. */
export function guardBash(command: string, ctx: GuardContext = {}): Guard | undefined {
  const c = withoutMessages(command);
  const lc = c.toLowerCase();
  if (
    /(^|[\s"'=:/\\])\.env(\.(?!example\b|sample\b|template\b|dist\b)[a-z0-9_-]+)?(?=$|[\s"';|&)<>])/i.test(
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
    /(^|[\s"'/\\])id_(rsa|dsa|ecdsa|ed25519)(?=$|[\s"';|&)])/i.test(c)
  ) {
    return { rule: 'secret-file', reason: 'the command touches a private key or certificate file' };
  }
  if (
    /\.config[/\\]arima[/\\]env\b/i.test(c) ||
    /[/\\]\.ssh[/\\]/.test(c) ||
    /\.aws[/\\]credentials/i.test(c) ||
    /\.credentials\.json/i.test(c) ||
    /\.config[/\\]gh[/\\]hosts\.yml/i.test(c) ||
    /(^|[\s"'/\\])\.(npmrc|git-credentials|netrc|pypirc)(?=$|[\s"';|&)])/i.test(c) ||
    /\.docker[/\\]config\.json|\.kube[/\\]config/i.test(c) ||
    /\/proc\/[^\s/]+\/environ/.test(c)
  ) {
    return { rule: 'secret-file', reason: 'the command touches a credentials file' };
  }
  if (
    new RegExp(`\\$\\{?[A-Za-z0-9_]*${SECRET_WORDS}\\}?(?![A-Za-z0-9_])`, 'i').test(c) ||
    new RegExp(`\\$env:[A-Za-z0-9_]*${SECRET_WORDS}(?![A-Za-z0-9_])`, 'i').test(c) ||
    new RegExp(`%[A-Za-z0-9_]*${SECRET_WORDS}%`, 'i').test(c) ||
    /\$\{?ARIMA_[A-Za-z0-9_]*\}?/.test(c) ||
    /GetEnvironmentVariable\s*\(\s*["'][^"']*(TOKEN|SECRET|KEY|PASSWORD)/i.test(c) ||
    /process\.env\b.*(TOKEN|SECRET|KEY|PASSWORD)|environ\b.*(TOKEN|SECRET|KEY|PASSWORD)/i.test(c) ||
    /\bARIMA_[A-Z0-9_]*(TOKEN|KEY|SECRET)/.test(c)
  ) {
    return {
      rule: 'secret-env',
      reason: 'the command refers to an environment variable that holds a secret',
    };
  }
  if (
    /\bprintenv\b/i.test(c) ||
    /\bGet-ChildItem\s+env:|\bgci\s+env:|\bdir\s+env:|\bls\s+env:/i.test(c) ||
    /^\s*(env|set|export\s+-p|declare\s+-p|compgen\s+-e)\s*($|\|)/i.test(c)
  ) {
    return { rule: 'secret-env', reason: 'listing the environment would expose secrets' };
  }
  if (
    /api\.notion\.com/i.test(c) &&
    /(-X\s*=?\s*DELETE|--request[\s=]+DELETE|in_trash|archived)/i.test(c)
  ) {
    return {
      rule: 'notion-delete',
      reason:
        'deleting or archiving in Notion is never allowed; retire items by status instead (spec §9.3)',
    };
  }
  if (/\.arima[/\\]/i.test(lc) && WRITE_VERBS.test(c)) {
    return {
      rule: 'protected-state',
      reason:
        'ARIMA state (mirror, logs, lock, kill switch) is written only by ARIMA scripts; propose Notion changes through .arima/outbox/',
    };
  }
  if (
    /rm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)[a-z]*\s+\.?\/?\.arima\b/i.test(c) ||
    /\bgit\s+(-C\s+\S*\.arima\b)/i.test(c)
  ) {
    return {
      rule: 'protected-state',
      reason: 'ARIMA state must not be deleted or edited directly',
    };
  }
  if (ctx.role !== undefined && /arima-(pause|init)\.mjs/i.test(c)) {
    return {
      rule: 'kill-switch',
      reason: 'only a human may pause, resume or initialise ARIMA; agents escalate instead',
    };
  }
  if (ctx.role !== undefined && /--allow-status-writes/.test(c)) {
    return {
      rule: 'protected-state',
      reason:
        'only a human may let the outbox write Status fields; agents propose, the state machine decides',
    };
  }
  for (const s of expandCommands(command)) {
    const h = headOf(s.words);
    if (h === undefined) continue;
    const git = gitCommand(h);
    const hit = git ? guardGit(git, s.dynamic, ctx) : guardGh(h, ctx);
    if (hit !== undefined) return hit;
  }
  return undefined;
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
          reason: `${path.basename(p.replace(/\\/g, '/'))} may hold secrets; ARIMA agents must not read or change secret files (spec §11.3)`,
        };
      }
      if (WRITE_TOOLS.has(tool) && isProtectedStatePath(p)) {
        return {
          rule: 'protected-state',
          reason: `${canon(p)} is written only by ARIMA scripts; propose Notion changes through .arima/outbox/ instead`,
        };
      }
      if (WRITE_TOOLS.has(tool) && ctx.role !== undefined && isProtectedConfigPath(p, ctx.role)) {
        return {
          rule: 'protected-config',
          reason: `${canon(p)} decides who may approve work, what the guards do, or what code runs; agents never edit it (spec §5.7)`,
        };
      }
    }
    if (globsReachSecrets(input, tool)) {
      return {
        rule: 'secret-file',
        reason: 'that search pattern would reach files that may hold secrets (spec §11.3)',
      };
    }
  }
  if (tool === 'Bash' && typeof input['command'] === 'string')
    return guardBash(input['command'], ctx);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Hook entry
// ---------------------------------------------------------------------------------------------

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
    return (
      /^git\s+(-C\s+\S+\s+)?(status|diff|log|show|branch(\s+--list)?|rev-parse|ls-files|remote(\s+-v)?)\b/.test(
        command.trim(),
      ) && !/--output/.test(command)
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
  if (p !== undefined) data['path'] = p.replace(/\\/g, '/');
  if (typeof input['command'] === 'string') data['command'] = input['command'];
  if (findSecrets(JSON.stringify(data)).length > 0)
    return { tool, note: 'details withheld: looked like a secret' };
  if (typeof data['path'] === 'string') data['path'] = data['path'].slice(0, 300);
  if (typeof data['command'] === 'string') data['command'] = data['command'].slice(0, 300);
  return data;
}

/** Appends an event, but never waits long: a blocked action must not depend on the log being free. */
async function log(
  projectDir: string,
  type: 'tool.blocked' | 'tool.used' | 'agent.stop',
  env: NodeJS.ProcessEnv,
  data: Record<string, unknown>,
): Promise<void> {
  const write = appendEvent(projectDir, {
    type,
    actor: actorFor(env),
    ...(env['ARIMA_RUN_ID'] ? { run_id: env['ARIMA_RUN_ID'] } : {}),
    ...(env['ARIMA_ITEM'] && env['ARIMA_ITEM'] !== 'none' ? { item: env['ARIMA_ITEM'] } : {}),
    data,
  }).catch(() => undefined);
  await Promise.race([write, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
}

/**
 * Handles one Claude Code hook call. Outside an ARIMA project (no arima.yaml up the tree) every
 * hook allows and logs nothing. Inside one, the PreToolUse guard FAILS CLOSED: an internal error
 * blocks (spec principle 10). The decision is returned without waiting on the event log. The audit
 * hooks stay fail-open.
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
