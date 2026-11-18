// Stage 0A: the state branch holds the Notion mirror, so it must only go to a private repo.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateError, githubSlug, pushState } from '../src/state.js';
import { tempDir } from './helpers.js';

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** An app repo whose `origin` LOOKS like a GitHub repo but is redirected to a local bare repo. */
function appWithGithubOrigin(url = 'https://github.com/acme/app.git'): {
  dir: string;
  bare: string;
} {
  const bare = tempDir('arima-bare-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const dir = tempDir('arima-app-');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.name', 'T'],
    ['user.email', 't@example.com'],
    ['core.autocrlf', 'false'],
  ] as const)
    git(dir, 'config', k, v);
  writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', url);
  git(dir, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, url);
  writeFileSync(path.join(dir, '.arima-test'), '');
  return { dir, bare };
}
const put = (dir: string): void => {
  const file = path.join(dir, '.arima', 'events.jsonl');
  execFileSync(process.execPath, [
    '-e',
    `require('fs').mkdirSync(require('path').dirname(${JSON.stringify(file)}),{recursive:true});require('fs').writeFileSync(${JSON.stringify(file)},'{}\\n')`,
  ]);
};
const RUN = 'r-20261118-0200-01';
const hasState = (bare: string): boolean => {
  try {
    git(bare, 'rev-parse', '--verify', 'refs/heads/arima-state');
    return true;
  } catch {
    return false;
  }
};

describe('githubSlug', () => {
  it.each([
    ['https://github.com/acme/app.git', 'acme', 'app'],
    ['https://github.com/acme/app', 'acme', 'app'],
    ['https://user:tok@github.com/acme/app.git', 'acme', 'app'],
    ['git@github.com:acme/app.git', 'acme', 'app'],
    ['ssh://git@github.com/acme/app.git', 'acme', 'app'],
    ['https://github.com/acme/my.app.git', 'acme', 'my.app'],
  ])('parses %s', (url, owner, repo) => {
    expect(githubSlug(url)).toEqual({ owner, repo });
  });

  it.each([
    '/tmp/bare.git',
    'C:/repos/bare.git',
    'https://gitlab.com/acme/app.git',
    'git@bitbucket.org:acme/app.git',
    '',
  ])('ignores %s', (url) => {
    expect(githubSlug(url)).toBeUndefined();
  });
});

describe('pushState and repository privacy', () => {
  it('refuses to push to a PUBLIC GitHub repository, leaving the remote untouched', async () => {
    const { dir, bare } = appWithGithubOrigin();
    put(dir);
    await expect(
      pushState({ projectDir: dir, runId: RUN, isPrivate: () => false }),
    ).rejects.toThrow(/PUBLIC GitHub repository/);
    await expect(
      pushState({ projectDir: dir, runId: RUN, isPrivate: () => false }),
    ).rejects.toBeInstanceOf(StateError);
    expect(hasState(bare)).toBe(false);
  });

  it('pushes to a private repository', async () => {
    const { dir, bare } = appWithGithubOrigin();
    put(dir);
    const r = await pushState({ projectDir: dir, runId: RUN, isPrivate: () => true });
    expect(r).toMatchObject({ committed: true, pushed: true, warnings: [] });
    expect(hasState(bare)).toBe(true);
  });

  it('pushes to a public repository only when the owner explicitly allows it', async () => {
    const { dir, bare } = appWithGithubOrigin();
    put(dir);
    const r = await pushState({
      projectDir: dir,
      runId: RUN,
      isPrivate: () => false,
      allowPublic: true,
    });
    expect(r.pushed).toBe(true);
    expect(hasState(bare)).toBe(true);
  });

  it('pushes but warns when privacy cannot be checked', async () => {
    const { dir, bare } = appWithGithubOrigin();
    put(dir);
    const r = await pushState({ projectDir: dir, runId: RUN, isPrivate: () => undefined });
    expect(r.pushed).toBe(true);
    expect(r.warnings[0]).toMatch(/could not check whether acme\/app is private/);
    expect(hasState(bare)).toBe(true);
  });

  it('does not ask about non-GitHub remotes', async () => {
    const { dir, bare } = appWithGithubOrigin('https://git.example.com/acme/app.git');
    put(dir);
    let asked = false;
    const r = await pushState({
      projectDir: dir,
      runId: RUN,
      isPrivate: () => ((asked = true), false),
    });
    expect(asked).toBe(false);
    expect(r.pushed).toBe(true);
    expect(hasState(bare)).toBe(true);
  });
});
