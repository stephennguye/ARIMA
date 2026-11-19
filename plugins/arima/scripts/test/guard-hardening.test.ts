// Stage 0A, second pass (judge #2): everything the first pass missed.
//  - the launcher is EXECUTED (not just read) for every way the guard can fail to run
//  - the judge's bypass corpus, and a role-allow-list x guard matrix
//  - scanner false positives and the human allowlist
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canon,
  guardBash,
  guardTool,
  isProtectedConfigPath,
  isProtectedStatePath,
  isSecretPath,
} from '../src/hooks.js';
import { entropy, findSecrets, parseAllowlist, scanSecrets } from '../src/lib/secrets.js';
import { ROLES, allowedTools } from '../src/roles.js';
import { StateError, pushState, remotePauseFlag } from '../src/state.js';
import { EXAMPLES, PLUGIN_ROOT, project, tempDir } from './helpers.js';

// ------------------------------------------------------------------ launcher, executed for real

function findSh(): string | undefined {
  const works = (sh: string): boolean =>
    spawnSync(sh, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
  if (works('sh')) return 'sh';
  for (const c of ['C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe'])
    if (existsSync(c) && works(c)) return c;
  return undefined;
}
const SH = findSh();
const GUARD = path.join(PLUGIN_ROOT, 'hooks', 'guard.sh');

/** A PATH with no Node on it (but with the shell's own tools), or undefined if Node cannot be hidden. */
function pathWithoutNode(): string | undefined {
  const dirs = [path.dirname(SH ?? ''), 'C:/Program Files/Git/usr/bin', '/usr/bin', '/bin'].filter(
    (d) => d !== '.' && existsSync(d),
  );
  const p = dirs.join(path.delimiter);
  const r = spawnSync(SH ?? 'sh', ['-c', 'command -v node'], {
    env: { PATH: p },
    encoding: 'utf8',
  });
  return r.status === 0 ? undefined : p;
}

function runGuard(cwd: string, payload: object, env: Record<string, string>) {
  const t0 = Date.now();
  const r = spawnSync(SH as string, [GUARD, 'pre-tool-use'], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
  return { status: r.status, stderr: r.stderr, ms: Date.now() - t0 };
}

describe.skipIf(SH === undefined)('guard.sh launcher, executed', { timeout: 40_000 }, () => {
  const read = (cwd: string, file: string) => ({
    tool_name: 'Read',
    tool_input: { file_path: path.join(cwd, file) },
    cwd,
  });
  const root = { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };

  it('inside a project it blocks a secret read and allows an ordinary one, through the real bundle', () => {
    const dir = project();
    const blocked = runGuard(dir, read(dir, '.env'), root);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('secret-file');
    expect(runGuard(dir, read(dir, 'notes.txt'), root).status).toBe(0);
  });

  it('inside a project, a missing bundle blocks (exit 2); outside a project it does nothing (exit 0)', () => {
    const emptyRoot = { CLAUDE_PLUGIN_ROOT: tempDir('arima-noroot-') };
    const dir = project();
    const inside = runGuard(dir, read(dir, 'notes.txt'), emptyRoot);
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain('failed unexpectedly');
    const outside = tempDir();
    expect(runGuard(outside, read(outside, 'notes.txt'), emptyRoot).status).toBe(0);
  });

  it('inside a project, a guard that crashes with any other exit code blocks; outside it does not', () => {
    const fake = tempDir('arima-crashroot-');
    mkdirSync(path.join(fake, 'scripts', 'dist'), { recursive: true });
    writeFileSync(path.join(fake, 'scripts', 'dist', 'arima-hook.mjs'), 'process.exit(7);\n');
    const dir = project();
    expect(runGuard(dir, read(dir, 'a.txt'), { CLAUDE_PLUGIN_ROOT: fake }).status).toBe(2);
    const outside = tempDir();
    expect(runGuard(outside, read(outside, 'a.txt'), { CLAUDE_PLUGIN_ROOT: fake }).status).toBe(0);
  });

  const noNode = pathWithoutNode();
  it.skipIf(noNode === undefined)(
    'with Node missing: blocks inside a project, and does NOT lock the user out elsewhere',
    () => {
      const dir = project();
      const inside = runGuard(dir, read(dir, 'a.txt'), { ...root, PATH: noNode as string });
      expect(inside.status).toBe(2);
      expect(inside.stderr).toContain('Node.js was not found');
      const outside = tempDir();
      expect(
        runGuard(outside, read(outside, 'a.txt'), { ...root, PATH: noNode as string }).status,
      ).toBe(0);
    },
  );

  it('a held event-log lock cannot turn a block into an allow by making the hook time out (limit is 10 s)', () => {
    const dir = project();
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(path.join(dir, '.arima', 'events.jsonl.lock'), `${process.pid}\n`);
    const r = runGuard(
      dir,
      { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: dir },
      root,
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('vcs');
    expect(r.ms).toBeLessThan(7000);
  });
});

// ------------------------------------------------------------------ the judge's bypass corpus

const DEV = { role: 'developer' as const, defaultBranch: 'main' };

/** Commands that must never run in an agent session. Each must be blocked by the guard OR not allowed by the role. */
const DANGEROUS: string[] = [
  // push / merge
  "git push origin 'ma''in'",
  'git push origin $(echo main)',
  'git push origin ${B}',
  'B=main; git push origin $B',
  'git checkout main && git push origin HEAD',
  'git push origin HEAD',
  'echo hi\ngit push origin main',
  'echo $(git push origin main)',
  'echo `git push origin main`',
  'git push -fu origin feat/x',
  'git push --force-if-includes origin feat/x',
  'git push --receive-pack=/bin/sh origin feat/x',
  'git push origin "refs/heads/*:refs/heads/*"',
  'git push origin feat/x:main',
  'git push origin main:feat/x',
  'git push origin Main',
  'git push --tags origin',
  'git push origin :feat/x',
  'env git push origin main',
  'command git push origin main',
  'bash -c "git push origin main"',
  "sh -c 'gh pr merge 1'",
  'cmd /c git push origin main',
  'eval "git push origin main"',
  'FOO=1 git push origin main',
  '/usr/bin/git push origin main',
  'git.exe push origin main',
  'git commit -nm x',
  'git commit --no-verify -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git -c alias.p=push p origin main',
  'git diff --output=.arima/ledger.jsonl',
  'git log --output=.arima/events.jsonl',
  'git config core.hooksPath /dev/null',
  'git config remote.origin.push HEAD:main',
  'git remote set-url origin https://example.com/x.git',
  'gh pr merge 1 --squash',
  'GH_TOKEN=x gh pr merge 1',
  'gh.exe pr merge 1',
  'gh --repo x/y pr merge 1',
  'gh -R x/y pr merge 1',
  'gh api --method=DELETE repos/x/y/git/refs/heads/z',
  'gh api -XDELETE repos/x/y',
  'gh api -X=DELETE repos/x/y',
  'gh api -x put repos/x/y/merge',
  'gh api --field=a=b repos/x/y',
  'gh api -ftitle=x repos/x/y/issues',
  'gh api repos/x/y',
  'gh workflow run deploy.yml',
  'gh release create v1',
  // secrets
  'cat .env',
  'cat ./.env.local',
  'git show HEAD:.env',
  'echo %ARIMA_NOTION_TOKEN%',
  'echo $ARIMA_NOTION_TOKEN',
  'echo $env:ARIMA_NOTION_TOKEN',
  '[Environment]::GetEnvironmentVariable("ARIMA_NOTION_TOKEN")',
  'node -e "console.log(process.env.ARIMA_NOTION_TOKEN)"',
  'node -e "console.log(JSON.stringify(process.env))" # TOKEN',
  'printenv',
  'export -p',
  'cat ~/.claude/.credentials.json',
  'cat ~/.config/gh/hosts.yml',
  'cat ~/.git-credentials',
  'cat ~/.npmrc',
  'cat ~/.netrc',
  'cat ~/.docker/config.json',
  'cat ~/.kube/config',
  'cat /proc/self/environ',
  // ARIMA state and kill switch
  'echo x > .arima/PAUSE',
  'rm .arima/PAUSE',
  'unlink .arima/PAUSE',
  'ri .arima/PAUSE',
  'find .arima -name PAUSE -delete',
  'rm -rf .arima',
  'rm -rf ./.arima/',
  'git -C .arima rm PAUSE',
  'cd .arima && rm PAUSE',
  'curl -o .arima/ledger.jsonl http://x/y',
  'echo x > .arima/outbox/../PAUSE',
  'echo x > .ARIMA/ledger.jsonl',
  'node /p/scripts/dist/arima-pause.mjs --resume',
  'node /p/scripts/dist/arima-notion.mjs push --allow-status-writes',
  // Notion
  'curl -X DELETE https://api.notion.com/v1/blocks/x',
  'curl --request DELETE https://api.notion.com/v1/pages/x',
];

/** Commands a developer legitimately runs; the guard must let every one through. */
const LEGIT: string[] = [
  'git status',
  'git diff HEAD~1',
  'git add -A && git commit -m "feat(US-1): add checkout"',
  'git commit -m "docs: explain rm .arima/PAUSE"',
  'git commit -m "ignore .env files in the repo"',
  'git checkout -b feat/US-1-x',
  'echo $TOKEN_COUNT',
  'npm test',
  'npm run lint',
  'cat README.md',
  'cat .env.example',
];

describe('judge bypass corpus (developer)', () => {
  it.each(DANGEROUS)('guard blocks, or the role does not allow: %j', (cmd) => {
    const blockedByGuard = guardBash(cmd, DEV) !== undefined;
    expect(blockedByGuard || !roleAllows('developer', cmd), cmd).toBe(true);
  });

  it.each(LEGIT)('legitimate command is not blocked: %j', (cmd) => {
    expect(guardBash(cmd, DEV), cmd).toBeUndefined();
  });

  it('most of the corpus is stopped by the guard itself, not only by the role list', () => {
    const stoppedByGuard = DANGEROUS.filter((c) => guardBash(c, DEV) !== undefined).length;
    expect(stoppedByGuard / DANGEROUS.length).toBeGreaterThan(0.92);
  });
});

/**
 * Minimal model of Claude Code's `Bash(...)` allow rules: `*` is a wildcard; a compound command
 * (&&, ||, ;, |, newline) is allowed only if every part matches some rule. Anything with $( or a
 * backtick is judged on its first part only, the worst case for us.
 */
function roleAllows(role: (typeof ROLES)[number], command: string): boolean {
  const rules = allowedTools(role, '/p/scripts/dist')
    .filter((t) => t.startsWith('Bash('))
    .map((t) => t.slice(5, -1));
  const toRe = (g: string): RegExp =>
    new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const parts = command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const judged = /\$\(|`/.test(command) ? parts.slice(0, 1) : parts;
  return judged.length > 0 && judged.every((p) => rules.some((r) => toRe(r).test(p)));
}

describe('role allow-list x guard matrix', () => {
  it.each(ROLES)(
    '%s: nothing in the dangerous corpus is both allowed by its role and passed by the guard',
    (role) => {
      const holes = DANGEROUS.filter(
        (cmd) =>
          roleAllows(role, cmd) && guardBash(cmd, { role, defaultBranch: 'main' }) === undefined,
      );
      expect(holes).toEqual([]);
    },
  );

  it('the matrix model itself behaves (sanity)', () => {
    expect(roleAllows('developer', 'git push origin main')).toBe(false); // no role pushes (D-49)
    expect(guardBash('git push origin main', DEV)).toBeDefined(); // and the guard says so too
    expect(roleAllows('qa', 'git push origin main')).toBe(false);
    expect(roleAllows('developer', 'git status && git push origin main')).toBe(false);
    expect(roleAllows('developer', 'git status && git diff')).toBe(true);
    expect(roleAllows('developer', 'rm -rf /')).toBe(false);
  });

  it('no role has an unrestricted npx; only qa may run playwright through it', () => {
    for (const role of ROLES) {
      const npx = allowedTools(role, '/p').filter((t) => t.includes('npx'));
      expect(npx, role).toEqual(
        role === 'qa' ? ['Bash(npx playwright)', 'Bash(npx playwright *)'] : [],
      );
    }
  });
});

describe('guard: file tools and paths', () => {
  const blocked = (
    tool: string,
    input: Record<string, unknown>,
    ctx: { role?: string; defaultBranch?: string } = DEV,
  ) => guardTool(tool, input, ctx)?.rule;

  it.each([
    '.arima/outbox/../PAUSE',
    '.arima/outbox/../ledger.jsonl',
    '.ARIMA/PAUSE',
    '.ARIMA/ledger.jsonl',
    '.arima/PAUSE::$DATA',
    '.arima/PAUSE.',
    '.arima/events.jsonl.lock',
    '.arima/ledger.jsonl.lock',
    '.arima/alerts.json',
    '.arima/.gitignore',
    '.arima/state/ids.json',
    'C:\\app\\.Arima\\Mirror\\stories.json',
  ])('an agent cannot write %s', (p) => {
    expect(blocked('Write', { file_path: p, content: 'x' }), p).toBe('protected-state');
  });

  it('but may write its own outbox proposals', () => {
    expect(
      blocked('Write', { file_path: '.arima/outbox/e-1.json', content: '{}' }),
    ).toBeUndefined();
    expect(blocked('Write', { file_path: '.arima/outbox/sub/e-1.json', content: '{}' })).toBe(
      'protected-state',
    );
  });

  it.each([
    'ARIMA.yaml',
    'Team.YAML',
    '.GITHUB/workflows/ci.yml',
    '.git/config',
    '.git/hooks/pre-commit',
    '.husky/pre-commit',
    '.mcp.json',
    'CLAUDE.md',
    'sub/dir/../../arima.yaml',
  ])('a developer cannot write %s', (p) => {
    expect(blocked('Write', { file_path: p, content: 'x' }), p).toBe('protected-config');
  });

  it('devops may write .github/, nobody else; package.json and source stay writable for a developer', () => {
    expect(
      blocked(
        'Write',
        { file_path: '.github/workflows/ci.yml', content: 'x' },
        { role: 'devops', defaultBranch: 'main' },
      ),
    ).toBeUndefined();
    expect(blocked('Write', { file_path: 'package.json', content: '{}' })).toBeUndefined();
    expect(blocked('Write', { file_path: 'src/index.ts', content: 'x' })).toBeUndefined();
  });

  it.each([
    '~/.claude/.credentials.json',
    'C:\\Users\\x\\.claude\\.credentials.json',
    '/home/u/.config/gh/hosts.yml',
    '/home/u/.npmrc',
    '/home/u/.git-credentials',
    '/home/u/.netrc',
    '/home/u/.docker/config.json',
    '/home/u/.kube/config',
    '/proc/self/environ',
    '/home/u/.ssh/id_ed25519',
    '/home/u/.aws/credentials',
    '.ENV',
    '.env.production.',
  ])('nobody reads %s', (p) => {
    expect(blocked('Read', { file_path: p }, {}), p).toBe('secret-file');
  });

  it('Grep and Glob patterns that reach secret files are blocked', () => {
    expect(blocked('Grep', { pattern: '.', path: '.', glob: '.env*' }, {})).toBe('secret-file');
    expect(blocked('Glob', { pattern: '**/.env' }, {})).toBe('secret-file');
    expect(blocked('Glob', { pattern: '**/*.pem' }, {})).toBe('secret-file');
    expect(blocked('Glob', { pattern: 'src/**/*.ts' }, {})).toBeUndefined();
    expect(blocked('Grep', { pattern: 'TODO', path: 'src', glob: '*.ts' }, {})).toBeUndefined();
  });

  it('canon resolves traversal, case, alternate streams and trailing dots', () => {
    expect(canon('A/B/../C.')).toBe('a/c');
    expect(canon('.arima\\PAUSE::$DATA')).toBe('.arima/pause');
    expect(isProtectedStatePath('x/.arima/outbox/../PAUSE')).toBe(true);
    expect(isSecretPath('Config/.ENV.Local')).toBe(true);
    expect(isProtectedConfigPath('a/.Github/x.yml', 'qa')).toBe(true);
  });
});

// ------------------------------------------------------------------ scanner

describe('secret scanner: fewer false alarms, still catches real shapes', () => {
  it('does not flag the realistic prose and code the judge tried', () => {
    for (const text of [
      'token: this-is-a-very-long-description-of-things',
      'const token = process.env.ARIMA_NOTION_TOKEN_VALUE_FROM_ENV;',
      'const secretKey = getSecretKeyFromVaultService(config.vaultPath)',
      'API_KEY=your-api-key-goes-here-replace-me-please',
      'private_key: path/to/service-account-key-file-in-secret-store',
      'access_token: eyJ_placeholder_value_see_docs_section_4_2',
      'the AWS docs use AKIAIOSFODNN7EXAMPLE as a sample key',
      'the format is sk-ant-api-key-format-is-documented-here-for-reference',
      'Authorization: Bearer <your-token-here>',
      'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'id: 123e4567-e89b-12d3-a456-426614174000',
    ]) {
      expect(findSecrets(text), text).toEqual([]);
    }
  });

  it.each([
    ['aws access key', 'AKIA' + 'Q7XK2M9PLR4VTW8N'],
    ['anthropic key', 'sk-ant-api03-' + 'Zk3pQ9vXw2LmN8aR5tY7uB1cD4eF6gH0jK2nM4pQ6rS8tV'],
    ['credential assignment', 'password: "Zk3pQ9vXw2LmN8aR5tY7"'],
    ['credential assignment', 'API_KEY=Zk3pQ9vXw2LmN8aR5tY7uB1c'],
    ['bearer token', 'Bearer Zk3pQ9vXw2LmN8aR5tY7uB1cD4eF6gH0'],
  ])('still catches %s', (rule, text) => {
    expect(findSecrets(`config: ${text} end`)).toContain(rule);
  });

  it('entropy separates random strings from prose', () => {
    expect(entropy('aaaaaaaaaaaa')).toBe(0);
    expect(entropy('Zk3pQ9vXw2LmN8aR5tY7')).toBeGreaterThan(4);
    expect(entropy('this-is-a-description')).toBeLessThan(3.6);
  });

  it('a human-reviewed fingerprint is allowed; the rest are still reported', () => {
    const text = 'password: "Zk3pQ9vXw2LmN8aR5tY7" and token: Qw8eR3tY6uI1oP4aS7dF';
    const found = scanSecrets(text);
    expect(found.length).toBeGreaterThanOrEqual(2);
    const allowed = parseAllowlist(`# reviewed\n${found[0]?.fingerprint}  # not a secret\n`);
    expect(scanSecrets(text, allowed).length).toBe(found.length - 1);
  });

  it('parseAllowlist ignores comments and malformed lines', () => {
    expect(parseAllowlist('# x\nsha256:0123456789abcdef\nnonsense\nsha256:short')).toEqual(
      new Set(['sha256:0123456789abcdef']),
    );
  });
});

describe('state push: a false alarm can be allowed by a human, and the refusal explains how', () => {
  function repo(): string {
    const dir = tempDir('arima-app-');
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'T');
    g('config', 'user.email', 't@example.com');
    g('config', 'core.autocrlf', 'false');
    writeFileSync(path.join(dir, 'README.md'), '# x\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
    copyFileSync(path.join(EXAMPLES, 'arima.yaml'), path.join(dir, 'arima.yaml'));
    return dir;
  }
  const RUN = 'r-20261118-0200-01';

  it('refuses with rule and fingerprint, then succeeds once the fingerprint is allowlisted', async () => {
    const dir = repo();
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(path.join(dir, '.arima', 'notes.md'), 'password: "Zk3pQ9vXw2LmN8aR5tY7"\n');
    let message = '';
    try {
      await pushState({ projectDir: dir, runId: RUN });
    } catch (e) {
      expect(e).toBeInstanceOf(StateError);
      message = (e as Error).message;
    }
    expect(message).toContain('notes.md: credential assignment (sha256:');
    expect(message).toContain('secret-allowlist.txt');
    const fp = /\(sha256:[0-9a-f]{16}\)/.exec(message)?.[0]?.slice(1, -1) as string;
    writeFileSync(path.join(dir, '.arima', 'secret-allowlist.txt'), `${fp}\n`);
    const ok = await pushState({ projectDir: dir, runId: RUN });
    expect(ok.committed).toBe(true);
  });
});

// ------------------------------------------------------------------ kill-switch propagation

describe('remotePauseFlag fails open only to "unknown", never to "no pause"', () => {
  it('a fetch that fails for any reason other than "no such branch" is undefined, not false', () => {
    const dir = tempDir('arima-app-');
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'T');
    g('config', 'user.email', 't@example.com');
    writeFileSync(path.join(dir, 'a'), 'a');
    g('add', '-A');
    g('commit', '-q', '-m', 'i');
    g('remote', 'add', 'origin', path.join(tempDir('arima-missing-'), 'does-not-exist.git'));
    expect(remotePauseFlag({ projectDir: dir })).toBeUndefined();
  });
});

describe('the Status opt-in flag cannot be hidden by quoting (judge #3)', () => {
  it.each([
    'node /p/scripts/dist/arima-notion.mjs push --allow-status-writes',
    `node /p/scripts/dist/arima-notion.mjs push --allow-status-"writes"`,
    `node /p/scripts/dist/arima-notion.mjs push --allow-status-w''rites`,
    `node /p/scripts/dist/arima-notion.mjs push --allow-s"tatus-writes"`,
  ])('blocks %s for a role', (cmd) => {
    expect(guardBash(cmd, { role: 'orchestrator', defaultBranch: 'main' })).toBeDefined();
  });
});
