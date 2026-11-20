// WP-213: arima-env. Production is refused under every condition; staging rolls back on a failed
// smoke test; previews respect the port range and max_previews. Docker is a fake that records every
// call (git is real, on a real temp repository); the live check on real Docker is a separate record.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEnvCli } from '../src/cli/env-cli.js';
import { validateProject } from '../src/config.js';
import { readEvents } from '../src/events.js';
import {
  ENV_EXIT,
  dockerEnv,
  parseTarget,
  projectName,
  readEnvState,
  rebuildStagingAfterMerge,
  settingsFrom,
  smokeUrl,
  stagingFailing,
} from '../src/env.js';
import type { EnvDeps } from '../src/env.js';
import { setPauseFile } from '../src/killswitch.js';
import { realExec } from '../src/sandbox.js';
import type { Exec, ExecResult } from '../src/sandbox.js';
import { project, tempDir } from './helpers.js';

const COMPOSE = `
services:
  web:
    build: ..
    image: arima-local/\${ARIMA_PROJECT}-web:\${ARIMA_TAG}
    ports: ["127.0.0.1:\${ARIMA_PORT}:8080"]
    healthcheck: { test: ["CMD", "true"] }
    mem_limit: 256m
    volumes: ["data:/data"]
volumes:
  data: {}
`;

/** A temp app repo with arima.yaml (staging on :3099) and a committed compose file on `main`. */
function app(compose = COMPOSE, edits: [string | RegExp, string][] = []): string {
  const dir = project({
    arima: [['https://staging.example.com', 'http://localhost:3099'], ...edits],
  });
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(path.join(dir, 'infra'), { recursive: true });
  writeFileSync(path.join(dir, 'infra', 'compose.yaml'), compose);
  writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
  git('add', 'infra', 'Dockerfile');
  git('commit', '-q', '-m', 'init');
  return dir;
}

interface Call {
  file: string;
  args: string[];
  env: Record<string, string> | undefined;
}

/** A fake Docker. `good` says whether the version deployed right now answers the smoke request. */
function fake(
  opts: {
    dockerUp?: boolean;
    running?: boolean;
    upFails?: boolean;
    badVersion?: () => boolean;
  } = {},
) {
  const calls: Call[] = [];
  const state = { version: opts.running ? 'old' : 'none', bad: false };
  const exec: Exec = async (file, args, o) => {
    calls.push({ file, args, env: o?.env });
    if (file === 'git') return realExec(file, args, o);
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    const sub = args.filter((a) => !a.startsWith('-'));
    if (args[0] === 'info')
      return opts.dockerUp === false ? { code: 1, stdout: '', stderr: 'no daemon' } : ok('27.0.1');
    if (args[0] === 'inspect') return ok('sha256:oldimage');
    if (args[0] === 'tag' || (args[0] === 'volume' && args[1] === 'rm')) return ok();
    if (args[0] === 'volume' && args[1] === 'ls') return ok('tas-staging_data\n');
    if (args[0] === 'run') return ok();
    if (args[0] === 'compose') {
      if (args.includes('ps'))
        return ok(
          state.version === 'none'
            ? ''
            : JSON.stringify({ ID: 'abc', Service: 'web', State: 'running', Health: 'healthy' }) +
                '\n',
        );
      if (args.includes('build')) return ok();
      if (args.includes('down')) {
        state.version = 'none';
        return ok();
      }
      if (args.includes('up')) {
        if (args.some((a) => a.endsWith('rollback.yaml'))) {
          state.version = 'old';
          state.bad = false;
          return ok();
        }
        if (opts.upFails) return { code: 1, stdout: '', stderr: 'container web is unhealthy' };
        state.version = 'new';
        state.bad = opts.badVersion?.() ?? false;
        return ok();
      }
      if (args.includes('logs'))
        return ok(
          'web  | started\nweb  | token=ghp_' +
            'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' +
            '\nweb  | done\n',
        );
    }
    void sub;
    return ok();
  };
  const fetchFn = (async () => ({ status: state.bad ? 500 : 200 })) as unknown as typeof fetch;
  return { calls, state, exec, fetchFn };
}

function deps(f: ReturnType<typeof fake>, extra: Partial<EnvDeps> = {}): EnvDeps {
  return {
    exec: f.exec,
    fetch: f.fetchFn,
    sleep: () => Promise.resolve(),
    portFree: () => Promise.resolve(true),
    home: tempDir('arima-home-'),
    ...extra,
  };
}

async function run(
  dir: string,
  argv: string[],
  d: EnvDeps,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runEnvCli(
    ['--project', dir].length ? [argv[0] as string, ...argv.slice(1), '--project', dir] : argv,
    { out: (s) => (out += s), err: (s) => (err += s), cwd: dir },
    d,
  );
  return { code, out, err };
}

const dockerCalls = (f: ReturnType<typeof fake>): Call[] =>
  f.calls.filter((c) => c.file === 'docker');

describe('parseTarget: only staging and preview-<pr>', () => {
  it('accepts the two shapes', () => {
    expect(parseTarget('staging')).toEqual({ kind: 'staging' });
    expect(parseTarget('preview-7')).toEqual({ kind: 'preview', pr: 7 });
  });
  it.each([
    'production',
    'Production',
    'PRODUCTION',
    ' production',
    'production ',
    'prod',
    'prd',
    'live',
    'Staging',
    'staging ',
    'staging-production',
    'staging/../production',
    'preview-0',
    'preview-01',
    'preview-',
    'preview-1x',
    'preview-7;production',
    'preview--1',
    'preview-1234567',
    '',
    'tas-production',
    'production\n',
    'ｐｒｏｄｕｃｔｉｏｎ',
    'staging\u0000production',
    'all',
  ])('refuses %j with exit 70', (name) => {
    expect(() => parseTarget(name)).toThrowError(/refused/);
    try {
      parseTarget(name);
    } catch (e) {
      expect((e as { exit: number }).exit).toBe(ENV_EXIT.refused);
    }
  });
  it('a project key that names production, or a configured project name that differs, is refused', () => {
    expect(() => projectName('PRODUCTION', { kind: 'staging' })).toThrowError(/production/);
    expect(projectName('TAS', { kind: 'preview', pr: 9 })).toBe('tas-preview-9');
  });
});

describe('production is refused under every condition (S10)', () => {
  const subcommands = ['status', 'logs', 'smoke', 'up', 'down', 'backup', 'restore-test'];
  const conditions: { name: string; env: NodeJS.ProcessEnv; extra: string[] }[] = [
    { name: 'plain', env: {}, extra: [] },
    { name: 'DEPLOY_ENV=production', env: { DEPLOY_ENV: 'production' }, extra: [] },
    {
      name: 'ARIMA_ENV=production',
      env: { ARIMA_ENV: 'production', NODE_ENV: 'production' },
      extra: [],
    },
    { name: 'an approval flag', env: { APPROVED: 'true' }, extra: ['--approved'] },
    { name: '--force', env: {}, extra: ['--force'] },
    { name: '--ref production', env: {}, extra: ['--ref', 'production'] },
    { name: '--env production', env: {}, extra: ['--env', 'production'] },
  ];
  for (const sub of subcommands) {
    for (const c of conditions) {
      it(`${sub} production with ${c.name} writes nothing and runs nothing`, async () => {
        const dir = app();
        const f = fake({ running: true });
        const r = await run(dir, [sub, 'production', ...c.extra], deps(f, { env: c.env }));
        // an unknown flag is a usage error; the environment itself is never accepted either way
        expect([ENV_EXIT.refused, ENV_EXIT.usage]).toContain(r.code);
        if (c.extra.length === 0 || c.extra[0] === '--ref') expect(r.code).toBe(ENV_EXIT.refused);
        expect(f.calls).toEqual([]);
        expect(existsSync(path.join(dir, '.arima', 'state', 'environments.json'))).toBe(false);
        expect(existsSync(path.join(dir, '.arima', 'events.jsonl'))).toBe(false);
      });
    }
  }

  it('a present approval record in the mirror changes nothing', async () => {
    const dir = app();
    mkdirSync(path.join(dir, '.arima', 'mirror'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'mirror', 'releases.json'),
      JSON.stringify([{ id: 'REL-1', Status: 'Approved', 'Prod deploy approval': 'Approved' }]),
    );
    const f = fake();
    const r = await run(dir, ['up', 'production'], deps(f));
    expect(r.code).toBe(ENV_EXIT.refused);
    expect(f.calls).toEqual([]);
  });

  it('a compose project name from config that points elsewhere is refused before any docker call', async () => {
    const dir = app(COMPOSE, [
      [
        'staging:    { url: "http://localhost:3099", deploy: auto }',
        'staging:    { url: "http://localhost:3099", deploy: auto, compose_project: "tas-production" }',
      ],
    ]);
    const f = fake();
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.refused);
    expect(f.calls).toEqual([]);
  });

  it('a compose file that names the production project or volume is refused with 70 and never built', async () => {
    const dir = app(
      COMPOSE.replace('data: {}', 'tas-production-data: {}').replace(
        'data:/data',
        'tas-production-data:/data',
      ),
    );
    const f = fake();
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.refused);
    expect(dockerCalls(f).some((c) => c.args.includes('build') || c.args.includes('up'))).toBe(
      false,
    );
  });

  it('staging with production-looking variables in the environment still deploys only staging', async () => {
    const dir = app();
    const f = fake();
    const r = await run(
      dir,
      ['up', 'staging'],
      deps(f, {
        env: {
          DEPLOY_ENV: 'production',
          PATH: process.env['PATH'] ?? '',
          ARIMA_NOTION_TOKEN: 'x',
          GH_TOKEN: 'y',
        },
      }),
    );
    expect(r.code).toBe(0);
    for (const c of dockerCalls(f).filter((x) => x.args[0] === 'compose')) {
      expect(c.args[c.args.indexOf('-p') + 1]).toBe('tas-staging');
      expect(c.env).not.toHaveProperty('DEPLOY_ENV');
      expect(c.env).not.toHaveProperty('ARIMA_NOTION_TOKEN');
      expect(c.env).not.toHaveProperty('GH_TOKEN');
    }
  });
});

describe('dockerEnv', () => {
  it('keeps the docker essentials and drops every token', () => {
    const e = dockerEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        ARIMA_NOTION_TOKEN: 'n',
        GH_TOKEN: 'g',
        AWS_SECRET_ACCESS_KEY: 'a',
        DOCKER_HOST: 'unix:///x',
      },
      { ARIMA_PORT: '1' },
    );
    expect(Object.keys(e).sort()).toEqual(['ARIMA_PORT', 'DOCKER_HOST', 'HOME', 'PATH']);
  });
});

describe('up staging', () => {
  it('builds, starts, smoke-tests, records state and a deploy.staging event', async () => {
    const dir = app();
    const f = fake();
    const r = await run(dir, ['up', 'staging', '--run-id', 'r-20261120-0900-01'], deps(f));
    expect(r.code).toBe(0);
    expect(r.out).toContain('staging is up');
    const compose = dockerCalls(f).filter((c) => c.args[0] === 'compose');
    expect(compose.some((c) => c.args.includes('build'))).toBe(true);
    expect(compose.some((c) => c.args.includes('up') && c.args.includes('--wait'))).toBe(true);
    const up = compose.find((c) => c.args.includes('up'));
    expect(up?.env?.['ARIMA_PORT']).toBe('3099');
    expect(up?.env?.['ARIMA_PROJECT']).toBe('tas-staging');
    // relative paths in the compose file resolve from its own folder (found on real Docker)
    const pd = up?.args[up.args.indexOf('--project-directory') + 1] as string;
    expect(path.basename(pd)).toBe('infra');
    expect(up?.args[up.args.indexOf('-f') + 1]).toBe(path.join(pd, 'compose.yaml'));
    expect(readEnvState(dir).staging?.port).toBe(3099);
    const ev = readEvents(dir).find((e) => e.type === 'deploy.staging');
    expect(ev?.run_id).toBe('r-20261120-0900-01');
    expect(ev?.data).toMatchObject({ environment: 'staging', ok: true, port: 3099 });
    // never removes volumes
    expect(f.calls.some((c) => c.args.includes('-v') || c.args.includes('--volumes'))).toBe(false);
  });

  it('exports the ref, not the working tree (an uncommitted edit is not built)', async () => {
    const dir = app();
    writeFileSync(
      path.join(dir, 'infra', 'compose.yaml'),
      COMPOSE.replace('privileged', '') + '    privileged: true\n',
    );
    const f = fake();
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(0);
  });

  it('a failed smoke test restores the previous version and exits 71', async () => {
    const dir = app();
    const f = fake({ running: true, badVersion: () => true });
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.smokeFailed);
    expect(r.err).toContain('the previous version is running again');
    const calls = dockerCalls(f);
    expect(
      calls.some(
        (c) => c.args[0] === 'tag' && c.args[2] === 'arima-local/tas-staging/web:previous',
      ),
    ).toBe(true);
    const rollback = calls.find(
      (c) => c.args[0] === 'compose' && c.args.includes('up') && c.args.includes('--no-build'),
    );
    expect(rollback).toBeDefined();
    expect(f.state.version).toBe('old');
    const ev = readEvents(dir).find((e) => e.type === 'deploy.staging');
    expect(ev?.data).toMatchObject({ ok: false, restored: true });
    expect(readEnvState(dir).staging).toBeUndefined();
    expect(f.calls.some((c) => c.args.includes('--volumes'))).toBe(false);
  });

  it('a failed smoke test with nothing to restore takes staging down and exits 71', async () => {
    const dir = app();
    const f = fake({ badVersion: () => true });
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.smokeFailed);
    expect(r.err).toContain('no previous version');
    expect(f.state.version).toBe('none');
  });

  it('services that never become healthy are a failure with the same rollback', async () => {
    const dir = app();
    const f = fake({ running: true, upFails: true });
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.smokeFailed);
    expect(r.err).toContain('did not become healthy');
  });

  it('exit 72 when the staging port is taken by something else', async () => {
    const dir = app();
    const f = fake();
    const r = await run(
      dir,
      ['up', 'staging'],
      deps(f, { portFree: () => Promise.resolve(false) }),
    );
    expect(r.code).toBe(ENV_EXIT.capacity);
    expect(dockerCalls(f).some((c) => c.args.includes('build'))).toBe(false);
  });

  it('exit 12 with the kill switch on and no docker call', async () => {
    const dir = app();
    setPauseFile(dir, true);
    const f = fake();
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.killSwitch);
    expect(dockerCalls(f)).toEqual([]);
  });

  it('exit 14 when Docker is not running', async () => {
    const dir = app();
    const f = fake({ dockerUp: false });
    expect((await run(dir, ['up', 'staging'], deps(f))).code).toBe(ENV_EXIT.docker);
  });

  it('exit 1 and no build when the compose file fails the design check', async () => {
    const dir = app(
      COMPOSE.replace('    mem_limit: 256m\n', '    privileged: true\n    mem_limit: 256m\n'),
    );
    const f = fake();
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.failed);
    expect(r.err).toContain('privileged');
    expect(dockerCalls(f).some((c) => c.args.includes('build'))).toBe(false);
  });

  it('exit 10 when the staging url has no local port', async () => {
    const dir = app(COMPOSE, [['http://localhost:3099', 'https://staging.example.com']]);
    const f = fake();
    expect((await run(dir, ['up', 'staging'], deps(f))).code).toBe(ENV_EXIT.config);
  });
});

describe('up preview', () => {
  it('needs --ref', async () => {
    const dir = app();
    expect((await run(dir, ['up', 'preview-5'], deps(fake()))).code).toBe(ENV_EXIT.usage);
  });

  it('takes ports from the range, one per preview, and a project of its own', async () => {
    const dir = app();
    const f = fake();
    const a = await run(dir, ['up', 'preview-5', '--ref', 'main', '--json'], deps(f));
    const b = await run(dir, ['up', 'preview-6', '--ref', 'main', '--json'], deps(f));
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(JSON.parse(a.out)).toMatchObject({ port: 4100, project: 'tas-preview-5' });
    expect(JSON.parse(b.out)).toMatchObject({ port: 4101, project: 'tas-preview-6' });
    expect(readEvents(dir).filter((e) => e.type === 'deploy.preview')).toHaveLength(2);
  });

  it('skips ports that are in use and exits 72 when the range is exhausted', async () => {
    const dir = app(COMPOSE, [['environments:', 'environments:\n  preview_ports: [4100, 4101]']]);
    const f = fake();
    const used = new Set([4100]);
    const d = deps(f, { portFree: (p) => Promise.resolve(!used.has(p)) });
    expect(
      JSON.parse((await run(dir, ['up', 'preview-1', '--ref', 'main', '--json'], d)).out).port,
    ).toBe(4101);
    expect((await run(dir, ['up', 'preview-2', '--ref', 'main'], d)).code).toBe(ENV_EXIT.capacity);
  });

  it('removes the oldest preview (with its own volumes) when max_previews is reached', async () => {
    const dir = app(COMPOSE, [['environments:', 'environments:\n  max_previews: 2']]);
    const f = fake();
    let t = 0;
    const d = deps(f, { now: () => new Date(Date.UTC(2026, 10, 20, 0, t++)) });
    for (const n of [1, 2])
      expect((await run(dir, ['up', `preview-${n}`, '--ref', 'main'], d)).code).toBe(0);
    const r = await run(dir, ['up', 'preview-3', '--ref', 'main', '--json'], d);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).evicted).toBe('preview-1');
    expect(Object.keys(readEnvState(dir).previews).sort()).toEqual(['2', '3']);
    const down = dockerCalls(f).find(
      (c) => c.args.includes('down') && c.args.includes('tas-preview-1'),
    );
    expect(down?.args).toContain('--volumes');
  });

  it('a preview that fails its smoke test is left running for diagnosis and exits 71', async () => {
    const dir = app();
    const f = fake({ badVersion: () => true });
    const r = await run(dir, ['up', 'preview-4', '--ref', 'main'], deps(f));
    expect(r.code).toBe(ENV_EXIT.smokeFailed);
    expect(r.err).toContain('left running');
    expect(f.calls.some((c) => c.args.includes('down'))).toBe(false);
    expect(readEnvState(dir).previews['4']?.ok).toBe(false);
  });
});

describe('down, status, logs', () => {
  it('down staging keeps volumes; down preview removes its own', async () => {
    const dir = app();
    const f = fake();
    await run(dir, ['up', 'staging'], deps(f));
    await run(dir, ['up', 'preview-2', '--ref', 'main'], deps(f));
    f.calls.length = 0;
    expect((await run(dir, ['down', 'staging'], deps(f))).code).toBe(0);
    expect((await run(dir, ['down', 'preview-2'], deps(f))).code).toBe(0);
    const downs = dockerCalls(f).filter((c) => c.args.includes('down'));
    expect(downs[0]?.args).not.toContain('--volumes');
    expect(downs[1]?.args).toContain('--volumes');
    expect(readEnvState(dir)).toMatchObject({ previews: {} });
    expect(readEnvState(dir).staging).toBeUndefined();
  });

  it('down is allowed while the kill switch is on', async () => {
    const dir = app();
    setPauseFile(dir, true);
    expect((await run(dir, ['down', 'staging'], deps(fake()))).code).toBe(0);
  });

  it('status lists services', async () => {
    const dir = app();
    const f = fake({ running: true });
    const r = await run(dir, ['status', 'staging', '--json'], deps(f));
    expect(JSON.parse(r.out).services).toEqual([
      { service: 'web', state: 'running', health: 'healthy' },
    ]);
  });

  it('logs withhold a line that looks like a secret and refuse an odd service name', async () => {
    const dir = app();
    const f = fake({ running: true });
    const r = await run(dir, ['logs', 'staging', '--tail', '50'], deps(f));
    expect(r.out).toContain('web  | started');
    expect(r.out).toContain('[line withheld');
    expect(r.out).not.toContain('ghp_');
    expect((await run(dir, ['logs', 'staging', '--service', 'web;rm'], deps(f))).code).toBe(
      ENV_EXIT.usage,
    );
  });
});

describe('smoke', () => {
  const serve = (status: number): Promise<{ port: number; close: () => void }> =>
    new Promise((resolve) => {
      const s = http.createServer((_q, res) => {
        res.statusCode = status;
        res.end('ok');
      });
      s.listen(0, '127.0.0.1', () =>
        resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }),
      );
    });

  it('passes on a real 200 and fails on a real 500 (real HTTP)', async () => {
    const good = await serve(200);
    const bad = await serve(500);
    try {
      const ok = await smokeUrl(`http://127.0.0.1:${good.port}/healthz`, {
        sleep: () => Promise.resolve(),
        timeoutS: 4,
        intervalMs: 2000,
      });
      expect(ok).toMatchObject({ ok: true, status: 200, attempts: 1 });
      const no = await smokeUrl(`http://127.0.0.1:${bad.port}/healthz`, {
        sleep: () => Promise.resolve(),
        timeoutS: 4,
        intervalMs: 2000,
      });
      expect(no).toMatchObject({ ok: false, status: 500, attempts: 2 });
    } finally {
      good.close();
      bad.close();
    }
  });

  it('retries until the service answers', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n < 3) throw new Error('refused');
      return { status: 204 };
    }) as unknown as typeof fetch;
    expect(
      await smokeUrl('http://x/healthz', {
        fetch: f,
        sleep: () => Promise.resolve(),
        timeoutS: 20,
      }),
    ).toMatchObject({ ok: true, attempts: 3 });
  });

  it('a redirect is not a pass; the CLI exits 71 on failure', async () => {
    const dir = app();
    const f = fake({ running: true });
    const redirect = (async () => ({ status: 302 })) as unknown as typeof fetch;
    const r = await run(dir, ['smoke', 'staging', '--timeout', '2'], deps(f, { fetch: redirect }));
    expect(r.code).toBe(ENV_EXIT.smokeFailed);
  });
});

describe('check', () => {
  it('passes a clean file and lists violations with exit 1', async () => {
    const dir = app();
    const f = fake();
    const ok = await run(dir, ['check'], deps(f));
    expect(ok.code).toBe(0);
    writeFileSync(
      path.join(dir, 'infra', 'compose.yaml'),
      COMPOSE.replace('mem_limit: 256m', 'privileged: true'),
    );
    const bad = await run(dir, ['check'], deps(f));
    expect(bad.code).toBe(ENV_EXIT.failed);
    expect(bad.out).toContain('privileged');
    expect(bad.out).toContain('no-resource-limits');
  });
});

describe('backup and restore-test', () => {
  it('backs up each named volume read-only, network-less, outside the repo', async () => {
    const dir = app();
    const f = fake({ running: true });
    const r = await run(dir, ['backup', 'staging'], deps(f));
    expect(r.code).toBe(0);
    const runCall = dockerCalls(f).find((c) => c.args[0] === 'run');
    expect(runCall?.args).toEqual(
      expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL']),
    );
    expect(
      runCall?.args.some((a) => a.includes('src=tas-staging_data') && a.endsWith('readonly')),
    ).toBe(true);
    const dest = r.out.trim().split(/\r?\n/)[0] as string;
    expect(path.relative(dir, dest).startsWith('..')).toBe(true);
  });

  it('restore-test restores the latest backup into a throwaway volume and removes it', async () => {
    const dir = app();
    const f = fake({ running: true });
    const dest = path.join(path.dirname(dir), `${path.basename(dir)}-backups`, 'staging');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'tas-staging_data__20261120T000000.tgz'), 'x');
    writeFileSync(path.join(dest, 'tas-staging_data__20261121T000000.tgz'), 'x');
    const r = await run(dir, ['restore-test', 'staging'], deps(f));
    expect(r.code).toBe(0);
    const run1 = dockerCalls(f).find((c) => c.args[0] === 'run');
    expect(run1?.args.join(' ')).toContain('20261121');
    expect(run1?.args).toContain('none');
    const rm = dockerCalls(f).find((c) => c.args[0] === 'volume' && c.args[1] === 'rm');
    expect(rm?.args[3]).toMatch(/^arima-restore-test-/);
  });

  it('restore-test fails when no backup exists', async () => {
    const dir = app();
    expect((await run(dir, ['restore-test', 'staging'], deps(fake()))).code).toBe(ENV_EXIT.failed);
  });
});

describe('usage', () => {
  it('rejects unknown commands and a missing environment', async () => {
    const dir = app();
    expect((await run(dir, ['nope'], deps(fake()))).code).toBe(ENV_EXIT.usage);
    expect((await run(dir, ['up'], deps(fake()))).code).toBe(ENV_EXIT.usage);
    expect((await run(dir, ['up', 'staging', 'preview-1'], deps(fake()))).code).toBe(
      ENV_EXIT.usage,
    );
  });
  it('the state file is read back through the schema', () => {
    const dir = app();
    mkdirSync(path.join(dir, '.arima', 'state'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'state', 'environments.json'),
      '{"schema_version":1,"previews":{"x":1}}',
    );
    expect(() => readEnvState(dir)).toThrowError(/not a valid/);
    expect(readFileSync(path.join(dir, 'arima.yaml'), 'utf8')).toContain('localhost:3099');
  });
});

describe('rebuildStagingAfterMerge (the dispatcher hook, D-47, G-28)', () => {
  it('skips when the repository has no compose file yet', async () => {
    const dir = app();
    execFileSync('git', ['rm', '-q', '-r', 'infra'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'no infra'], { cwd: dir });
    const f = fake();
    const s = settingsFrom(dir, validateProject(dir).arima);
    expect(await rebuildStagingAfterMerge(s, deps(f))).toBe('skipped');
    expect(dockerCalls(f)).toEqual([]);
  });

  it('skips while the kill switch is on', async () => {
    const dir = app();
    setPauseFile(dir, true);
    const f = fake();
    const s = settingsFrom(dir, validateProject(dir).arima);
    expect(await rebuildStagingAfterMerge(s, deps(f))).toBe('skipped');
  });

  it('deploys, records the good result and clears an earlier failure', async () => {
    const dir = app();
    const s = settingsFrom(dir, validateProject(dir).arima);
    const bad = fake({ badVersion: () => true });
    expect(await rebuildStagingAfterMerge(s, deps(bad))).toBe('failed');
    expect(stagingFailing(dir)).toMatchObject({ restored: false });
    const good = fake();
    expect(await rebuildStagingAfterMerge(s, deps(good))).toBe('deployed');
    expect(stagingFailing(dir)).toBeUndefined();
    expect(readEnvState(dir).staging?.ok).toBe(true);
  });

  it('a failure is recorded, not thrown: state and a deploy.staging event with ok false', async () => {
    const dir = app();
    const s = settingsFrom(dir, validateProject(dir).arima);
    expect(await rebuildStagingAfterMerge(s, deps(fake({ dockerUp: false })))).toBe('failed');
    expect(stagingFailing(dir)?.error).toContain('Docker');
    expect(
      readEvents(dir).filter((e) => e.type === 'deploy.staging' && e.data?.['ok'] === false),
    ).toHaveLength(1);
  });
});

describe('judge J-agent:devops, major 2: a rebuild that throws is a failed rebuild', () => {
  it('an error that is not an EnvError reaches staging_failed and the event log instead of the merge', async () => {
    const dir = app();
    const s = settingsFrom(dir, validateProject(dir).arima);
    const d = deps(fake());
    const inner = d.exec as NonNullable<typeof d.exec>;
    const throwing = {
      ...d,
      exec: (async (cmd: string, args: string[], o: never) => {
        if (cmd === 'git' && args[0] === 'cat-file') throw new Error('git exec exploded');
        return inner(cmd, args, o);
      }) as typeof inner,
    };
    expect(await rebuildStagingAfterMerge(s, throwing)).toBe('failed');
    expect(stagingFailing(dir)?.error).toContain('git exec exploded');
    expect(
      readEvents(dir).filter((e) => e.type === 'deploy.staging' && e.data?.['ok'] === false),
    ).toHaveLength(1);
  });
});

describe('found by the independent attack (WP-213 review, section 7)', () => {
  it('--run-id must look like a run id', async () => {
    const dir = app();
    const r = await run(dir, ['up', 'staging', '--run-id', 'x\n{"forged":1}'], deps(fake()));
    expect(r.code).toBe(ENV_EXIT.usage);
  });

  it('check --file refuses a file outside the project and never echoes parser text', async () => {
    const dir = app();
    const outside = path.join(path.dirname(dir), 'secret.env');
    writeFileSync(outside, 'DB_URL=postgres://u:hunter2@h/db\n');
    const r = await run(dir, ['check', '--file', outside], deps(fake()));
    expect(r.code).toBe(ENV_EXIT.refused);
    expect(r.out + r.err).not.toContain('hunter2');
    // inside the project, a file that is not YAML: the excerpt is withheld
    writeFileSync(path.join(dir, 'infra', 'bad.yaml'), 'a: [\nDB_URL=postgres://u:hunter2@h/db\n');
    const r2 = await run(dir, ['check', '--file', 'infra/bad.yaml'], deps(fake()));
    expect(r2.out + r2.err).not.toContain('hunter2');
    expect(r2.out).toContain('yaml-syntax');
  });

  it('build or compose output that looks like a secret is withheld from messages, state and events', async () => {
    const dir = app();
    const f = fake();
    const leaky: typeof f.exec = async (file, args, o) => {
      if (file === 'docker' && args.includes('build'))
        return {
          code: 1,
          stdout: '',
          stderr: 'unknown instruction: token=ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
        };
      return f.exec(file, args, o);
    };
    const r = await run(dir, ['up', 'staging'], deps(f, { exec: leaky }));
    expect(r.code).toBe(ENV_EXIT.smokeFailed);
    const all =
      r.err +
      readFileSync(path.join(dir, '.arima', 'events.jsonl'), 'utf8') +
      readFileSync(path.join(dir, '.arima', 'state', 'environments.json'), 'utf8');
    expect(all).not.toContain('ghp_');
    expect(all).toContain('withheld');
  });

  it('down, status and logs run from a folder with no compose file or .env', async () => {
    const dir = app();
    writeFileSync(path.join(dir, 'compose.yaml'), 'services: { x: { image: evil } }\n');
    writeFileSync(path.join(dir, '.env'), 'X=1\n');
    const f = fake({ running: true });
    for (const sub of ['status', 'logs', 'down']) await run(dir, [sub, 'staging'], deps(f));
    const cwds = f.calls.filter((c) => c.args[0] === 'compose').map((c) => c.args.join(' '));
    expect(cwds.length).toBeGreaterThan(0);
    for (const c of f.calls.filter((x) => x.file === 'docker' && x.args[0] === 'compose')) {
      expect(c.args).not.toContain('-f');
    }
  });

  it('a symbolic link in the deployed ref is refused with 70 before any build', async () => {
    const dir = app();
    try {
      execFileSync('ln', ['-s', '/etc/hostname', path.join(dir, 'infra', 'link.env')], {
        cwd: dir,
      });
    } catch {
      return; // no symlink support here (Windows without the right): nothing to test
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'link'], { cwd: dir });
    const f = fake();
    const r = await run(dir, ['up', 'staging'], deps(f));
    expect(r.code).toBe(ENV_EXIT.refused);
    expect(dockerCalls(f).some((c) => c.args.includes('build'))).toBe(false);
  });

  it('restore-test passes the archive name as an argument, not as script text', async () => {
    const dir = app();
    const f = fake({ running: true });
    const dest = path.join(path.dirname(dir), `${path.basename(dir)}-backups`, 'staging');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'v;x__20261121T000000.tgz'), 'x');
    await run(dir, ['restore-test', 'staging'], deps(f));
    const call = dockerCalls(f).find((c) => c.args[0] === 'run');
    const script = call?.args[call.args.indexOf('-c') + 1] as string;
    expect(script).not.toContain('v;x');
    expect(call?.args.at(-1)).toBe('v;x__20261121T000000.tgz');
  });
});
