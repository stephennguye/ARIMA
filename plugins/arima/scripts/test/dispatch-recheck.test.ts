// Judge #2 fixes: pause must say when state was not saved; dispatch re-checks Notion and the
// remote state branch; the budget caps are required.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPauseCli } from '../src/cli/project-cli.js';
import { readEvents } from '../src/events.js';
import { Throttle } from '../src/lib/throttle.js';
import { setNotionSwitch } from '../src/killswitch.js';
import { createNotionPort } from '../src/notion/port.js';
import { setKillSwitch } from '../src/pause.js';
import { DispatchRefused, runAgent } from '../src/run-agent.js';
import type { AgentConfig, RunAgentOptions } from '../src/run-agent.js';
import { FakeNotion } from './fake-notion.js';
import { EXAMPLES, tempDir } from './helpers.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const port = (f: FakeNotion) =>
  createNotionPort(f.client, new Throttle(0), { sleep: () => Promise.resolve() });

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  projectKey: 'TAS',
  perRunCap: 2,
  maxRunMinutes: 1,
  notionTokenEnv: 'ARIMA_NOTION_TOKEN',
  projectCap: 100,
  dailyCap: 20,
  ...over,
});

function gitProject(withRemote = false): string {
  const dir = tempDir('arima-proj-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  if (withRemote) {
    const bare = tempDir('arima-bare-');
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main');
  }
  copyFileSync(path.join(EXAMPLES, 'arima.yaml'), path.join(dir, 'arima.yaml'));
  copyFileSync(path.join(EXAMPLES, 'team.yaml'), path.join(dir, 'team.yaml'));
  return dir;
}

function cliIo(cwd: string) {
  const r = { out: '', err: '' };
  return {
    r,
    io: { out: (s: string) => (r.out += s), err: (s: string) => (r.err += s), cwd },
  };
}

function noGitProject(): string {
  const dir = tempDir('arima-nogit-');
  copyFileSync(path.join(EXAMPLES, 'arima.yaml'), path.join(dir, 'arima.yaml'));
  return dir;
}

describe('arima-pause exits non-zero when the state was not saved', () => {
  it('pause in a folder that is not a git repository: PAUSE file is set, but exit is 1 and says so', async () => {
    const dir = noGitProject();
    const c = cliIo(dir);
    const code = await runPauseCli(['--skip-notion', '--reason', 'freeze'], c.io, {});
    expect(existsSync(path.join(dir, '.arima', 'PAUSE'))).toBe(true);
    expect(code).toBe(1);
    expect(c.r.out + c.r.err).toMatch(/state not saved/);
    expect(c.r.err).toMatch(/other machines/i);
  });

  it('resume whose state push fails also exits 1 (the remote PAUSE would still be set)', async () => {
    const c = cliIo(noGitProject());
    expect(await runPauseCli(['--resume', '--skip-notion'], c.io, {})).toBe(1);
  });

  it('--no-state is an explicit choice and exits 0', async () => {
    const c = cliIo(noGitProject());
    expect(await runPauseCli(['--skip-notion', '--no-state'], c.io, {})).toBe(0);
  });

  it('a saved and pushed pause exits 0', async () => {
    const dir = gitProject(true);
    const c = cliIo(dir);
    expect(await runPauseCli(['--skip-notion', '--reason', 'x'], c.io, {})).toBe(0);
    expect(git(dir, 'ls-tree', '--name-only', 'arima-state')).toContain('PAUSE');
  });

  it('setKillSwitch reports stateSaved', async () => {
    const dir = gitProject(true);
    const r = await setKillSwitch({ projectDir: dir, on: true, notion: null, saveState: true });
    expect(r.stateSaved).toBe('pushed');
    const off = await setKillSwitch({ projectDir: dir, on: false, notion: null, saveState: false });
    expect(off.stateSaved).toBe('skipped');
  });
});

describe('dispatch re-checks the Notion switch and the remote state branch', () => {
  function setup() {
    const dir = gitProject();
    const prompt = path.join(dir, 'prompt.md');
    writeFileSync(prompt, 'Implement US-112.');
    return { dir, prompt };
  }
  const go = (
    s: { dir: string; prompt: string },
    over: Partial<RunAgentOptions> & Pick<RunAgentOptions, 'killSwitch'>,
  ) =>
    runAgent({
      projectDir: s.dir,
      role: 'developer',
      item: 'US-112',
      budgetUsd: 1,
      maxTurns: 10,
      promptFile: s.prompt,
      phase: 4,
      config: config(),
      claudeBin: STUB,
      env: { ...process.env },
      extraEnv: { STUB_MODE: 'success' },
      now: new Date(2026, 10, 17, 6, 3),
      ...over,
    });

  it('refuses when a human ticked the Notion switch after preflight (exit 12), with a hardstop event', async () => {
    const s = setup();
    const f = new FakeNotion();
    await setNotionSwitch(port(f), f.rootId, true);
    const p = go(s, { killSwitch: { notion: { port: port(f), rootPageId: f.rootId } } });
    await expect(p).rejects.toBeInstanceOf(DispatchRefused);
    const ev = readEvents(s.dir).find((e) => e.type === 'hardstop.hit');
    expect(ev?.data).toMatchObject({ stop: 'kill_switch' });
    await expect(
      go(s, { killSwitch: { notion: { port: port(f), rootPageId: f.rootId } } }),
    ).rejects.toMatchObject({ exitCode: 12 });
  });

  it('refuses when the Notion switch has been deleted (cannot tell, so paused)', async () => {
    const s = setup();
    const f = new FakeNotion(); // no switch block at all
    await expect(
      go(s, { killSwitch: { notion: { port: port(f), rootPageId: f.rootId } } }),
    ).rejects.toMatchObject({ exitCode: 12 });
  });

  it('refuses when Notion is down and the remote state branch carries PAUSE', async () => {
    const s = setup();
    const f = new FakeNotion();
    await setNotionSwitch(port(f), f.rootId, false);
    f.down = true;
    await expect(
      go(s, {
        killSwitch: {
          notion: { port: port(f), rootPageId: f.rootId },
          remotePause: () => Promise.resolve(true),
        },
      }),
    ).rejects.toMatchObject({ exitCode: 12 });
  });

  it('runs when every source says "not paused"', async () => {
    const s = setup();
    const f = new FakeNotion();
    await setNotionSwitch(port(f), f.rootId, false);
    const out = await go(s, {
      killSwitch: {
        notion: { port: port(f), rootPageId: f.rootId },
        remotePause: () => Promise.resolve(false),
      },
    });
    expect(out.result).toBe('pass');
  });

  it('the local PAUSE file still refuses with no Notion at all', async () => {
    const s = setup();
    await setKillSwitch({ projectDir: s.dir, on: true, notion: null, saveState: false });
    await expect(go(s, { killSwitch: { notion: null } })).rejects.toMatchObject({ exitCode: 12 });
  });

  it('the budget caps are required: a config without them is a type error and a runtime refusal', async () => {
    const s = setup();
    // @ts-expect-error projectCap and dailyCap are required
    const bad: AgentConfig = {
      projectKey: 'T',
      perRunCap: 2,
      maxRunMinutes: 1,
      notionTokenEnv: 'X',
    };
    await expect(go(s, { config: bad, killSwitch: { notion: null } })).rejects.toThrow(
      /projectCap and dailyCap/,
    );
  });
});
