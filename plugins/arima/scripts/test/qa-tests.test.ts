// WP-211: QA has no git, so the host commits QA's tests (only under tests/) and puts them on the story branch;
// the developer's publish check then counts only what the developer committed after QA's tip.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QaTestsError, adoptQaTests, qaTipOf } from '../src/qa-tests.js';
import { checkBranch } from '../src/publish.js';
import { createWorktree } from '../src/worktree.js';
import { tempDir } from './helpers.js';

const RUN = 'r-20261121-1000-01';
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(): string {
  const dir = path.join(tempDir('arima-qatests-'), 'app');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.name', 'T'],
    ['user.email', 't@example.com'],
    ['core.autocrlf', 'false'],
  ] as const)
    git(dir, 'config', k, v);
  writeFileSync(path.join(dir, 'package.json'), '{}\n');
  writeFileSync(path.join(dir, '.gitignore'), '.arima/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
async function qaTree(dir: string, files: Record<string, string>): Promise<string> {
  const c = await createWorktree({
    projectDir: dir,
    branch: 'qa/US-12-tests',
    base: 'main',
    runId: RUN,
  });
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(c.path, f)), { recursive: true });
    writeFileSync(path.join(c.path, f), t);
  }
  return c.path;
}
const opts = (dir: string) => ({
  projectDir: dir,
  item: 'US-12',
  qaBranch: 'qa/US-12-tests',
  storyBranch: 'feat/US-12-cart',
});

describe('adoptQaTests', () => {
  it("commits QA's files under tests/, creates the story branch at that commit and records the tip", async () => {
    const dir = repo();
    const wt = await qaTree(dir, { 'tests/e2e/cart.test.js': 'assert.equal(1, 1);\n' });
    const r = adoptQaTests(opts(dir));
    expect(r?.created).toBe(true);
    expect(git(dir, 'rev-parse', 'feat/US-12-cart')).toBe(r?.sha);
    expect(git(dir, 'rev-parse', 'HEAD', '--', '.').split('\n')[0]).toBeDefined();
    expect(git(wt, 'log', '-1', '--format=%s')).toBe(
      'test(US-12): end-to-end tests from the acceptance criteria',
    );
    expect(git(dir, 'show', 'feat/US-12-cart:tests/e2e/cart.test.js')).toContain('assert.equal');
    expect(qaTipOf(dir, 'US-12')).toBe(r?.sha);
    // no attribution of any kind in the commit
    expect(git(wt, 'log', '-1', '--format=%B')).not.toMatch(/Co-Authored|Claude|Generated/i);
  });

  it('refuses a file outside tests/ and commits nothing', async () => {
    const dir = repo();
    const wt = await qaTree(dir, { 'tests/e2e/a.test.js': 'x\n', 'src/leak.js': 'x\n' });
    expect(() => adoptQaTests(opts(dir))).toThrowError(/outside tests\/.*src\/leak\.js/);
    expect(git(wt, 'log', '--oneline').split('\n')).toHaveLength(1);
    expect(qaTipOf(dir, 'US-12')).toBeUndefined();
  });

  it('refuses tests that contain a secret, and unstages them', async () => {
    const dir = repo();
    const wt = await qaTree(dir, {
      'tests/e2e/a.test.js': 'const t = "ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";\n',
    });
    expect(() => adoptQaTests(opts(dir))).toThrowError(QaTestsError);
    expect(git(wt, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('moves an existing story branch forward only when it is a fast-forward', async () => {
    const dir = repo();
    git(dir, 'branch', 'feat/US-12-cart', 'main');
    await qaTree(dir, { 'tests/e2e/a.test.js': 'a\n' });
    expect(adoptQaTests(opts(dir))?.created).toBe(false);
    expect(git(dir, 'show', 'feat/US-12-cart:tests/e2e/a.test.js')).toBe('a');
    // The story branch gets work QA's branch does not have: no longer a fast-forward.
    const dev = path.join(path.dirname(dir), 'dev');
    git(dir, 'worktree', 'add', '-q', dev, 'feat/US-12-cart');
    writeFileSync(path.join(dev, 'dev.txt'), 'd\n');
    git(dev, 'add', '-A');
    git(
      dev,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'feat(US-12): d',
    );
    writeFileSync(
      path.join(dir, '..', 'app-wt', 'qa', 'US-12-tests', 'tests', 'e2e', 'b.test.js'),
      'b\n',
    );
    expect(() => adoptQaTests(opts(dir))).toThrowError(/not a fast-forward/);
  });

  it('with nothing written and no story branch there is nothing to adopt', async () => {
    const dir = repo();
    await qaTree(dir, {});
    expect(adoptQaTests(opts(dir))).toBeUndefined();
    expect(qaTipOf(dir, 'US-12')).toBeUndefined();
  });
});

describe("the developer publish check after QA's tests are on the branch", () => {
  async function story() {
    const dir = repo();
    await qaTree(dir, { 'tests/e2e/cart.test.js': 'assert.equal(1, 1);\n' });
    const adopted = adoptQaTests(opts(dir)) as { sha: string };
    const dev = await createWorktree({
      projectDir: dir,
      branch: 'feat/US-12-cart',
      base: 'main',
      runId: RUN,
      reuse: true,
    });
    writeFileSync(path.join(dev.path, 'cart.js'), 'export const a = 1;\n');
    git(dev.path, 'add', '-A');
    git(
      dev.path,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'feat(US-12): cart',
    );
    return { dir, dev: dev.path, tip: adopted.sha };
  }
  const input = (dir: string, extra: Record<string, unknown> = {}) => ({
    projectDir: dir,
    runId: RUN,
    branch: 'feat/US-12-cart',
    item: 'US-12',
    role: 'developer' as const,
    title: 't',
    body: 'b',
    repo: 'o/r',
    defaultBranch: 'main',
    ...extra,
  });

  it("counts QA's commits against the developer without the tip, and not with it", async () => {
    const s = await story();
    expect(() => checkBranch(input(s.dir))).toThrowError(/tests\/e2e/);
    expect(checkBranch(input(s.dir, { testsBase: s.tip })).files).toContain('cart.js');
  });

  it('still refuses a developer change to tests/e2e made after the tip', async () => {
    const s = await story();
    writeFileSync(path.join(s.dev, 'tests', 'e2e', 'cart.test.js'), 'weakened\n');
    git(s.dev, 'add', '-A');
    git(
      s.dev,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'fix(US-12): x',
    );
    expect(() => checkBranch(input(s.dir, { testsBase: s.tip }))).toThrowError(/tests\/e2e/);
  });

  it('a tip that is not in the branch changes nothing: every tests/e2e change counts', async () => {
    const s = await story();
    expect(() => checkBranch(input(s.dir, { testsBase: 'deadbeef'.repeat(5) }))).toThrowError(
      /tests\/e2e/,
    );
  });
});
