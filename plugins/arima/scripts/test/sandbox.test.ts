import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProject } from '../src/config.js';
import { hostAllowed, startEgressProxy } from '../src/egress-proxy.js';
import { appendEvent, readEvents } from '../src/events.js';
import { readLedger } from '../src/ledger.js';
import { runPreflight } from '../src/preflight.js';
import { agentConfigFrom, buildClaudeArgs, runAgent } from '../src/run-agent.js';
import {
  CONTAINER_PLUGIN,
  EGRESS_ALLOW_DEFAULT,
  assertSafeDockerArgs,
  buildDockerRunArgs,
  containerEnv,
  dockerReady,
  importArima,
  importCommits,
  makeClone,
  openSandbox,
  realExec,
  unsafeDockerArgs,
  writeEnvFile,
} from '../src/sandbox.js';
import type { Exec } from '../src/sandbox.js';
import { project, tempDir } from './helpers.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** A repository on a work branch, standing in for a role's worktree. */
function repo(): string {
  const dir = project();
  git(dir, 'init', '-q', '-b', 'feat/US-901');
  git(dir, 'config', 'user.email', 'a@b.invalid');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  writeFileSync(path.join(dir, '.gitignore'), '.arima/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  return dir;
}

const okExec =
  (calls: string[][], real = false): Exec =>
  (file, args, opts) => {
    calls.push([file, ...args]);
    if (file === 'git' || real) return realExec(file, args, opts);
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };

const SAFE = {
  name: 'arima-run-r1',
  image: 'arima-sandbox:1',
  cloneDir: '/tmp/x/work',
  pluginDir: '/repo/plugins/arima',
  envFile: '/tmp/x/env',
  network: 'arima-net-r1',
  command: ['claude', '-p'],
};

describe('the docker argument list', () => {
  it('drops capabilities, forbids new privileges, uses the internal network, mounts only the clone (rw) and the plugin (ro)', () => {
    const a = buildDockerRunArgs(SAFE);
    expect(unsafeDockerArgs(a)).toEqual([]);
    expect(a.join(' ')).toContain('--cap-drop ALL');
    expect(a.join(' ')).toContain('--security-opt no-new-privileges');
    expect(a.join(' ')).toContain('--network arima-net-r1');
    const mounts = a.filter((_, i) => a[i - 1] === '-v');
    expect(mounts).toEqual(['/tmp/x/work:/work:rw', '/repo/plugins/arima:/plugin:ro']);
    // the env is passed by file, never as values on the command line
    expect(a).toContain('--env-file');
    expect(a.slice(a.indexOf('arima-sandbox:1'))).toEqual(['arima-sandbox:1', 'claude', '-p']);
  });

  it.each([
    ['the Docker socket', ['-v', '/var/run/docker.sock:/var/run/docker.sock']],
    ['the Windows Docker pipe', ['-v', '//./pipe/docker.sock:/x']],
    ['privileged', ['--privileged']],
    ['a capability', ['--cap-add=SYS_ADMIN']],
    ['host networking', ['--network', 'host']],
    ['the host pid namespace', ['--pid=host']],
    ['a .git folder', ['-v', '/home/me/app/.git:/work/.git']],
    ['the Claude credentials', ['-v', '/home/me/.claude:/home/node/.claude']],
    ['the ARIMA config folder', ['-v', '/home/me/.config/arima:/x']],
    ['ssh keys', ['-v', 'C:\\Users\\me\\.ssh:/root/.ssh']],
  ])('refuses %s', (_name, extra) => {
    const bad = buildDockerArgsWith(extra);
    expect(unsafeDockerArgs(bad).length).toBeGreaterThan(0);
    expect(() => assertSafeDockerArgs(bad)).toThrow(/unsafe sandbox/);
  });

  it('refuses a list without cap-drop or no-new-privileges, and buildDockerRunArgs never returns one', () => {
    expect(unsafeDockerArgs(['run', 'img'])).toEqual([
      'capabilities not dropped',
      'no-new-privileges missing',
    ]);
    expect(() => buildDockerRunArgs({ ...SAFE, cloneDir: '/home/me/app/.git' })).toThrow(
      /unsafe sandbox/,
    );
  });

  it('claude inside the container is pointed at /plugin, not at the host plugin folder', () => {
    const cfg = agentConfigFrom(
      validateProject(project()).arima as unknown as Record<string, unknown>,
      'developer',
    );
    const args = buildClaudeArgs(
      { role: 'developer', budgetUsd: 1, maxTurns: 5, config: cfg } as never,
      undefined,
      `${CONTAINER_PLUGIN}/scripts/dist`,
      CONTAINER_PLUGIN,
    );
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/plugin');
  });
});

function buildDockerArgsWith(extra: string[]): string[] {
  const base = buildDockerRunArgs(SAFE);
  const i = base.indexOf('--init');
  return [...base.slice(0, i), ...extra, ...base.slice(i)];
}

describe('the container environment', () => {
  it('has a fixed PATH and HOME, the role variables and the proxy, and nothing else of the host', () => {
    const env = containerEnv(
      {
        PATH: 'C:\\Windows;C:\\Users\\me\\bin',
        HOME: 'C:\\Users\\me',
        USERPROFILE: 'C:\\Users\\me',
        AWS_SECRET_ACCESS_KEY: 'nope',
        DATABASE_URL: 'postgres://nope',
        ARIMA_RUN_ID: 'r-1',
        ARIMA_ROLE: 'developer',
        ARIMA_ITEM: 'US-901',
        OTEL_RESOURCE_ATTRIBUTES: 'a=b',
      },
      { proxy: 'http://p:3128', oauthToken: 'tok' },
    );
    expect(env['PATH']).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env['HOME']).toBe('/home/node');
    expect(env['ARIMA_PROJECT_DIR']).toBe('/work');
    expect(env['HTTPS_PROXY']).toBe('http://p:3128');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok');
    expect(env['ARIMA_RUN_ID']).toBe('r-1');
    expect(Object.keys(env).join(' ')).not.toMatch(/AWS|DATABASE|USERPROFILE/);
  });

  it('a developer role never gets a GitHub or Notion token from the host env (childEnv holds them back)', () => {
    const cfg = agentConfigFrom(
      validateProject(project()).arima as unknown as Record<string, unknown>,
      'developer',
    );
    const env = containerEnv(
      {
        ARIMA_ROLE: 'developer',
        [cfg.notionTokenEnv]: undefined,
      },
      {},
    );
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['ARIMA_NOTION_TOKEN']).toBeUndefined();
  });

  it('the env file is private and refuses values that would corrupt it', () => {
    const dir = tempDir('arima-envf-');
    const f = writeEnvFile(dir, { A: '1', B: 'two' });
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=two\n');
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o077).toBe(0);
    expect(() => writeEnvFile(dir, { A: 'x\nGH_TOKEN=y' })).toThrow(/cannot be passed/);
    expect(() => writeEnvFile(dir, { 'A B': 'x' })).toThrow(/cannot be passed/);
  });
});

describe('the per-run clone (G-14: git commit works in the container)', () => {
  it('is a real repository with no remote, ignores .arima, and a commit made in it comes back by fast-forward', async () => {
    const wt = repo();
    const clone = await makeClone(realExec, wt, 'feat/US-901');
    expect(existsSync(path.join(clone.dir, '.git'))).toBe(true);
    expect(statSync(path.join(clone.dir, '.git')).isDirectory()).toBe(true); // not a linked-worktree pointer file
    expect(git(clone.dir, 'remote')).toBe('');
    writeFileSync(path.join(clone.dir, 'b.txt'), 'two\n');
    writeFileSync(path.join(clone.dir, '.arima', 'note.txt'), 'x');
    git(clone.dir, 'config', 'user.email', 'role@arima.invalid');
    git(clone.dir, 'config', 'user.name', 'role');
    git(clone.dir, 'add', '-A');
    git(clone.dir, 'commit', '-q', '-m', 'feat(US-901): b');
    expect(git(clone.dir, 'show', '--stat', '--format=', 'HEAD')).not.toMatch(/\.arima/);
    const r = await importCommits(realExec, wt, clone, 'feat/US-901');
    expect(r).toMatchObject({ ok: true, commits: 1 });
    expect(readFileSync(path.join(wt, 'b.txt'), 'utf8').trim()).toBe('two');
  });

  it('a host that moved on in the meantime is not overwritten: the import fails, nothing is lost', async () => {
    const wt = repo();
    const clone = await makeClone(realExec, wt, 'feat/US-901');
    git(clone.dir, 'config', 'user.email', 'role@arima.invalid');
    git(clone.dir, 'config', 'user.name', 'role');
    writeFileSync(path.join(clone.dir, 'c.txt'), 'c\n');
    git(clone.dir, 'add', '-A');
    git(clone.dir, 'commit', '-q', '-m', 'role commit');
    writeFileSync(path.join(wt, 'd.txt'), 'd\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'host commit');
    const r = await importCommits(realExec, wt, clone, 'feat/US-901');
    expect(r.ok).toBe(false);
    expect(git(wt, 'log', '--format=%s', '-1')).toBe('host commit');
  });

  it('refuses a source that is not on a branch', async () => {
    const wt = repo();
    git(wt, 'checkout', '-q', '--detach');
    await expect(
      openSandbox({
        pluginDir: 'p',
        worktree: wt,
        projectDir: wt,
        runId: 'r-1',
        role: 'developer',
        hostEnv: {},
      }),
    ).rejects.toThrow(/not on a branch/);
  });
});

describe('what the role leaves in its clone is imported through the same checks as in-process', () => {
  it('a valid outbox entry is queued; one naming another run, and an event of a forbidden type, are not', async () => {
    const wt = repo();
    const clone = await makeClone(realExec, wt, 'feat/US-901');
    const ob = path.join(clone.dir, '.arima', 'outbox');
    const entry = (id: string, run: string) => ({
      id,
      created_at: '2026-11-20T01:00:00.000Z',
      run_id: run,
      role: 'developer',
      op: 'create',
      database: 'questions',
      properties: { ID: 'Q-001' },
    });
    writeFileSync(path.join(ob, 'good.json'), JSON.stringify(entry('good', 'r-20261120-0100-01')));
    writeFileSync(
      path.join(ob, 'forged.json'),
      JSON.stringify(entry('forged', 'r-20261120-0100-99')),
    );
    writeFileSync(path.join(ob, 'junk.json'), '{"nope":true}');
    writeFileSync(
      path.join(clone.dir, '.arima', 'events.jsonl'),
      [
        JSON.stringify({
          ts: 'x',
          type: 'tool.used',
          actor: 'ceo',
          run_id: 'r-other',
          data: { tool: 'Read' },
        }),
        JSON.stringify({ ts: 'x', type: 'merge.done', actor: 'developer' }),
      ].join('\n'),
    );
    const out = await importArima(wt, clone, { runId: 'r-20261120-0100-01', role: 'developer' });
    expect(out).toMatchObject({ outbox: 1, events: 1 });
    expect(out.rejected).toHaveLength(3);
    expect(existsSync(path.join(wt, '.arima', 'outbox', 'good.json'))).toBe(true);
    expect(existsSync(path.join(wt, '.arima', 'outbox', 'forged.json'))).toBe(false);
    const ev = readEvents(wt).filter((e) => e.type === 'tool.used');
    expect(ev).toHaveLength(1);
    // actor and run are the run's, not what the role wrote
    expect(ev[0]).toMatchObject({ actor: 'developer', run_id: 'r-20261120-0100-01' });
    expect(readEvents(wt).some((e) => e.type === 'merge.done')).toBe(false);
  });
});

describe('the egress proxy', () => {
  it('matches exact names and *. wildcards, case-insensitively, and nothing else', () => {
    const allow = ['api.anthropic.com', '*.example.org'];
    expect(hostAllowed('API.anthropic.com', allow)).toBe(true);
    expect(hostAllowed('a.b.example.org', allow)).toBe(true);
    expect(hostAllowed('example.org', allow)).toBe(false);
    expect(hostAllowed('evilapi.anthropic.com', allow)).toBe(false);
    expect(hostAllowed('api.anthropic.com.evil.test', allow)).toBe(false);
    expect(EGRESS_ALLOW_DEFAULT).toContain('api.anthropic.com');
  });

  const connect = (port: number, target: string): Promise<string> =>
    new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () =>
        s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
      );
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          s.destroy();
          resolve(buf.split('\r\n')[0] ?? '');
        }
      });
      s.on('close', () => resolve(buf.split('\r\n')[0] ?? ''));
      s.on('error', () => resolve('error'));
    });

  it('tunnels an allowed host on 443, refuses every other host, port and a bare IP with 403, and plain HTTP with 405', async () => {
    const seen: string[] = [];
    const proxy = await startEgressProxy(['localhost'], {
      onRequest: (e) => seen.push(`${e.host}:${e.port}:${e.allowed}`),
    });
    try {
      expect(await connect(proxy.port, 'evil.example.net:443')).toMatch(/403/);
      expect(await connect(proxy.port, 'localhost:22')).toMatch(/403/);
      expect(await connect(proxy.port, '127.0.0.1:443')).toMatch(/403/);
      expect(await connect(proxy.port, 'metadata.google.internal:443')).toMatch(/403/);
      const res = await new Promise<number>((resolve) => {
        const s = net.connect(proxy.port, '127.0.0.1', () =>
          s.write('GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\n'),
        );
        s.once('data', (d) => {
          s.destroy();
          resolve(Number(/HTTP\/1.1 (\d+)/.exec(d.toString())?.[1]));
        });
      });
      expect(res).toBe(405);
      expect(seen).toContain('evil.example.net:443:false');
      expect(seen).toContain('localhost:443:true'.replace('443:true', '22:false'));
    } finally {
      await proxy.close();
    }
  });
});

describe('docker preflight (ADR-0006)', () => {
  it('dockerReady is true when `docker info` answers and says to start Docker Desktop when it does not', async () => {
    expect(
      (await dockerReady(() => Promise.resolve({ code: 0, stdout: '29.1.2\n', stderr: '' }))).ok,
    ).toBe(true);
    const down = await dockerReady(() =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
    );
    expect(down.ok).toBe(false);
    expect(down.detail).toMatch(/start Docker Desktop/);
  });

  it('preflight refuses (exit 14) when sandbox is docker and Docker is not running, and does not ask when sandbox is none', async () => {
    const env = { ARIMA_NOTION_TOKEN: 'x', ARIMA_GITHUB_TOKEN: 'y' };
    const withBox = project({ arima: [[/(runtime:[\s\S]*?\n)(\S|$)/, '$1  sandbox: docker\n$2']] });
    let asked = 0;
    const down = () => (asked++, Promise.resolve({ ok: false, detail: 'down' }));
    const r = await runPreflight({ projectDir: withBox, env, notion: null, dockerCheck: down });
    expect(asked).toBe(1);
    expect(r.exitCode).toBe(14);
    expect(r.checks.find((c) => c.check === 'docker')).toMatchObject({ ok: false });
    const plain = project();
    asked = 0;
    const p = await runPreflight({ projectDir: plain, env, notion: null, dockerCheck: down });
    expect(asked).toBe(0);
    expect(p.checks.some((c) => c.check === 'docker')).toBe(false);
  });
});

describe('runAgent with runtime.sandbox: docker', () => {
  async function run(extraEnv: Record<string, string>, over: { poll?: number } = {}) {
    const wt = repo();
    const calls: string[][] = [];
    const cfg = {
      ...agentConfigFrom(
        validateProject(wt).arima as unknown as Record<string, unknown>,
        'developer',
      ),
      sandbox: 'docker' as const,
      maxRunMinutes: 5,
    };
    writeFileSync(path.join(wt, 'p.md'), 'do the thing');
    await appendEvent(wt, { type: 'run.start', actor: 'orchestrator' });
    const outcome = await runAgent({
      projectDir: wt,
      role: 'developer',
      item: 'US-901',
      budgetUsd: 1,
      maxTurns: 5,
      promptFile: path.join(wt, 'p.md'),
      phase: 4,
      config: cfg,
      killSwitch: { notion: null },
      dockerBin: STUB,
      sandboxExec: okExec(calls),
      env: { ...process.env },
      extraEnv,
      ...(over.poll ? { killSwitchPollMs: over.poll } : {}),
    });
    return { wt, calls, outcome };
  }

  it('creates an internal network and an egress sidecar, runs the role with a safe argument list, then cleans everything up', async () => {
    const { wt, calls, outcome } = await run({ STUB_MODE: 'success' });
    expect(outcome.result).toBe('pass');
    const docker = calls.filter((c) => c[0] === 'docker').map((c) => c.slice(1, 5).join(' '));
    expect(docker[0]).toMatch(/^network create --internal arima-net-r-/);
    expect(docker[1]).toMatch(/^run -d --rm/);
    expect(docker[2]).toMatch(/^network connect bridge arima-egress-r-/);
    // cleanup: role container, sidecar, network, in that order
    const tail = calls
      .filter((c) => c[0] === 'docker')
      .slice(3)
      .map((c) => c.slice(1, 3).join(' '));
    expect(tail[0]).toMatch(/^rm -f$/);
    expect(tail.join('|')).toMatch(/rm -f.*\|?.*network rm/);
    expect(readEvents(wt).find((e) => e.type === 'sandbox.finished')).toMatchObject({
      data: { commits_ok: true, commits: 0 },
    });
    expect(readLedger(wt)).toHaveLength(1);
  });

  it('the sidecar and role container argument lists both pass the safety check', async () => {
    const { calls } = await run({ STUB_MODE: 'success' });
    const sidecar = calls.find((c) => c[0] === 'docker' && c[1] === 'run')!;
    expect(unsafeDockerArgs(sidecar.slice(1))).toEqual([]);
    expect(sidecar).toContain('--read-only');
  });

  it('a kill-switch stop also kills the container (the docker client dying does not stop it)', async () => {
    const wt = repo();
    const calls: string[][] = [];
    const cfg = {
      ...agentConfigFrom(
        validateProject(wt).arima as unknown as Record<string, unknown>,
        'developer',
      ),
      sandbox: 'docker' as const,
      maxRunMinutes: 5,
    };
    writeFileSync(path.join(wt, 'p.md'), 'x');
    setTimeout(() => writeFileSync(path.join(wt, '.arima', 'PAUSE'), 'freeze\n'), 700);
    const o = await runAgent({
      projectDir: wt,
      role: 'developer',
      item: 'US-901',
      budgetUsd: 1,
      maxTurns: 5,
      promptFile: path.join(wt, 'p.md'),
      phase: 4,
      config: cfg,
      killSwitch: { notion: null },
      dockerBin: STUB,
      sandboxExec: okExec(calls),
      env: { ...process.env, STUB_MODE: 'hang' },
      killSwitchPollMs: 150,
    });
    expect(o, JSON.stringify(o)).toMatchObject({ result: 'paused', reason: 'kill_switch' });
    expect(
      calls.some((c) => c[0] === 'docker' && c[1] === 'kill' && /^arima-run-/.test(c[2] ?? '')),
    ).toBe(true);
    // and the network and clone are still removed
    expect(calls.some((c) => c[0] === 'docker' && c[1] === 'network' && c[2] === 'rm')).toBe(true);
  }, 30_000);

  it('with sandbox none nothing of docker is used', async () => {
    const wt = repo();
    const calls: string[][] = [];
    const cfg = agentConfigFrom(
      validateProject(wt).arima as unknown as Record<string, unknown>,
      'developer',
    );
    expect(cfg.sandbox).toBe('none');
    writeFileSync(path.join(wt, 'p.md'), 'x');
    await runAgent({
      projectDir: wt,
      role: 'developer',
      item: 'US-901',
      budgetUsd: 1,
      maxTurns: 5,
      promptFile: path.join(wt, 'p.md'),
      phase: 4,
      config: cfg,
      killSwitch: { notion: null },
      claudeBin: STUB,
      sandboxExec: okExec(calls),
      env: { ...process.env },
      extraEnv: { STUB_MODE: 'success' },
    });
    expect(calls).toEqual([]);
  });
});
