// WP-211 step 3 (envelope): the QA tool list equals the card's, reads are path-scoped, and every way of
// reaching the developer's source, notes, ARIMA state or git history is tried. Deny rules and the guard are two layers.
import { describe, expect, it } from 'vitest';
import { guardBash, guardTool } from '../src/hooks.js';
import { QA_READS, ROLES, allowedTools, deniedTools } from '../src/roles.js';

const allowed = allowedTools('qa', '/p/scripts/dist');
const ctx = { role: 'qa', kind: 'qa', defaultBranch: 'main', cwd: '/work/app-wt/qa/US-112-tests' };

describe('qa allow-list (card section 6, S17)', () => {
  it('reads only the scoped paths, writes only tests/, runs the app scripts', () => {
    for (const t of [
      'Read(./tests/**)',
      'Read(./api/**)',
      'Read(./design/**)',
      'Read(./package.json)',
      'Write(./tests/**)',
      'Edit(./tests/**)',
      'Bash(npm run *)',
      'Bash(npm test)',
      'Bash(npm ci)',
    ])
      expect(allowed, t).toContain(t);
    expect(allowed).not.toContain('Read');
    expect(QA_READS.length).toBe(7);
  });

  it('has no git, gh, npx, outbox, web, MCP, docker or host script', () => {
    expect(
      allowed.filter((t) => /git|\bgh\b|npx|outbox|WebFetch|mcp__|docker|\.mjs/i.test(t)),
    ).toEqual([]);
  });

  it('src, .arima, docs, .github and .git are denied for reading', () => {
    const d = deniedTools('qa');
    for (const t of [
      'Read(./src/**)',
      'Read(./.arima/**)',
      'Read(./docs/**)',
      'Read(./.github/**)',
      'Read(./.git/**)',
    ])
      expect(d, t).toContain(t);
    for (const r of ROLES.filter((x) => x !== 'qa'))
      expect(deniedTools(r), r).not.toContain('Read(./src/**)');
  });

  it('only qa and devops-free roles keep their lists: no other role gained or lost QA paths', () => {
    for (const r of ROLES.filter((x) => x !== 'qa'))
      expect(allowedTools(r, '/p/scripts/dist').some((t) => t.startsWith('Read(./tests'))).toBe(
        false,
      );
  });
});

describe('the guard in a QA run: the developer is out of sight', () => {
  const blockedFile: [string, Record<string, unknown>][] = [
    ['Read', { file_path: 'src/cart.js' }],
    ['Read', { file_path: '/work/app-wt/qa/US-112-tests/src/cart.js' }],
    ['Read', { file_path: 'docs/architecture/sad.md' }],
    ['Read', { file_path: '.arima/runs/r-20261121-0900-01.report.json' }],
    ['Read', { file_path: '.github/workflows/ci.yml' }],
    ['Read', { file_path: '.git/HEAD' }],
    ['Glob', { pattern: 'src/**/*.js' }],
    ['Glob', { pattern: '**/docs/**' }],
    ['Grep', { pattern: 'TODO', path: 'src' }],
    ['Grep', { pattern: 'x', glob: '.arima/**' }],
    ['Read', { file_path: '.ARIMA\\runs\\x.json' }],
  ];
  it.each(blockedFile)('file tool %s %j is blocked', (tool, input) => {
    expect(['qa-independence', 'protected-state']).toContain(guardTool(tool, input, ctx)?.rule);
  });

  it.each([
    ['Grep', { pattern: 'TODO' }],
    ['Grep', { pattern: 'x', path: '.' }],
    ['Grep', { pattern: 'x', glob: 'sr[c]/**' }],
    ['Glob', { pattern: '**/*.js' }],
    ['Glob', { pattern: 'sr[c]/**' }],
    ['Glob', { pattern: '{src,x}/**' }],
    ['Glob', { pattern: 's?c/**' }],
    ['Glob', { pattern: '**/*.js', path: '.' }],
    ['Grep', { pattern: 'x', path: 'tests/../src' }],
  ])('%s %j names no root under tests, api or design and is blocked', (tool, input) => {
    expect(guardTool(tool, input, ctx)?.rule).toBe('qa-independence');
  });
  it('Glob and Grep with a root under tests, api or design pass', () => {
    for (const [tool, input] of [
      ['Grep', { pattern: 'x', path: 'tests' }],
      ['Grep', { pattern: 'x', path: 'tests/e2e', glob: '*.js' }],
      ['Glob', { pattern: 'tests/**/*.js' }],
      ['Glob', { pattern: '**/*.js', path: 'api' }],
      ['Glob', { pattern: '*', path: '/work/app-wt/qa/US-112-tests/design' }],
    ] as const)
      expect(guardTool(tool, input, ctx), JSON.stringify(input)).toBeUndefined();
  });

  it('what QA is meant to read is fine', () => {
    for (const p of [
      'tests/e2e/login.spec.js',
      'api/openapi.yaml',
      'design/screens/US-112/error.html',
      'package.json',
    ])
      expect(guardTool('Read', { file_path: p }, ctx), p).toBeUndefined();
    expect(
      guardTool('Write', { file_path: 'tests/e2e/a.spec.js', content: 'x' }, ctx),
    ).toBeUndefined();
    expect(guardTool('Grep', { pattern: 'login', path: 'tests' }, ctx)).toBeUndefined();
  });

  const blockedCmd: [string, string][] = [
    ['cat src/cart.js', 'qa-independence'],
    ['grep -rn cart ./src', 'qa-independence'],
    ["cat s''rc/a.js", 'qa-independence'],
    ['cat .arima/runs/x.json', 'qa-independence'],
    ['cat docs/notes.md', 'qa-independence'],
    ['git log -p', 'qa-independence'],
    ['git show HEAD', 'qa-independence'],
    ['git diff', 'qa-independence'],
    ['git push origin qa/US-112-tests', 'qa-independence'],
    ['gh pr view 3', 'vcs'],
    ['cat .env', 'secret-file'],
    ['docker ps', 'container'],
    ['npm test --prefix ../app', 'vcs'],
    ['npm test --node-options=--require=./tests/x.cjs', 'vcs'],
  ];
  it.each(blockedCmd)('%s is blocked (%s)', (cmd, rule) => {
    const hit = guardBash(cmd, ctx);
    expect(hit?.rule, cmd).toBe(rule);
  });

  it('npm run e2e and npm test pass the guard', () => {
    for (const cmd of ['npm run e2e', 'npm test', 'npm run e2e -- --grep login'])
      expect(guardBash(cmd, ctx), cmd).toBeUndefined();
  });

  it('a human may read src, and another role may read docs', () => {
    expect(guardBash('cat src/a.js', {})).toBeUndefined();
    expect(guardTool('Read', { file_path: 'docs/x.md' }, { role: 'architect' })).toBeUndefined();
  });
});

describe('the QA tree holds what the role and the agent file promise', () => {
  it('QA_SPARSE has the test, API, design and package files npm ci and the runner need', async () => {
    const { QA_SPARSE } = await import('../src/dispatch-units.js');
    for (const p of [
      'tests/',
      'api/',
      'design/',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
    ])
      expect(QA_SPARSE, p).toContain(p);
    expect([...QA_SPARSE].some((p) => p.startsWith('playwright.config'))).toBe(true);
    for (const p of QA_SPARSE)
      expect(p, 'QA never gets product source or docs').not.toMatch(/^(src|docs|\.arima|\.github)/);
  });
});
