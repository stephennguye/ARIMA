// Stage 0A: kill-switch hardening (judge blocker 4), including a real-git state-branch check.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Throttle } from '../src/lib/throttle.js';
import { checkKillSwitch, ensureNotionSwitch } from '../src/killswitch.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { PAUSE_TODO_TEXT, createNotionPort } from '../src/notion/port.js';
import { setKillSwitch } from '../src/pause.js';
import { runPreflight } from '../src/preflight.js';
import { remotePauseFlag } from '../src/state.js';
import { FakeNotion } from './fake-notion.js';
import { EXAMPLES, project, tempDir } from './helpers.js';

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ENV = { ARIMA_NOTION_TOKEN: 'x', ARIMA_GITHUB_TOKEN: 'y' };
const port = (f: FakeNotion) =>
  createNotionPort(f.client, new Throttle(0), { sleep: () => Promise.resolve() });

describe('kill switch: a Notion switch that is missing, created, or unreachable', () => {
  it('bootstrap creates the switch, unchecked', async () => {
    const f = new FakeNotion();
    await bootstrapTemplate(port(f), f.rootId);
    const todos = await port(f).listTodoBlocks(f.rootId);
    expect(todos).toEqual([{ id: expect.any(String), text: PAUSE_TODO_TEXT, checked: false }]);
  });

  it('ensureNotionSwitch creates a missing switch but never changes an existing one', async () => {
    const f = new FakeNotion();
    const p = port(f);
    expect(await ensureNotionSwitch(p, f.rootId)).toBe(true);
    expect(await ensureNotionSwitch(p, f.rootId)).toBe(false);
    const [sw] = await p.listTodoBlocks(f.rootId);
    await p.setTodoChecked(sw!.id, true);
    expect(await ensureNotionSwitch(p, f.rootId)).toBe(false);
    expect((await p.listTodoBlocks(f.rootId))[0]?.checked).toBe(true); // a pause is not cleared
  });

  it('a deleted or renamed switch stops the preflight (exit 12) and says how to fix it', async () => {
    const f = new FakeNotion();
    const dir = project({ arima: [['"<duplicated template root page id>"', `"${f.rootId}"`]] });
    const r = await runPreflight({
      projectDir: dir,
      env: ENV,
      notion: port(f),
      statePause: () => Promise.resolve(undefined),
    });
    expect(r.exitCode).toBe(12);
    expect(r.checks.find((c) => c.check === 'kill_switch')?.detail).toContain('--resume');
  });

  it('the state branch is consulted only when Notion cannot answer', async () => {
    const dir = tempDir();
    const f = new FakeNotion();
    await ensureNotionSwitch(port(f), f.rootId);
    let asked = 0;
    const remote = () => {
      asked += 1;
      return Promise.resolve(true as boolean | undefined);
    };
    const reachable = await checkKillSwitch(dir, { port: port(f), rootPageId: f.rootId }, remote);
    expect(reachable.on).toBe(false);
    expect(asked).toBe(0);
    f.down = true;
    const down = await checkKillSwitch(dir, { port: port(f), rootPageId: f.rootId }, remote);
    expect(down).toMatchObject({ on: true, notion: 'unreachable', stateBranch: true });
    expect(asked).toBe(1);
  });
});

describe('kill switch: PAUSE on the remote state branch (spec §11.3), real git', () => {
  function repo(): { dir: string; remote: string } {
    const remote = tempDir('arima-remote-');
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    const dir = tempDir('arima-app-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(path.join(dir, 'README.md'), '# x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'main');
    copyFileSync(path.join(EXAMPLES, 'arima.yaml'), path.join(dir, 'arima.yaml'));
    copyFileSync(path.join(EXAMPLES, 'team.yaml'), path.join(dir, 'team.yaml'));
    return { dir, remote };
  }
  function clone(remote: string): string {
    const parent = tempDir('arima-clone-');
    git(parent, '-c', 'core.autocrlf=false', 'clone', '-q', remote, 'work');
    const dir = path.join(parent, 'work');
    copyFileSync(path.join(EXAMPLES, 'arima.yaml'), path.join(dir, 'arima.yaml'));
    copyFileSync(path.join(EXAMPLES, 'team.yaml'), path.join(dir, 'team.yaml'));
    return dir;
  }

  it('a pause pushed from one machine stops another machine while Notion is down', async () => {
    const { dir: a, remote } = repo();
    await setKillSwitch({
      projectDir: a,
      on: true,
      reason: 'freeze',
      notion: null,
      saveState: true,
      now: new Date(2026, 10, 18, 2, 0),
    });
    expect(git(remote, 'ls-tree', '--name-only', 'arima-state')).toContain('PAUSE');

    const b = clone(remote);
    expect(existsSync(path.join(b, '.arima', 'PAUSE'))).toBe(false); // not pulled locally
    expect(remotePauseFlag({ projectDir: b })).toBe(true);

    const f = new FakeNotion();
    await ensureNotionSwitch(port(f), f.rootId);
    f.down = true;
    const r = await runPreflight({ projectDir: b, env: ENV, notion: port(f) });
    expect(r.exitCode).toBe(12);
    expect(r.checks.find((c) => c.check === 'kill_switch')?.detail).toContain(
      'remote state branch',
    );
  });

  it('after a resume the other machine runs again, with a warning that Notion was unreachable', async () => {
    const { dir: a, remote } = repo();
    await setKillSwitch({
      projectDir: a,
      on: true,
      notion: null,
      saveState: true,
      now: new Date(2026, 10, 18, 2, 0),
    });
    await setKillSwitch({
      projectDir: a,
      on: false,
      notion: null,
      saveState: true,
      now: new Date(2026, 10, 18, 3, 0),
    });
    const b = clone(remote);
    expect(remotePauseFlag({ projectDir: b })).toBe(false);
    const f = new FakeNotion();
    await ensureNotionSwitch(port(f), f.rootId);
    f.down = true;
    const r = await runPreflight({ projectDir: b, env: ENV, notion: port(f) });
    const ks = r.checks.find((c) => c.check === 'kill_switch');
    expect(ks?.ok).toBe(true);
    expect(ks?.warning).toMatch(/Notion unreachable/);
  });

  it('returns undefined (could not check) with no remote or no repo, and false when there is no state branch yet', () => {
    expect(remotePauseFlag({ projectDir: tempDir() })).toBeUndefined();
    const { dir } = repo();
    expect(remotePauseFlag({ projectDir: dir })).toBe(false);
    git(dir, 'remote', 'remove', 'origin');
    expect(remotePauseFlag({ projectDir: dir })).toBeUndefined();
  });
});
