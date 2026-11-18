import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStateCli } from '../src/cli/state-cli.js';
import { StateError, pullState, pushState, stateStatus } from '../src/state.js';
import { tempDir } from './helpers.js';

const RUN1 = 'r-20261117-0200-01';
const RUN2 = 'r-20261117-0200-02';
const RUN3 = 'r-20261118-0200-01';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const gitFails = (cwd: string, ...args: string[]): boolean => {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
};

function configure(repo: string): void {
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
}

/** An app repo with one commit on main and (optionally) a bare remote. */
function appRepo(withRemote = false): { repo: string; remote?: string } {
  const repo = tempDir('arima-app-');
  git(repo, 'init', '-q', '-b', 'main');
  configure(repo);
  writeFileSync(path.join(repo, 'README.md'), '# app\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  if (!withRemote) return { repo };
  const remote = tempDir('arima-remote-');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, remote };
}

function cloneOf(remote: string): string {
  const parent = tempDir('arima-clone-');
  const dir = path.join(parent, 'work');
  git(parent, '-c', 'core.autocrlf=false', 'clone', '-q', remote, 'work');
  configure(dir);
  return dir;
}

const put = (repo: string, rel: string, body: string): void => {
  const file = path.join(repo, '.arima', rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

describe('first push (no state branch anywhere)', () => {
  it('creates an orphan arima-state branch with one commit carrying the run id', async () => {
    const { repo } = appRepo();
    const mainBefore = git(repo, 'rev-parse', 'main');
    put(repo, 'state/ids.json', '{"schema_version":1,"counters":{}}\n');
    put(repo, 'events.jsonl', '{"x":1}\n');

    const r = await pushState({ projectDir: repo, runId: RUN1 });
    expect(r).toMatchObject({ committed: true, pushed: false });

    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(gitFails(repo, 'merge-base', 'main', 'arima-state')).toBe(true); // orphan: no shared history
    const log = git(repo, 'log', '--format=%s', 'arima-state').split('\n');
    expect(log).toEqual([`chore(state): run ${RUN1}`, 'chore(state): initialise arima-state']);
    const files = git(repo, 'ls-tree', '-r', '--name-only', 'arima-state').split('\n');
    expect(files).toEqual(
      expect.arrayContaining(['events.jsonl', 'state/ids.json', '.gitignore', '.gitattributes']),
    );
  });

  it('keeps main checked out on main with a clean tree', async () => {
    const { repo } = appRepo();
    put(repo, 'events.jsonl', 'a\n');
    await pushState({ projectDir: repo, runId: RUN1 });
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('does not commit lock or temp files', async () => {
    const { repo } = appRepo();
    put(repo, 'events.jsonl', 'a\n');
    put(repo, 'run.lock', '{}');
    put(repo, 'state/ids.json.lock', '1');
    put(repo, 'state/x.json.123.tmp', '1');
    await pushState({ projectDir: repo, runId: RUN1 });
    const files = git(repo, 'ls-tree', '-r', '--name-only', 'arima-state');
    expect(files).not.toMatch(/\.lock|\.tmp/);
  });
});

describe('subsequent pushes', () => {
  it('makes exactly one commit per push, and none when nothing changed', async () => {
    const { repo } = appRepo();
    put(repo, 'events.jsonl', 'a\n');
    await pushState({ projectDir: repo, runId: RUN1 });
    const count = (): number => Number(git(repo, 'rev-list', '--count', 'arima-state'));
    const base = count();
    put(repo, 'events.jsonl', 'a\nb\n');
    put(repo, 'ledger.jsonl', 'l\n');
    expect((await pushState({ projectDir: repo, runId: RUN2 })).committed).toBe(true);
    expect(count()).toBe(base + 1);
    expect(git(repo, 'log', '-1', '--format=%s', 'arima-state')).toBe(`chore(state): run ${RUN2}`);
    // The state.push event itself is state, so an immediate re-push commits only that event line.
    const again = await pushState({ projectDir: repo, runId: RUN3 });
    expect(count()).toBe(base + (again.committed ? 2 : 1));
  });

  it('rejects a malformed run id', async () => {
    const { repo } = appRepo();
    await expect(pushState({ projectDir: repo, runId: 'run-7' })).rejects.toThrow(
      /does not look like/,
    );
  });
});

describe('with a remote', () => {
  it('pushes only the state branch, never main', async () => {
    const { repo, remote } = appRepo(true);
    const remoteMain = git(remote as string, 'rev-parse', 'main');
    // Make a local commit on main that must NOT be pushed.
    writeFileSync(path.join(repo, 'local.txt'), 'x');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'local only');
    put(repo, 'events.jsonl', 'a\n');
    const r = await pushState({ projectDir: repo, runId: RUN1 });
    expect(r.pushed).toBe(true);
    expect(git(remote as string, 'rev-parse', 'main')).toBe(remoteMain);
    expect(git(remote as string, 'rev-parse', 'arima-state')).toBe(
      git(repo, 'rev-parse', 'arima-state'),
    );
  });

  it('pull -> modify -> push -> a fresh clone pulls the same state back', async () => {
    const { repo, remote } = appRepo(true);
    put(repo, 'events.jsonl', '{"n":1}\n');
    put(repo, 'state/ids.json', '{"schema_version":1,"counters":{"US":3}}\n');
    await pullState({ projectDir: repo });
    put(repo, 'ledger.jsonl', '{"cost":1}\n');
    await pushState({ projectDir: repo, runId: RUN1 });

    const fresh = cloneOf(remote as string);
    expect(existsSync(path.join(fresh, '.arima'))).toBe(false);
    const pulled = await pullState({ projectDir: fresh });
    expect(pulled.head).toBe(git(repo, 'rev-parse', 'arima-state'));
    expect(readFileSync(path.join(fresh, '.arima', 'state', 'ids.json'), 'utf8')).toBe(
      '{"schema_version":1,"counters":{"US":3}}\n',
    );
    expect(readFileSync(path.join(fresh, '.arima', 'ledger.jsonl'), 'utf8')).toBe('{"cost":1}\n');
    expect(git(fresh, 'status', '--porcelain')).toBe('');
    expect(git(fresh, 'branch', '--show-current')).toBe('main');
  });

  it('fast-forwards when the remote is ahead', async () => {
    const { repo, remote } = appRepo(true);
    put(repo, 'events.jsonl', 'a\n');
    await pushState({ projectDir: repo, runId: RUN1 });
    const other = cloneOf(remote as string);
    await pullState({ projectDir: other });
    put(other, 'events.jsonl', 'a\nb\n');
    await pushState({ projectDir: other, runId: RUN2 });

    const r = await pullState({ projectDir: repo });
    expect(r.updated).toBe(true);
    expect(readFileSync(path.join(repo, '.arima', 'events.jsonl'), 'utf8')).toContain('b\n');
  });

  it('reports divergence instead of merging', async () => {
    const { repo, remote } = appRepo(true);
    put(repo, 'events.jsonl', 'a\n');
    await pushState({ projectDir: repo, runId: RUN1 });
    const other = cloneOf(remote as string);
    await pullState({ projectDir: other });
    put(other, 'other.txt', 'o\n');
    await pushState({ projectDir: other, runId: RUN2 });
    // repo commits locally without pulling, then tries to pull
    put(repo, 'mine.txt', 'm\n');
    git(path.join(repo, '.arima'), 'add', '-A');
    git(path.join(repo, '.arima'), 'commit', '-q', '-m', 'local state commit');
    await expect(pullState({ projectDir: repo })).rejects.toThrow(/diverged/);
  });

  it('status reports the worktree, dirtiness and unpushed commits', async () => {
    const { repo } = appRepo(true);
    expect(stateStatus({ projectDir: repo })).toMatchObject({ worktree: false });
    put(repo, 'events.jsonl', 'a\n');
    await pushState({ projectDir: repo, runId: RUN1 });
    expect(stateStatus({ projectDir: repo })).toMatchObject({
      worktree: true,
      dirty: false,
      ahead: 0,
    });
    put(repo, 'x.txt', 'x');
    expect(stateStatus({ projectDir: repo }).dirty).toBe(true);
  });
});

describe('safety', () => {
  it('refuses to commit state that looks like it contains a secret', async () => {
    const { repo } = appRepo();
    put(repo, 'events.jsonl', 'ok\n');
    await pushState({ projectDir: repo, runId: RUN1 });
    const before = git(repo, 'rev-parse', 'arima-state');
    put(repo, 'notes.txt', `token ghp_${'z'.repeat(30)}\n`);
    await expect(pushState({ projectDir: repo, runId: RUN2 })).rejects.toThrow(/secret/);
    expect(git(repo, 'rev-parse', 'arima-state')).toBe(before);
    expect(git(path.join(repo, '.arima'), 'diff', '--cached', '--name-only')).toBe('');
  });

  it('refuses to use the default branch as the state branch', async () => {
    const { repo } = appRepo();
    await expect(
      pushState({ projectDir: repo, runId: RUN1, branch: 'main' }),
    ).rejects.toBeInstanceOf(StateError);
    await expect(
      pullState({ projectDir: repo, branch: 'trunk', defaultBranch: 'trunk' }),
    ).rejects.toThrow(/never touches/);
  });

  it('refuses a plain .arima/ with files when the branch already exists elsewhere', async () => {
    const { repo, remote } = appRepo(true);
    put(repo, 'events.jsonl', 'a\n');
    await pushState({ projectDir: repo, runId: RUN1 });
    const other = cloneOf(remote as string);
    put(other, 'precious.txt', 'keep me\n');
    await expect(pullState({ projectDir: other })).rejects.toThrow(/already has files/);
    expect(readFileSync(path.join(other, '.arima', 'precious.txt'), 'utf8')).toBe('keep me\n');
  });

  it('is not a git repo -> clear error', async () => {
    await expect(pullState({ projectDir: tempDir() })).rejects.toThrow(
      /not a git repository|not the root/,
    );
  });

  it('works with no git identity configured', async () => {
    const { repo } = appRepo();
    git(repo, 'config', '--unset', 'user.name');
    git(repo, 'config', '--unset', 'user.email');
    put(repo, 'events.jsonl', 'a\n');
    await expect(pushState({ projectDir: repo, runId: RUN1 })).resolves.toMatchObject({
      committed: true,
    });
  });
});

describe('arima-state CLI', () => {
  const cli = async (argv: string[], cwd: string) => {
    let out = '';
    let err = '';
    const code = await runStateCli(argv, { out: (s) => (out += s), err: (s) => (err += s), cwd });
    return { code, out, err };
  };

  it('push then pull end to end', async () => {
    const { repo } = appRepo();
    put(repo, 'events.jsonl', 'a\n');
    expect((await cli(['push', '--run-id', RUN1], repo)).out).toContain('state committed');
    expect((await cli(['pull'], repo)).code).toBe(0);
    expect((await cli(['status'], repo)).out).toContain('"worktree":true');
  });

  it('usage errors exit 2, git errors exit 1', async () => {
    const { repo } = appRepo();
    expect((await cli([], repo)).code).toBe(2);
    expect((await cli(['push'], repo)).code).toBe(2);
    expect((await cli(['pull'], tempDir())).code).toBe(1);
  });

  it('reads the state branch name from arima.yaml', async () => {
    const { repo } = appRepo();
    writeFileSync(
      path.join(repo, 'arima.yaml'),
      'github:\n  state_branch: custom-state\n  default_branch: main\n',
    );
    put(repo, 'events.jsonl', 'a\n');
    await cli(['push', '--run-id', RUN1], repo);
    expect(git(repo, 'branch', '--list', 'custom-state')).toContain('custom-state');
  });
});
