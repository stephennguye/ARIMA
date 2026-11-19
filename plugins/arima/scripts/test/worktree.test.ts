// WP-110: the worktree manager, on real temporary git repositories (spec 10.2, F08 5.1).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorktreeCli } from '../src/cli/worktree-cli.js';
import { pushState } from '../src/state.js';
import {
  WorktreeError,
  branchFor,
  createWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  slugify,
  worktreePath,
  worktreeRoot,
} from '../src/worktree.js';
import { tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** An app repo `<tmp>/app` with files, so its worktree folder `<tmp>/app-wt` is cleaned with <tmp>. */
function appRepo(): string {
  const parent = tempDir('arima-wt-');
  const repo = path.join(parent, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'core.longpaths', 'true');
  for (const [f, body] of Object.entries({
    'src/a.ts': 'export const a = 1;\n',
    'tests/e2e/x.spec.ts': 'test\n',
    'api/openapi.yaml': 'openapi: 3.1.0\n',
    'docs/notes.md': 'developer notes\n',
    'package.json': '{}\n',
  })) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const RUN = 'r-20261119-1200-01';
const make = (repo: string, branch = 'feat/US-112-cart', over: Record<string, unknown> = {}) =>
  createWorktree({ projectDir: repo, branch, base: 'main', runId: RUN, ...over });

describe('names', () => {
  it('slugify keeps ASCII words and at most 40 characters', () => {
    expect(slugify('Cart summary: show the total!')).toBe('cart-summary-show-the-total');
    expect(slugify('  --Über café-- ')).toBe('uber-cafe');
    expect(slugify('x'.repeat(100))).toHaveLength(40);
    expect(slugify('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
    expect(slugify('日本語')).toBe('');
  });
  it('branchFor maps the item type to a prefix', () => {
    expect(branchFor('US-112', 'Cart summary')).toBe('feat/US-112-cart-summary');
    expect(branchFor('BUG-45')).toBe('fix/BUG-45');
    expect(branchFor('INC-3', 'DB down')).toBe('hotfix/INC-3-db-down');
    expect(branchFor('MS-1')).toBe('chore/MS-1');
    expect(() => branchFor('story 4')).toThrow(WorktreeError);
  });
  it('the path is <repo>-wt/<branch>, nested', () => {
    const repo = path.join(path.resolve('/x'), 'app');
    expect(worktreeRoot(repo)).toBe(path.join(path.resolve('/x'), 'app-wt'));
    expect(worktreePath(repo, 'feat/US-1-a')).toBe(
      path.join(path.resolve('/x'), 'app-wt', 'feat', 'US-1-a'),
    );
  });
});

describe('createWorktree', () => {
  it('creates the branch and a clean worktree at the base commit, beside the project', async () => {
    const repo = appRepo();
    const c = await make(repo);
    expect(c.path).toBe(worktreePath(repo, 'feat/US-112-cart'));
    expect(existsSync(path.join(c.path, 'src', 'a.ts'))).toBe(true);
    expect(c.head).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(c.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/US-112-cart');
    expect(git(c.path, 'status', '--porcelain')).toBe('');
    expect(listWorktrees({ projectDir: repo }).map((w) => w.branch)).toEqual(['feat/US-112-cart']);
    const reg = JSON.parse(readFileSync(path.join(worktreeRoot(repo), 'registry.json'), 'utf8'));
    expect(reg).toMatchObject([{ branch: 'feat/US-112-cart', run_id: RUN, pid: process.pid }]);
  });

  it('starts from the base it is given, not from HEAD', async () => {
    const repo = appRepo();
    const first = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'later.txt'), 'x');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'later');
    const c = await make(repo, 'feat/US-1-old', { base: first });
    expect(c.head).toBe(first);
    expect(existsSync(path.join(c.path, 'later.txt'))).toBe(false);
  });

  it('STOPs when the branch or the path already exists, and changes nothing', async () => {
    const repo = appRepo();
    await make(repo);
    await expect(make(repo)).rejects.toThrow(/already exists; STOP/);
    git(repo, 'branch', 'feat/US-2-old');
    await expect(make(repo, 'feat/US-2-old')).rejects.toThrow(
      /branch feat\/US-2-old already exists/,
    );
    mkdirSync(worktreePath(repo, 'feat/US-3-x'), { recursive: true });
    await expect(make(repo, 'feat/US-3-x')).rejects.toThrow(/already exists; STOP/);
    expect(listWorktrees({ projectDir: repo })).toHaveLength(1);
    await expect(make(repo, 'feat/US-4-x', { base: 'no-such-ref' })).rejects.toThrow(WorktreeError);
    expect(git(repo, 'branch', '--list', 'feat/US-4-x')).toBe('');
  });

  it('refuses protected and odd branch names', async () => {
    const repo = appRepo();
    for (const b of [
      'main',
      'master',
      'arima-state',
      'evil',
      'feat/../x',
      'feat/a b',
      '-b',
      'feat/x.lock',
      'refs/heads/feat/x',
      '/feat/x',
    ])
      await expect(make(repo, b), b).rejects.toThrow(WorktreeError);
    await expect(make(repo, 'feat/x', { defaultBranch: 'feat/x' })).rejects.toThrow(/protected/);
    expect(listWorktrees({ projectDir: repo })).toEqual([]);
  });

  it('the .arima state worktree is not listed', async () => {
    const repo = appRepo();
    mkdirSync(path.join(repo, '.arima'), { recursive: true });
    writeFileSync(path.join(repo, '.arima', 'x.json'), '{}');
    await pushState({ projectDir: repo, runId: 'r-20261119-1200-02' });
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('.arima');
    await make(repo);
    expect(listWorktrees({ projectDir: repo }).map((w) => w.branch)).toEqual(['feat/US-112-cart']);
  });

  it('a deep path works (Windows long paths)', async () => {
    const repo = appRepo();
    const deep = Array.from({ length: 12 }, (_, i) => `directory-number-${i}-xxxxxxxx`).join('/');
    mkdirSync(path.join(repo, deep), { recursive: true });
    writeFileSync(path.join(repo, deep, 'file.txt'), 'deep');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'deep');
    const c = await make(repo, `feat/US-9-${'s'.repeat(40)}`);
    expect(readFileSync(path.join(c.path, ...deep.split('/'), 'file.txt'), 'utf8')).toBe('deep');
    expect(git(c.path, 'status', '--porcelain')).toBe('');
  });
});

describe('sparse worktree (QA: no product source)', () => {
  it('checks out only the listed paths; the rest is physically absent and the tree is clean', async () => {
    const repo = appRepo();
    const c = await make(repo, 'qa/US-112-tests', { sparse: ['tests/', 'api/', 'package.json'] });
    expect(existsSync(path.join(c.path, 'tests', 'e2e', 'x.spec.ts'))).toBe(true);
    expect(existsSync(path.join(c.path, 'api', 'openapi.yaml'))).toBe(true);
    expect(existsSync(path.join(c.path, 'package.json'))).toBe(true);
    expect(existsSync(path.join(c.path, 'src'))).toBe(false);
    expect(existsSync(path.join(c.path, 'docs'))).toBe(false);
    expect(git(c.path, 'status', '--porcelain')).toBe('');
    expect(c.head).toBe(git(repo, 'rev-parse', 'main'));
    // a test written here commits normally and the product tree is still absent
    writeFileSync(path.join(c.path, 'tests', 'e2e', 'new.spec.ts'), 'new');
    git(c.path, 'add', 'tests/e2e/new.spec.ts');
    git(c.path, '-c', 'user.name=T', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', 'test');
    expect(git(c.path, 'show', '--stat', '--format=', 'HEAD')).toContain('new.spec.ts');
    expect(existsSync(path.join(c.path, 'src'))).toBe(false);
  });

  it('rejects sparse paths that could escape or act as patterns', async () => {
    const repo = appRepo();
    for (const bad of ['../x', '/etc', 'src/*', '.git/', '-x', 'a\\b', '!src', 'a/../b', '#c'])
      await expect(make(repo, 'qa/US-1-t', { sparse: [bad] }), bad).rejects.toThrow(/sparse path/);
    expect(listWorktrees({ projectDir: repo })).toEqual([]);
    expect(git(repo, 'branch', '--list', 'qa/US-1-t')).toBe('');
  });
});

describe('removeWorktree', () => {
  it('removes the folder, the registration and (on request) the branch; the repo stays usable', async () => {
    const repo = appRepo();
    const c = await make(repo);
    writeFileSync(path.join(c.path, 'dirty.txt'), 'uncommitted');
    expect(await removeWorktree({ projectDir: repo, branch: c.branch })).toBe(true);
    expect(existsSync(c.path)).toBe(false);
    expect(listWorktrees({ projectDir: repo })).toEqual([]);
    expect(git(repo, 'branch', '--list', c.branch)).not.toBe(''); // branch kept
    expect(
      JSON.parse(readFileSync(path.join(worktreeRoot(repo), 'registry.json'), 'utf8')),
    ).toEqual([]);
    const again = await make(repo, c.branch).catch((e: Error) => e);
    expect(again).toBeInstanceOf(WorktreeError); // branch still exists: STOP
    const c2 = await make(repo, 'feat/US-5-x');
    await removeWorktree({ projectDir: repo, branch: c2.branch, deleteBranch: true });
    expect(git(repo, 'branch', '--list', c2.branch)).toBe('');
    expect((await make(repo, 'feat/US-5-x')).branch).toBe('feat/US-5-x'); // a fresh worktree for a retry
  });

  it('is safe to call twice or for a worktree that never existed', async () => {
    const repo = appRepo();
    expect(await removeWorktree({ projectDir: repo, branch: 'feat/US-7-none' })).toBe(true);
    const c = await make(repo);
    await removeWorktree({ projectDir: repo, branch: c.branch });
    expect(await removeWorktree({ projectDir: repo, branch: c.branch })).toBe(true);
  });

  it('kills a leftover process tree that is holding the worktree', async () => {
    const repo = appRepo();
    const c = await make(repo);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: c.path,
      stdio: 'ignore',
    });
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    expect(
      await removeWorktree({ projectDir: repo, branch: c.branch, pids: [child.pid as number] }),
    ).toBe(true);
    await Promise.race([
      exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error('child survived')), 10_000)),
    ]);
    expect(existsSync(c.path)).toBe(false);
  });

  it('never removes the main checkout, the state worktree or a protected branch', async () => {
    const repo = appRepo();
    await expect(removeWorktree({ projectDir: repo, branch: 'main' })).rejects.toThrow(/protected/);
    await expect(removeWorktree({ projectDir: repo, branch: 'arima-state' })).rejects.toThrow(
      /protected/,
    );
    expect(existsSync(path.join(repo, 'src', 'a.ts'))).toBe(true);
  });
});

describe('crash cleanup (pruneWorktrees)', () => {
  it('removes a worktree whose creating process is gone, keeps a live one, forgets a vanished one', async () => {
    const repo = appRepo();
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((r) => dead.on('exit', r));
    const crashed = await make(repo, 'feat/US-10-crashed', { pid: dead.pid as number });
    const live = await make(repo, 'feat/US-11-live');
    const gone = await make(repo, 'feat/US-12-gone', { pid: dead.pid as number });
    // the folder of the third vanished without git knowing
    execFileSync('git', ['worktree', 'remove', '--force', gone.path], { cwd: repo });

    const r = await pruneWorktrees({ projectDir: repo });
    expect(r.removed).toEqual([crashed.path]);
    expect(r.kept).toEqual([live.path]);
    expect(r.forgotten).toEqual([gone.path]);
    expect(existsSync(crashed.path)).toBe(false);
    expect(existsSync(live.path)).toBe(true);
    // the branch of a crashed run is kept: commits on it may be unpublished work
    expect(git(repo, 'branch', '--list', 'feat/US-10-crashed')).not.toBe('');
    expect(await pruneWorktrees({ projectDir: repo })).toEqual({
      removed: [],
      kept: [live.path],
      forgotten: [],
    });
  });

  it('an injected liveness check decides', async () => {
    const repo = appRepo();
    const c = await make(repo);
    expect((await pruneWorktrees({ projectDir: repo, isAlive: () => true })).kept).toEqual([
      c.path,
    ]);
    expect((await pruneWorktrees({ projectDir: repo, isAlive: () => false })).removed).toEqual([
      c.path,
    ]);
  });
});

describe('arima-worktree', () => {
  const run = async (
    argv: string[],
    cwd: string,
  ): Promise<{ code: number; out: string; err: string }> => {
    const r = { out: '', err: '' };
    const code = await runWorktreeCli(argv, {
      out: (s) => (r.out += s),
      err: (s) => (r.err += s),
      cwd,
    });
    return { code, ...r };
  };

  it('create, list, remove and prune, with exit codes 0, 1 and 2', async () => {
    const repo = appRepo();
    const created = await run(
      ['create', '--branch', 'feat/US-20-cli', '--base', 'main', '--run-id', RUN, '--json'],
      repo,
    );
    expect(created.code).toBe(0);
    expect(JSON.parse(created.out)).toMatchObject({ branch: 'feat/US-20-cli' });
    expect((await run(['list'], repo)).out).toContain('feat/US-20-cli');
    expect(JSON.parse((await run(['list', '--json'], repo)).out)).toHaveLength(1);

    const dup = await run(
      ['create', '--branch', 'feat/US-20-cli', '--base', 'main', '--run-id', RUN],
      repo,
    );
    expect(dup.code).toBe(1);
    expect(dup.err).toMatch(/already exists/);

    const sparse = await run(
      [
        'create',
        '--branch',
        'qa/US-20-t',
        '--base',
        'main',
        '--run-id',
        RUN,
        '--sparse',
        'tests/',
        '--sparse',
        'package.json',
      ],
      repo,
    );
    expect(sparse.code).toBe(0);
    expect(existsSync(path.join(worktreePath(repo, 'qa/US-20-t'), 'src'))).toBe(false);

    expect((await run(['prune'], repo)).out).toBe('removed 0, kept 2, forgotten 0\n');
    expect((await run(['remove', '--branch', 'feat/US-20-cli'], repo)).code).toBe(0);
    expect((await run(['remove', '--branch', 'main'], repo)).code).toBe(1);
  });

  it('usage errors exit 2', async () => {
    const repo = appRepo();
    expect((await run([], repo)).code).toBe(2);
    expect((await run(['create'], repo)).code).toBe(2);
    expect((await run(['create', '--branch', 'feat/US-1-x', '--base', 'main'], repo)).err).toMatch(
      /--run-id is required/,
    );
    expect((await run(['remove'], repo)).code).toBe(2);
    expect((await run(['list', '--nope'], repo)).code).toBe(2);
  });
});
