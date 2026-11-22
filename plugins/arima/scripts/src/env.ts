import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent } from './events.js';
import { checkKillSwitch } from './killswitch.js';
import { dockerfilesOf, lintCompose, lintDockerfile, mentionsProduction } from './compose-lint.js';
import type { Violation } from './compose-lint.js';
import { writeFileAtomic } from './lib/atomic-file.js';
import { findSecrets } from './lib/secrets.js';
import { getValidator } from './lib/schema.js';
import { dockerReady, realExec } from './sandbox.js';
import type { Exec } from './sandbox.js';

/**
 * Local environments (D-47): staging and preview Docker Compose projects on the owner's machine,
 * run by the host. `production` is not an environment of this module: it is refused with exit 70
 * under every condition (S10); only `arima-release` (WP-402) ever deploys it. Nothing here reads an
 * approval record, an environment variable or a flag that could change that.
 */

export const ENV_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  config: 10,
  killSwitch: 12,
  docker: 14,
  refused: 70,
  smokeFailed: 71,
  capacity: 72,
} as const;

export class EnvError extends Error {
  constructor(
    message: string,
    readonly exit: number,
  ) {
    super(message);
    this.name = 'EnvError';
  }
}

export type Target = { kind: 'staging' } | { kind: 'preview'; pr: number };

/** Only the exact names `staging` and `preview-<pr>`. Anything else, `production` included, is refused. */
export function parseTarget(name: string): Target {
  if (name === 'staging') return { kind: 'staging' };
  const m = /^preview-([1-9][0-9]{0,5})$/.exec(name);
  if (m) return { kind: 'preview', pr: Number(m[1]) };
  throw new EnvError(
    `refused: "${name.slice(0, 40)}" is not an environment arima-env manages (only staging and preview-<pr>); production deploys only through arima-release`,
    ENV_EXIT.refused,
  );
}

export const targetName = (t: Target): string =>
  t.kind === 'staging' ? 'staging' : `preview-${t.pr}`;

/** `<key>-staging` or `<key>-preview-<pr>`, lower case. Refuses a key that would name production. */
export function projectName(key: string, t: Target): string {
  const k = key.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (k === '' || mentionsProduction(k))
    throw new EnvError(`refused: the project key "${key}" names production`, ENV_EXIT.refused);
  return `${k}-${targetName(t)}`;
}

// ---- settings ---------------------------------------------------------------------------------------------

export interface EnvSettings {
  key: string;
  projectDir: string;
  composeFile: string;
  stagingPort: number | undefined;
  smokePath: (t: Target) => string;
  maxPreviews: number;
  previewPorts: [number, number];
  backupImage: string;
  defaultBranch: string;
  configuredProject: (t: Target) => string | undefined;
}

interface EnvCfg {
  project: { key: string };
  github?: { default_branch?: string };
  environments?: {
    max_previews?: number;
    compose_file?: string;
    preview_ports?: number[];
    backup_image?: string;
    staging?: { url?: string; compose_project?: string; smoke_path?: string };
  };
}

export function settingsFrom(projectDir: string, arima: unknown): EnvSettings {
  const c = arima as EnvCfg;
  const e = c.environments ?? {};
  let port: number | undefined;
  try {
    const u = new URL(e.staging?.url ?? '');
    if (u.port !== '' && ['localhost', '127.0.0.1'].includes(u.hostname)) port = Number(u.port);
  } catch {
    /* no usable url */
  }
  const range = e.preview_ports ?? [4100, 4199];
  return {
    key: c.project.key,
    projectDir,
    composeFile: e.compose_file ?? 'infra/compose.yaml',
    stagingPort: port,
    smokePath: () => e.staging?.smoke_path ?? '/healthz',
    maxPreviews: e.max_previews ?? 3,
    previewPorts: [range[0] ?? 4100, range[1] ?? 4199],
    backupImage: e.backup_image ?? 'alpine:3.20',
    defaultBranch: c.github?.default_branch ?? 'main',
    configuredProject: (t) => (t.kind === 'staging' ? e.staging?.compose_project : undefined),
  };
}

// ---- state ------------------------------------------------------------------------------------------------

export interface EnvRecord {
  project: string;
  port: number;
  ref: string;
  deployed_at: string;
  ok: boolean;
  /** Why a failed deploy failed (smoke or compose), for the diagnosis unit; absent when ok. */
  error?: string;
}
export interface EnvState {
  schema_version: 1;
  staging?: EnvRecord;
  staging_failed?: { ref: string; at: string; error: string; restored: boolean };
  previews: Record<string, EnvRecord>;
}

const stateFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'environments.json');

export function readEnvState(projectDir: string): EnvState {
  const f = stateFile(projectDir);
  if (!existsSync(f)) return { schema_version: 1, previews: {} };
  const data: unknown = JSON.parse(readFileSync(f, 'utf8'));
  const v = getValidator('environments-state');
  if (!v(data)) throw new EnvError(`${f} is not a valid environments file`, ENV_EXIT.failed);
  return data as EnvState;
}

function writeEnvState(projectDir: string, s: EnvState): void {
  const v = getValidator('environments-state');
  if (!v(s)) throw new Error('refusing to write an invalid environments file');
  writeFileAtomic(stateFile(projectDir), `${JSON.stringify(s, null, 2)}\n`);
}

// ---- dependencies ------------------------------------------------------------------------------------------

export interface EnvDeps {
  exec?: Exec;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Is the local TCP port free? Defaults to trying to listen on it. */
  portFree?: (port: number) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Home directory (for the host-side env file); tests. */
  home?: string;
  /** Overrides the 3-source kill switch check (tests). */
  isPaused?: () => Promise<boolean>;
  runId?: string;
}

const DOCKER_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'ALLUSERSPROFILE',
  'USERNAME',
  'USER',
  'LANG',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR',
];

/** An allow-listed environment: no Notion, GitHub or other token reaches Compose interpolation. */
export function dockerEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const want = new Set(DOCKER_ENV);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && want.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...extra };
}

const realPortFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  s: EnvSettings;
  t: Target;
  project: string;
  deps: Required<Pick<EnvDeps, 'exec' | 'fetch' | 'sleep' | 'now' | 'portFree'>> & EnvDeps;
  env: NodeJS.ProcessEnv;
}

function context(s: EnvSettings, name: string, deps: EnvDeps): Ctx {
  const t = parseTarget(name);
  const project = projectName(s.key, t);
  const cfgName = s.configuredProject(t);
  if (cfgName !== undefined && cfgName !== project)
    throw new EnvError(
      `refused: environments.${targetName(t)}.compose_project "${cfgName}" must equal ${project}`,
      ENV_EXIT.refused,
    );
  return {
    s,
    t,
    project,
    env: deps.env ?? process.env,
    deps: {
      ...deps,
      exec: deps.exec ?? realExec,
      fetch: deps.fetch ?? fetch,
      sleep: deps.sleep ?? realSleep,
      now: deps.now ?? (() => new Date()),
      portFree: deps.portFree ?? realPortFree,
    },
  };
}

async function guardRunning(c: Ctx, needDocker = true): Promise<void> {
  if (needDocker) {
    const d = await dockerReady(c.deps.exec);
    if (!d.ok) throw new EnvError(d.detail, ENV_EXIT.docker);
  }
}

async function guardNotPaused(c: Ctx): Promise<void> {
  const on = c.deps.isPaused
    ? await c.deps.isPaused()
    : (await checkKillSwitch(c.s.projectDir, null)).on;
  if (on) throw new EnvError('refusing: the kill switch is on', ENV_EXIT.killSwitch);
}

const hostEnvFile = (c: Ctx): string | undefined => {
  const home = c.deps.home ?? homedir();
  const f = path.join(
    home,
    '.config',
    'arima',
    c.s.key,
    targetName(c.t).replace(/-\d+$/, ''),
    'env',
  );
  return existsSync(f) ? f : undefined;
};

interface ComposeCall {
  dir: string;
  file: string;
  vars: Record<string, string>;
  extraFiles?: string[];
}

function composeArgs(c: Ctx, k: ComposeCall, args: string[]): string[] {
  const envFile = hostEnvFile(c);
  return [
    'compose',
    '-p',
    c.project,
    // Relative paths in the file (`build: ..`) resolve from the file's own folder, as for `docker compose -f`.
    '--project-directory',
    path.dirname(k.file),
    '-f',
    k.file,
    ...(k.extraFiles ?? []).flatMap((f) => ['-f', f]),
    ...(envFile ? ['--env-file', envFile] : []),
    ...args,
  ];
}

const compose = (c: Ctx, k: ComposeCall, args: string[], timeoutMs = 600_000) =>
  c.deps.exec('docker', composeArgs(c, k, args), {
    cwd: k.dir,
    timeoutMs,
    env: dockerEnv(c.env, k.vars),
  });

/** The end of some tool output for a message; withheld whole if it looks like it holds a secret. */
const tail = (s: string, n = 800): string => {
  const t = (s.length > n ? s.slice(-n) : s).trim();
  return findSecrets(t).length > 0 ? '[output withheld: it looks like it contains a secret]' : t;
};

let emptyCwd: string | undefined;
/** A folder with no compose file or .env in it: commands that address a project by name run there. */
function neutralDir(): string {
  emptyCwd ??= mkdtempSync(path.join(tmpdir(), 'arima-env-empty-'));
  return emptyCwd;
}

// ---- check ------------------------------------------------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
  validated: 'ok' | 'skipped' | 'failed';
  detail?: string;
}

export function lintFile(file: string, repoRoot: string): Violation[] {
  const text = readFileSync(file, 'utf8');
  const o = { composeDir: path.dirname(file), repoRoot };
  const out = lintCompose(text, o);
  for (const df of dockerfilesOf(text, o)) {
    if (!existsSync(df)) continue;
    out.push(...lintDockerfile(readFileSync(df, 'utf8'), path.relative(repoRoot, df)));
  }
  return out;
}

/** `arima-env check`: lint, then `docker compose config` when Docker answers (it needs no daemon, only the CLI). */
export async function checkCompose(
  s: EnvSettings,
  file: string | undefined,
  deps: EnvDeps = {},
): Promise<CheckResult> {
  const abs = path.resolve(s.projectDir, file ?? s.composeFile);
  if (!existsSync(abs)) throw new EnvError(`compose file not found: ${abs}`, ENV_EXIT.failed);
  // Only a file inside the project, after links are resolved: never an env file or a key elsewhere.
  const rel = path.relative(realpathSync(s.projectDir), realpathSync(abs));
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new EnvError('refused: --file must be inside the project', ENV_EXIT.refused);
  const violations = lintFile(abs, s.projectDir);
  let validated: CheckResult['validated'] = 'skipped';
  let detail: string | undefined;
  if (violations.length === 0) {
    const exec = deps.exec ?? realExec;
    const r = await exec(
      'docker',
      [
        'compose',
        '-p',
        'arima-check',
        '--project-directory',
        path.dirname(abs),
        '-f',
        abs,
        'config',
        '-q',
      ],
      {
        cwd: s.projectDir,
        timeoutMs: 60_000,
        env: dockerEnv(deps.env ?? process.env, {
          ARIMA_PROJECT: 'arima-check',
          ARIMA_ENV: 'staging',
          ARIMA_PORT: '3000',
          ARIMA_TAG: 'check',
        }),
      },
    );
    if (r.code === 0) validated = 'ok';
    else if (
      /not found|cannot find|ENOENT|is not recognized|not a docker command/i.test(r.stderr)
    ) {
      validated = 'skipped';
      detail = 'docker compose is not available; syntax was linted only';
    } else {
      validated = 'failed';
      detail = tail(r.stderr);
    }
  }
  return {
    ok: violations.length === 0 && validated !== 'failed',
    violations,
    validated,
    ...(detail ? { detail } : {}),
  };
}

// ---- snapshot of a git ref --------------------------------------------------------------------------------

interface Snapshot {
  dir: string;
  sha: string;
  dispose: () => void;
}

function findSymlink(dir: string): string | undefined {
  for (const e of readdirSync(dir)) {
    if (e === '.git') continue;
    const f = path.join(dir, e);
    const st = lstatSync(f);
    if (st.isSymbolicLink()) return f;
    if (st.isDirectory()) {
      const hit = findSymlink(f);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

async function snapshot(c: Ctx, ref: string): Promise<Snapshot> {
  const { exec } = c.deps;
  const git = (args: string[], env?: Record<string, string>) =>
    exec('git', args, {
      cwd: c.s.projectDir,
      timeoutMs: 120_000,
      ...(env ? { env: { ...dockerEnv(c.env), ...env } } : {}),
    });
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.code !== 0)
    throw new EnvError(`cannot resolve ref "${ref}" in ${c.s.projectDir}`, ENV_EXIT.failed);
  const sha = r.stdout.trim();
  const dir = mkdtempSync(path.join(tmpdir(), `arima-env-${c.project}-`));
  const index = path.join(dir, '.index');
  const out = path.join(dir, 'src');
  mkdirSync(out);
  const withIndex = { GIT_INDEX_FILE: index };
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });
  const a = await git(['read-tree', sha], withIndex);
  const b =
    a.code === 0 ? await git(['checkout-index', '-a', `--prefix=${out}${path.sep}`], withIndex) : a;
  if (b.code !== 0) {
    dispose();
    throw new EnvError(`cannot export ${ref}: ${tail(b.stderr, 300)}`, ENV_EXIT.failed);
  }
  // A link in the repository would let a Compose path point outside it after the textual check.
  const link = findSymlink(out);
  if (link !== undefined) {
    dispose();
    throw new EnvError(
      `refused: ${path.relative(out, link)} is a symbolic link; a deployed ref holds none`,
      ENV_EXIT.refused,
    );
  }
  return { dir: out, sha, dispose };
}

// ---- smoke ------------------------------------------------------------------------------------------------

export interface SmokeResult {
  ok: boolean;
  url: string;
  status?: number;
  attempts: number;
  error?: string;
}

export async function smokeUrl(
  url: string,
  deps: Pick<EnvDeps, 'fetch' | 'sleep'> & { timeoutS?: number; intervalMs?: number },
): Promise<SmokeResult> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const interval = deps.intervalMs ?? 2000;
  const max = Math.max(1, Math.ceil(((deps.timeoutS ?? 60) * 1000) / interval));
  let status: number | undefined;
  let error: string | undefined;
  for (let i = 1; i <= max; i++) {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      status = res.status;
      error = undefined;
      if (res.status >= 200 && res.status < 300) return { ok: true, url, status, attempts: i };
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 120) : String(e);
    }
    if (i < max) await sleep(interval);
  }
  return {
    ok: false,
    url,
    attempts: max,
    ...(status !== undefined ? { status } : {}),
    ...(error ? { error } : {}),
  };
}

function portOf(c: Ctx): number {
  if (c.t.kind === 'staging') {
    if (c.s.stagingPort === undefined)
      throw new EnvError(
        'environments.staging.url must be a local address with a port, for example http://localhost:3000',
        ENV_EXIT.config,
      );
    return c.s.stagingPort;
  }
  const rec = readEnvState(c.s.projectDir).previews[String(c.t.pr)];
  if (rec === undefined) throw new EnvError(`${targetName(c.t)} is not deployed`, ENV_EXIT.failed);
  return rec.port;
}

export async function smokeEnv(
  s: EnvSettings,
  name: string,
  deps: EnvDeps & { timeoutS?: number; intervalMs?: number } = {},
): Promise<SmokeResult> {
  const c = context(s, name, deps);
  const url = `http://127.0.0.1:${portOf(c)}${s.smokePath(c.t)}`;
  const r = await smokeUrl(url, {
    ...c.deps,
    ...(deps.timeoutS !== undefined ? { timeoutS: deps.timeoutS } : {}),
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
  });
  if (!r.ok)
    throw new EnvError(
      `smoke test failed: ${url} ${r.status ?? r.error ?? ''}`.trim(),
      ENV_EXIT.smokeFailed,
    );
  return r;
}

// ---- up ---------------------------------------------------------------------------------------------------

export interface UpResult {
  environment: string;
  project: string;
  ref: string;
  port: number;
  url: string;
  smoke: SmokeResult;
  evicted?: string;
}

interface Running {
  service: string;
  image: string;
}

/** Image ids of the containers a project runs now, per service (the rollback target). */
async function runningImages(c: Ctx, k: ComposeCall): Promise<Running[]> {
  const ps = await compose(c, k, ['ps', '-a', '--format', 'json']);
  if (ps.code !== 0) return [];
  const rows = parseJsonRows(ps.stdout);
  const out: Running[] = [];
  for (const r of rows) {
    const id = typeof r['ID'] === 'string' ? r['ID'] : undefined;
    const service = typeof r['Service'] === 'string' ? r['Service'] : undefined;
    if (id === undefined || service === undefined) continue;
    const i = await c.deps.exec('docker', ['inspect', '--format', '{{.Image}}', id], {
      timeoutMs: 30_000,
      env: dockerEnv(c.env),
    });
    if (i.code === 0 && i.stdout.trim() !== '') out.push({ service, image: i.stdout.trim() });
  }
  return out;
}

export function parseJsonRows(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (t === '') return [];
  try {
    const v: unknown = JSON.parse(t);
    return (Array.isArray(v) ? v : [v]).filter(
      (x): x is Record<string, unknown> => typeof x === 'object' && x !== null,
    );
  } catch {
    return t
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .flatMap((l) => {
        try {
          const v: unknown = JSON.parse(l);
          return typeof v === 'object' && v !== null ? [v as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      });
  }
}

export async function upEnv(
  s: EnvSettings,
  name: string,
  o: { ref?: string; timeoutS?: number; intervalMs?: number } & EnvDeps = {},
): Promise<UpResult> {
  const c = context(s, name, o);
  await guardNotPaused(c);
  await guardRunning(c);
  const target = c.t;
  const ref = o.ref ?? (target.kind === 'staging' ? s.defaultBranch : undefined);
  if (ref === undefined)
    throw new EnvError('up preview-<pr> needs --ref <branch or sha>', ENV_EXIT.usage);

  const snap = await snapshot(c, ref);
  const record = async (
    ok: boolean,
    port: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await appendEvent(s.projectDir, {
      type: target.kind === 'staging' ? 'deploy.staging' : 'deploy.preview',
      actor: 'system',
      ...(o.runId ? { run_id: o.runId } : {}),
      data: {
        environment: targetName(target),
        project: c.project,
        version: snap.sha,
        ok,
        port,
        ...extra,
      },
    });
  };
  try {
    const file = path.join(snap.dir, s.composeFile);
    if (!existsSync(file))
      throw new EnvError(`${s.composeFile} does not exist at ${ref}`, ENV_EXIT.failed);
    const violations = lintFile(file, snap.dir);
    if (
      violations.some((v) => v.rule === 'production-reference' || v.rule === 'host-file-reference')
    )
      throw new EnvError(
        `refused: the compose file reaches production or host files: ${violations
          .filter((v) => v.rule === 'production-reference' || v.rule === 'host-file-reference')
          .map((v) => `${v.where} (${v.detail})`)
          .join('; ')}`,
        ENV_EXIT.refused,
      );
    if (violations.length > 0)
      throw new EnvError(
        `compose file fails the design check: ${violations.map((v) => `${v.rule} at ${v.where}`).join('; ')}`,
        ENV_EXIT.failed,
      );

    // Port and capacity.
    const state = readEnvState(s.projectDir);
    let evicted: string | undefined;
    let port: number;
    if (target.kind === 'staging') {
      port = portOf(c);
      const mine = state.staging !== undefined;
      if (!mine && !(await c.deps.portFree(port)))
        throw new EnvError(`capacity: port ${port} is in use by something else`, ENV_EXIT.capacity);
    } else {
      const key = String(target.pr);
      const existing = state.previews[key];
      const others = Object.entries(state.previews).filter(([k]) => k !== key);
      if (existing === undefined && others.length >= s.maxPreviews) {
        const oldest = others.sort((a, b) => a[1].deployed_at.localeCompare(b[1].deployed_at))[0];
        if (oldest !== undefined) {
          evicted = `preview-${oldest[0]}`;
          await downEnv(s, evicted, c.deps);
        }
      }
      if (existing !== undefined) port = existing.port;
      else {
        const used = new Set(Object.values(readEnvState(s.projectDir).previews).map((p) => p.port));
        let found: number | undefined;
        for (let p = s.previewPorts[0]; p <= s.previewPorts[1]; p++) {
          if (!used.has(p) && (await c.deps.portFree(p))) {
            found = p;
            break;
          }
        }
        if (found === undefined)
          throw new EnvError('capacity: no free port in the preview range', ENV_EXIT.capacity);
        port = found;
      }
    }

    const tag = snap.sha.slice(0, 12);
    const k: ComposeCall = {
      dir: snap.dir,
      file,
      vars: {
        ARIMA_PROJECT: c.project,
        ARIMA_ENV: target.kind,
        ARIMA_PORT: String(port),
        ARIMA_TAG: tag,
        ...(target.kind === 'preview' ? { ARIMA_PREVIEW: String(target.pr) } : {}),
      },
    };

    // Rollback target (staging only): keep the images running now under a stable tag.
    const previous: Running[] = target.kind === 'staging' ? await runningImages(c, k) : [];
    const keepTag = (svc: string): string => `arima-local/${c.project}/${svc}:previous`;
    for (const p of previous)
      await c.deps.exec('docker', ['tag', p.image, keepTag(p.service)], {
        timeoutMs: 30_000,
        env: dockerEnv(c.env),
      });

    const build = await compose(c, k, ['build']);
    let failure: string | undefined =
      build.code === 0 ? undefined : `build failed: ${tail(build.stderr)}`;
    if (failure === undefined) {
      const up = await compose(c, k, [
        'up',
        '-d',
        '--remove-orphans',
        '--wait',
        '--wait-timeout',
        '120',
      ]);
      if (up.code !== 0) failure = `services did not become healthy: ${tail(up.stderr)}`;
    }
    const url = `http://127.0.0.1:${port}${s.smokePath(target)}`;
    let smoke: SmokeResult | undefined;
    if (failure === undefined) {
      smoke = await smokeUrl(url, {
        ...c.deps,
        ...(o.timeoutS !== undefined ? { timeoutS: o.timeoutS } : {}),
        ...(o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {}),
      });
      if (!smoke.ok) failure = `smoke test failed: ${smoke.status ?? smoke.error ?? 'no answer'}`;
    }

    const rec: EnvRecord = {
      project: c.project,
      port,
      ref: snap.sha,
      deployed_at: c.deps.now().toISOString(),
      ok: failure === undefined,
      ...(failure !== undefined ? { error: failure.slice(0, 600) } : {}),
    };
    if (failure === undefined && smoke !== undefined) {
      const st = readEnvState(s.projectDir);
      if (target.kind === 'staging') {
        st.staging = rec;
        delete st.staging_failed;
      } else st.previews[String(target.pr)] = rec;
      writeEnvState(s.projectDir, st);
      await record(true, port, { url, smoke: { status: smoke.status, attempts: smoke.attempts } });
      return {
        environment: targetName(target),
        project: c.project,
        ref: snap.sha,
        port,
        url,
        smoke,
        ...(evicted ? { evicted } : {}),
      };
    }

    // Failure.
    let restored = false;
    if (target.kind === 'staging' && previous.length > 0) {
      const override = path.join(snap.dir, '..', 'rollback.yaml');
      const body = [
        'services:',
        ...previous.flatMap((p) => [`  ${p.service}:`, `    image: ${keepTag(p.service)}`]),
      ].join('\n');
      writeFileSync(override, `${body}\n`);
      const r = await compose(c, { ...k, extraFiles: [override] }, [
        'up',
        '-d',
        '--no-build',
        '--remove-orphans',
        '--wait',
        '--wait-timeout',
        '120',
      ]);
      if (r.code === 0) {
        const again = await smokeUrl(url, {
          ...c.deps,
          timeoutS: 30,
          intervalMs: o.intervalMs ?? 2000,
        });
        restored = again.ok;
      }
    } else if (target.kind === 'staging') {
      await compose(c, k, ['down', '--remove-orphans']);
    }
    const st = readEnvState(s.projectDir);
    if (target.kind === 'preview') st.previews[String(target.pr)] = rec;
    else
      st.staging_failed = {
        ref: snap.sha,
        at: rec.deployed_at,
        error: (failure ?? '').slice(0, 600),
        restored,
      };
    writeEnvState(s.projectDir, st);
    await record(false, port, { error: failure, restored });
    throw new EnvError(
      `${failure}; ${target.kind === 'staging' ? (restored ? 'the previous version is running again' : previous.length > 0 ? 'the previous version could NOT be restored' : 'there was no previous version, staging is down') : 'the preview is left running for diagnosis'}`,
      ENV_EXIT.smokeFailed,
    );
  } finally {
    snap.dispose();
  }
}

// ---- down, status, logs ----------------------------------------------------------------------------------

export async function downEnv(s: EnvSettings, name: string, deps: EnvDeps = {}): Promise<void> {
  const c = context(s, name, deps);
  await guardRunning(c);
  const args = ['down', '--remove-orphans', ...(c.t.kind === 'preview' ? ['--volumes'] : [])];
  const r = await c.deps.exec('docker', ['compose', '-p', c.project, ...args], {
    cwd: neutralDir(),
    timeoutMs: 300_000,
    env: dockerEnv(c.env),
  });
  if (r.code !== 0) throw new EnvError(`down failed: ${tail(r.stderr)}`, ENV_EXIT.failed);
  const st = readEnvState(s.projectDir);
  if (c.t.kind === 'staging') {
    delete st.staging;
    delete st.staging_failed;
  } else delete st.previews[String(c.t.pr)];
  writeEnvState(s.projectDir, st);
}

export interface ServiceStatus {
  service: string;
  state: string;
  health: string;
}
export interface EnvStatus {
  environment: string;
  project: string;
  deployed?: EnvRecord;
  services: ServiceStatus[];
}

export async function statusEnv(
  s: EnvSettings,
  name: string,
  deps: EnvDeps = {},
): Promise<EnvStatus> {
  const c = context(s, name, deps);
  await guardRunning(c);
  const r = await c.deps.exec(
    'docker',
    ['compose', '-p', c.project, 'ps', '-a', '--format', 'json'],
    {
      cwd: neutralDir(),
      timeoutMs: 60_000,
      env: dockerEnv(c.env),
    },
  );
  if (r.code !== 0) throw new EnvError(`status failed: ${tail(r.stderr)}`, ENV_EXIT.failed);
  const st = readEnvState(s.projectDir);
  const deployed = c.t.kind === 'staging' ? st.staging : st.previews[String(c.t.pr)];
  return {
    environment: targetName(c.t),
    project: c.project,
    ...(deployed ? { deployed } : {}),
    services: parseJsonRows(r.stdout).map((x) => ({
      service: String(x['Service'] ?? x['Name'] ?? '?'),
      state: String(x['State'] ?? '?'),
      health: String(x['Health'] ?? ''),
    })),
  };
}

export async function logsEnv(
  s: EnvSettings,
  name: string,
  o: { tail?: number; service?: string } & EnvDeps = {},
): Promise<string> {
  const c = context(s, name, o);
  await guardRunning(c);
  const n = Math.min(Math.max(o.tail ?? 200, 1), 2000);
  if (o.service !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(o.service))
    throw new EnvError('service must be a plain name', ENV_EXIT.usage);
  const r = await c.deps.exec(
    'docker',
    [
      'compose',
      '-p',
      c.project,
      'logs',
      '--no-color',
      '--tail',
      String(n),
      ...(o.service ? [o.service] : []),
    ],
    { cwd: neutralDir(), timeoutMs: 60_000, env: dockerEnv(c.env) },
  );
  if (r.code !== 0) throw new EnvError(`logs failed: ${tail(r.stderr)}`, ENV_EXIT.failed);
  // Log text is untrusted data and may hold a secret the app printed: withhold such lines.
  return r.stdout
    .split(/\r?\n/)
    .map((l) => (findSecrets(l).length > 0 ? '[line withheld: looks like a secret]' : l))
    .join('\n');
}

// ---- backup and restore test ----------------------------------------------------------------------------

export const backupDir = (s: EnvSettings, name: string): string =>
  path.join(path.dirname(s.projectDir), `${path.basename(s.projectDir)}-backups`, name);

const SAFE_RUN = [
  '--rm',
  '--network',
  'none',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
];

export async function backupEnv(
  s: EnvSettings,
  name: string,
  deps: EnvDeps = {},
): Promise<string[]> {
  const c = context(s, name, deps);
  await guardNotPaused(c);
  await guardRunning(c);
  const ls = await c.deps.exec(
    'docker',
    ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${c.project}`],
    { timeoutMs: 30_000, env: dockerEnv(c.env) },
  );
  const vols = ls.stdout
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (ls.code !== 0 || vols.length === 0)
    throw new EnvError(`no named volumes found for ${c.project}`, ENV_EXIT.failed);
  const dir = backupDir(s, targetName(c.t));
  mkdirSync(dir, { recursive: true });
  const stamp = c.deps.now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const files: string[] = [];
  for (const v of vols) {
    const file = `${v}__${stamp}.tgz`;
    const r = await c.deps.exec(
      'docker',
      [
        'run',
        ...SAFE_RUN,
        '--mount',
        `type=volume,src=${v},dst=/data,readonly`,
        '--mount',
        `type=bind,src=${dir},dst=/backup`,
        s.backupImage,
        'tar',
        'czf',
        `/backup/${file}`,
        '-C',
        '/data',
        '.',
      ],
      { timeoutMs: 600_000, env: dockerEnv(c.env) },
    );
    if (r.code !== 0)
      throw new EnvError(`backup of ${v} failed: ${tail(r.stderr)}`, ENV_EXIT.failed);
    files.push(path.join(dir, file));
  }
  return files;
}

export interface RestoreResult {
  ok: boolean;
  checked: string[];
  failed: string[];
}

/** Restores the latest backup of each volume into a throwaway, network-less volume, checks it holds files, deletes it. */
export async function restoreTest(
  s: EnvSettings,
  name: string,
  deps: EnvDeps = {},
): Promise<RestoreResult> {
  const c = context(s, name, deps);
  await guardRunning(c);
  const dir = backupDir(s, targetName(c.t));
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tgz')) : [];
  const latest = new Map<string, string>();
  for (const f of all.sort()) latest.set(f.split('__')[0] as string, f);
  if (latest.size === 0) throw new EnvError(`no backup found in ${dir}`, ENV_EXIT.failed);
  const checked: string[] = [];
  const failed: string[] = [];
  const stamp = c.deps.now().getTime();
  let n = 0;
  for (const [vol, f] of latest) {
    const tmp = `arima-restore-test-${stamp}-${n++}`;
    try {
      const r = await c.deps.exec(
        'docker',
        [
          'run',
          ...SAFE_RUN,
          '--mount',
          `type=volume,src=${tmp},dst=/data`,
          '--mount',
          `type=bind,src=${dir},dst=/backup,readonly`,
          s.backupImage,
          'sh',
          '-c',
          // the file name is an argument ($0), never part of the script text
          'tar xzf "/backup/$0" -C /data && test "$(ls -A /data | wc -l)" -gt 0',
          f,
        ],
        { timeoutMs: 600_000, env: dockerEnv(c.env) },
      );
      (r.code === 0 ? checked : failed).push(vol);
    } finally {
      await c.deps.exec('docker', ['volume', 'rm', '-f', tmp], {
        timeoutMs: 30_000,
        env: dockerEnv(c.env),
      });
    }
  }
  return { ok: failed.length === 0, checked, failed };
}

// ---- after a merge ---------------------------------------------------------------------------------------

/**
 * What the dispatcher runs right after `arima-merge` (D-47, G-28): fetch the default branch and
 * rebuild staging from it, with the smoke test and the rollback of `upEnv`. Does nothing when the
 * repository has no compose file yet (Phase 3 not done). A failed deploy is recorded in the state
 * and the event log (the next plan holds a diagnosis unit); it is not thrown.
 */
export async function rebuildStagingAfterMerge(
  s: EnvSettings,
  deps: EnvDeps = {},
): Promise<'deployed' | 'skipped' | 'failed'> {
  const exec = deps.exec ?? realExec;
  const on = deps.isPaused ? await deps.isPaused() : (await checkKillSwitch(s.projectDir, null)).on;
  if (on) return 'skipped';
  let ref = s.defaultBranch;
  try {
    const fetchOk = await exec('git', ['fetch', 'origin', s.defaultBranch], {
      cwd: s.projectDir,
      timeoutMs: 120_000,
    });
    ref = fetchOk.code === 0 ? `origin/${s.defaultBranch}` : s.defaultBranch;
    const have = await exec('git', ['cat-file', '-e', `${ref}:${s.composeFile}`], {
      cwd: s.projectDir,
    });
    if (have.code !== 0) return 'skipped';
    await upEnv(s, 'staging', { ...deps, ref });
    return 'deployed';
  } catch (e) {
    // Any other error (git or fs throwing, say) is a failed rebuild too: it must reach the plan, not look like a failed merge.
    const message = e instanceof Error ? e.message : String(e);
    const exit = e instanceof EnvError ? e.exit : undefined;
    // upEnv already wrote the event and the state for a failed deploy; a refusal before that needs them here.
    const st = readEnvState(s.projectDir);
    if (st.staging_failed === undefined || exit !== ENV_EXIT.smokeFailed) {
      st.staging_failed = {
        ref,
        at: (deps.now?.() ?? new Date()).toISOString(),
        error: message.slice(0, 600),
        restored: false,
      };
      writeEnvState(s.projectDir, st);
      await appendEvent(s.projectDir, {
        type: 'deploy.staging',
        actor: 'system',
        data: { environment: 'staging', ok: false, error: message.slice(0, 600) },
      });
    }
    return 'failed';
  }
}

/** True while the last staging deploy failed and no good one has followed (the queue's `stagingSmokeFailing`). */
export function stagingFailing(
  projectDir: string,
): { ref: string; error: string; restored: boolean } | undefined {
  try {
    return readEnvState(projectDir).staging_failed;
  } catch {
    return undefined;
  }
}
