import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent } from './events.js';
import type { EventType } from './events.js';
import { enqueue } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';
import { getValidator } from './lib/schema.js';
import { migrateRecord } from './lib/migrate.js';

/**
 * `runtime.sandbox: docker` (WP-190, ADR-0006): the role's `claude -p` runs in a container that sees
 * a per-run CLONE of the work unit's branch, the plugin read-only, a scrubbed environment and no
 * push credential. The host makes the clone, fetches the commits back and imports the role's
 * outbox entries and audit events after the run. Nothing here mounts the main checkout, its `.git`,
 * `~/.claude`, `~/.config/arima` or the Docker socket, and `assertSafeDockerArgs` refuses an
 * argument list that would.
 */

export const SANDBOX_IMAGE_DEFAULT = 'arima-sandbox:1';
export const CONTAINER_WORK = '/work';
export const CONTAINER_PLUGIN = '/plugin';
/** Hosts a role container may reach through the egress proxy (ADR-0006); more via `runtime.sandbox_allow`. */
export const EGRESS_ALLOW_DEFAULT: readonly string[] = [
  'api.anthropic.com',
  'registry.npmjs.org',
  'statsig.anthropic.com',
];

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (
  file: string,
  args: string[],
  opts?: { cwd?: string; input?: string; timeoutMs?: number },
) => Promise<ExecResult>;

export const realExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

export type SandboxMode = 'docker' | 'none';

/** preflight: is the Docker daemon answering? (ADR-0006: refuse to dispatch a sandboxed role if not.) */
export async function dockerReady(exec: Exec = realExec): Promise<{ ok: boolean; detail: string }> {
  const r = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
  if (r.code === 0 && r.stdout.trim() !== '')
    return { ok: true, detail: `Docker is running (server ${r.stdout.trim()})` };
  return {
    ok: false,
    detail:
      'runtime.sandbox is docker but the Docker daemon is not answering; start Docker Desktop',
  };
}

const FORBIDDEN_MOUNT =
  /(docker\.sock|[\\/]\.claude\b|[\\/]\.config[\\/]arima|[\\/]\.ssh\b|[\\/]\.git(?:[\\/]|$|:))/i;

/** Refuses a `docker run` argument list that would weaken the sandbox. Returns the reasons (empty = safe). */
export function unsafeDockerArgs(args: string[]): string[] {
  const bad: string[] = [];
  const has = (a: string): boolean => args.includes(a);
  if (has('--privileged')) bad.push('--privileged');
  if (args.some((a) => a.startsWith('--cap-add'))) bad.push('--cap-add');
  if (args.some((a, i) => (a === '--network' || a === '--net') && args[i + 1] === 'host'))
    bad.push('host network');
  if (args.some((a) => /^--(pid|ipc|userns|uts)=?host$/.test(a))) bad.push('host namespace');
  args.forEach((a, i) => {
    if ((a === '-v' || a === '--volume' || a === '--mount') && args[i + 1] !== undefined) {
      if (FORBIDDEN_MOUNT.test(args[i + 1] as string)) bad.push(`mount ${args[i + 1]}`);
    }
  });
  if (!has('--cap-drop')) bad.push('capabilities not dropped');
  if (!args.includes('no-new-privileges')) bad.push('no-new-privileges missing');
  return bad;
}

export function assertSafeDockerArgs(args: string[]): void {
  const bad = unsafeDockerArgs(args);
  if (bad.length > 0) throw new Error(`refusing an unsafe sandbox: ${bad.join(', ')}`);
}

export interface DockerRunInput {
  name: string;
  image: string;
  cloneDir: string;
  pluginDir: string;
  envFile: string;
  /** An `--internal` network: no route out except to the egress proxy on it. */
  network: string;
  command: string[];
  /** uid:gid to run as on POSIX hosts, so files in the clone belong to the host user. */
  user?: string;
  memory?: string;
  pids?: number;
}

export function buildDockerRunArgs(i: DockerRunInput): string[] {
  const args = [
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
    i.name,
    '--network',
    i.network,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(i.pids ?? 512),
    '--memory',
    i.memory ?? '4g',
    '--env-file',
    i.envFile,
    '-v',
    `${i.cloneDir}:${CONTAINER_WORK}:rw`,
    '-v',
    `${i.pluginDir}:${CONTAINER_PLUGIN}:ro`,
    '-w',
    CONTAINER_WORK,
  ];
  if (i.user !== undefined) args.push('--user', i.user);
  args.push(i.image, ...i.command);
  assertSafeDockerArgs(args);
  return args;
}

/** Variables a container may get: the role's own, never the host's PATH, HOME or paths. */
const CONTAINER_ENV_KEEP =
  /^(ARIMA_(RUN_ID|ROLE|ITEM|KIND)|OTEL_|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|ARIMA_NOTION_TOKEN|NOTION_)/;

/** The container's environment: filtered from the host child env, plus fixed paths and the proxy. */
export function containerEnv(
  hostEnv: NodeJS.ProcessEnv,
  extra: { proxy?: string; oauthToken?: string | undefined; keep?: string[] } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: '/home/node',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    ARIMA_PROJECT_DIR: CONTAINER_WORK,
    CLAUDE_PLUGIN_ROOT: CONTAINER_PLUGIN,
  };
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v === undefined) continue;
    if (CONTAINER_ENV_KEEP.test(k) || (extra.keep ?? []).includes(k)) env[k] = v;
  }
  if (extra.oauthToken !== undefined) env['CLAUDE_CODE_OAUTH_TOKEN'] = extra.oauthToken;
  if (extra.proxy !== undefined) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'])
      env[k] = extra.proxy;
    env['NO_PROXY'] = 'localhost,127.0.0.1';
  }
  env['ARIMA_PROJECT_DIR'] = CONTAINER_WORK;
  return env;
}

/** Writes a docker `--env-file` (mode 0600; values never appear on a command line). Newlines in a value are refused. */
export function writeEnvFile(dir: string, env: Record<string, string>): string {
  const file = path.join(dir, 'env');
  for (const [k, v] of Object.entries(env))
    if (/[\r\n]/.test(v) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      throw new Error(`environment variable ${k} cannot be passed to a container`);
  writeFileSync(
    file,
    `${Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
    {
      mode: 0o600,
    },
  );
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on this platform */
  }
  return file;
}

export interface Clone {
  dir: string;
  /** The folder holding the clone and the env file, removed by `disposeClone`. */
  root: string;
}

/**
 * Makes the per-run clone: a plain clone of the work unit's branch (its `.git` is a real directory
 * inside the clone, so `git commit` works: G-14), with no remote, so nothing in it can push.
 */
export async function makeClone(
  exec: Exec,
  source: string,
  branch: string,
  base: string = tmpdir(),
): Promise<Clone> {
  const root = mkdtempSync(path.join(base, 'arima-sbx-'));
  const dir = path.join(root, 'work');
  const r = await exec('git', [
    'clone',
    '--quiet',
    '--no-hardlinks',
    '--branch',
    branch,
    source,
    dir,
  ]);
  if (r.code !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`could not clone ${branch} for the sandbox: ${r.stderr.trim()}`);
  }
  await exec('git', ['remote', 'remove', 'origin'], { cwd: dir });
  // The role's own .arima/ (outbox, audit events, run notes) lives in the clone; the host imports it.
  mkdirSync(path.join(dir, '.arima', 'outbox'), { recursive: true });
  // Local-only ignore so `.arima/` is never committed from the clone.
  const info = path.join(dir, '.git', 'info');
  mkdirSync(info, { recursive: true });
  writeFileSync(path.join(info, 'exclude'), '.arima/\n', { flag: 'a' });
  return { dir, root };
}

export function disposeClone(c: Clone): void {
  rmSync(c.root, { recursive: true, force: true, maxRetries: 3 });
}

/** Brings the role's commits into the host worktree: fast-forward only, so nothing is rewritten. */
export async function importCommits(
  exec: Exec,
  worktree: string,
  clone: Clone,
  branch: string,
): Promise<{ ok: boolean; commits: number; detail: string }> {
  const before = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  const r = await exec('git', ['pull', '--ff-only', '--quiet', clone.dir, branch], {
    cwd: worktree,
  });
  if (r.code !== 0)
    return {
      ok: false,
      commits: 0,
      detail: `the sandbox commits could not be fast-forwarded: ${r.stderr.trim()}`,
    };
  const n = await exec('git', ['rev-list', '--count', `${before.stdout.trim()}..HEAD`], {
    cwd: worktree,
  });
  return { ok: true, commits: Number(n.stdout.trim()) || 0, detail: 'ok' };
}

const AUDIT_TYPES = new Set<EventType>(['tool.used', 'tool.blocked']);

/**
 * Imports what the role wrote under its clone's `.arima/`: outbox entries (through the same
 * `enqueue` an in-process agent uses, so run and role binding and the secret scan apply) and
 * audit events (only tool events; run id forced to this run). Anything invalid is counted, not applied.
 */
export async function importArima(
  projectDir: string,
  clone: Clone,
  who: { runId: string; role: string },
): Promise<{ outbox: number; events: number; rejected: string[] }> {
  const rejected: string[] = [];
  let outbox = 0;
  let events = 0;
  const env = { ARIMA_RUN_ID: who.runId, ARIMA_ROLE: who.role };
  const ob = path.join(clone.dir, '.arima', 'outbox');
  if (existsSync(ob)) {
    const validate = getValidator('outbox');
    for (const name of readdirSync(ob)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      try {
        const entry = migrateRecord(
          'outbox',
          JSON.parse(readFileSync(path.join(ob, name), 'utf8')),
        );
        if (!validate(entry)) throw new Error('invalid outbox entry');
        enqueue(projectDir, entry as OutboxEntry, { env });
        outbox += 1;
      } catch (e) {
        rejected.push(`${name}: ${(e as Error).message}`);
      }
    }
  }
  const evFile = path.join(clone.dir, '.arima', 'events.jsonl');
  if (existsSync(evFile)) {
    for (const [i, line] of readFileSync(evFile, 'utf8').split('\n').entries()) {
      if (line.trim() === '') continue;
      try {
        const ev = JSON.parse(line) as {
          type?: string;
          data?: Record<string, unknown>;
          item?: string;
        };
        if (!AUDIT_TYPES.has(ev.type as EventType))
          throw new Error(`event type ${String(ev.type)} is not importable`);
        await appendEvent(projectDir, {
          type: ev.type as EventType,
          actor: who.role,
          run_id: who.runId,
          ...(ev.item !== undefined ? { item: ev.item } : {}),
          ...(ev.data !== undefined ? { data: ev.data } : {}),
        });
        events += 1;
      } catch (e) {
        rejected.push(`events.jsonl:${i + 1}: ${(e as Error).message}`);
      }
    }
  }
  return { outbox, events, rejected };
}

export interface SandboxOptions {
  exec?: Exec;
  image?: string;
  /** Extra hosts the egress proxy lets through (besides `EGRESS_ALLOW_DEFAULT`). */
  allow?: string[];
  /** Host folder of the plugin (mounted read-only). */
  pluginDir: string;
  /** Host worktree the work unit's branch is checked out in (the clone source and the import target). */
  worktree: string;
  projectDir: string;
  runId: string;
  role: string;
  /** The role's scrubbed child environment (from `childEnv`). */
  hostEnv: NodeJS.ProcessEnv;
  /** The seat token for the container only (ARIMA_SANDBOX_OAUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN on the host). */
  oauthToken?: string | undefined;
  /** Extra variable names (explicit opt-ins) to pass into the container. */
  keep?: string[];
  /** A base folder for the clone (tests). */
  tmp?: string;
}

export interface Sandbox {
  clone: Clone;
  container: string;
  /** The argument list for `docker` that runs `command` in the sandbox. */
  dockerArgs: (command: string[]) => string[];
  /** Kills the role container (kill switch, timeout). */
  kill: () => Promise<void>;
  /** After the run: bring commits and `.arima/` back, then remove the container, network and clone. */
  finish: () => Promise<{
    commits: { ok: boolean; commits: number; detail: string };
    imported: { outbox: number; events: number; rejected: string[] };
  }>;
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '-');

/** Starts the per-run network and egress proxy sidecar, makes the clone and the env file. */
export async function openSandbox(o: SandboxOptions): Promise<Sandbox> {
  const exec = o.exec ?? realExec;
  const image = o.image ?? SANDBOX_IMAGE_DEFAULT;
  const id = safeName(o.runId);
  const net = `arima-net-${id}`;
  const proxyName = `arima-egress-${id}`;
  const container = `arima-run-${id}`;
  const branchOut = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: o.worktree });
  const branch = branchOut.stdout.trim();
  if (branchOut.code !== 0 || branch === '' || branch === 'HEAD')
    throw new Error(
      `the worktree ${o.worktree} is not on a branch, so it cannot be cloned for the sandbox`,
    );

  const cleanup: (() => Promise<unknown>)[] = [];
  const undo = async (): Promise<void> => {
    for (const f of cleanup.reverse()) await f().catch(() => undefined);
  };
  try {
    const clone = await makeClone(exec, o.worktree, branch, o.tmp);
    cleanup.push(() => Promise.resolve(disposeClone(clone)));
    const created = await exec('docker', ['network', 'create', '--internal', net]);
    if (created.code !== 0)
      throw new Error(`could not create the sandbox network: ${created.stderr.trim()}`);
    cleanup.push(() => exec('docker', ['network', 'rm', net]));

    const allow = [...EGRESS_ALLOW_DEFAULT, ...(o.allow ?? [])];
    const sidecar = [
      'run',
      '-d',
      '--rm',
      '--name',
      proxyName,
      '--network',
      net,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '-v',
      `${o.pluginDir}:${CONTAINER_PLUGIN}:ro`,
      image,
      'node',
      `${CONTAINER_PLUGIN}/scripts/dist/arima-egress-proxy.mjs`,
      '--allow',
      allow.join(','),
      '--host',
      '0.0.0.0',
      '--port',
      '3128',
    ];
    assertSafeDockerArgs(sidecar);
    const s = await exec('docker', sidecar);
    if (s.code !== 0) throw new Error(`could not start the egress proxy: ${s.stderr.trim()}`);
    cleanup.push(() => exec('docker', ['rm', '-f', proxyName]));
    // The proxy is the only container on both the internal network and the outside one.
    const c = await exec('docker', ['network', 'connect', 'bridge', proxyName]);
    if (c.code !== 0)
      throw new Error(`could not connect the egress proxy outward: ${c.stderr.trim()}`);

    const env = containerEnv(o.hostEnv, {
      proxy: `http://${proxyName}:3128`,
      oauthToken: o.oauthToken,
      ...(o.keep ? { keep: o.keep } : {}),
    });
    const envFile = writeEnvFile(clone.root, env);
    const user =
      typeof process.getuid === 'function'
        ? `${process.getuid()}:${process.getgid?.() ?? 0}`
        : undefined;
    return {
      clone,
      container,
      dockerArgs: (command) =>
        buildDockerRunArgs({
          name: container,
          image,
          cloneDir: clone.dir,
          pluginDir: o.pluginDir,
          envFile,
          network: net,
          command,
          ...(user !== undefined ? { user } : {}),
        }),
      kill: async () => {
        await exec('docker', ['kill', container]);
      },
      finish: async () => {
        try {
          const commits = await importCommits(exec, o.worktree, clone, branch);
          const imported = await importArima(o.projectDir, clone, {
            runId: o.runId,
            role: o.role,
          });
          return { commits, imported };
        } finally {
          await exec('docker', ['rm', '-f', container]).catch(() => undefined);
          await undo();
        }
      },
    };
  } catch (e) {
    await undo();
    throw e;
  }
}
