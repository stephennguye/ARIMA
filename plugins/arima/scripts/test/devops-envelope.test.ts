// WP-213 step 3 (envelope): the devops tool list equals the card's, and every forbidden action of the
// card has a test that tries it. Deny rules and the guard are two layers; both are checked.
import { describe, expect, it } from 'vitest';
import { guardBash, guardTool } from '../src/hooks.js';
import { OUTBOX_DATABASES, ROLES, allowedTools, deniedTools } from '../src/roles.js';

const DIR = '/p/scripts/dist';
const allowed = allowedTools('devops', DIR);
const ctx = { role: 'devops', defaultBranch: 'main' };

describe('devops allow-list (card section 6, as narrowed by WP-213)', () => {
  it('writes only infra, .github, docs/ops and the outbox; reads; read-only git; commits; no push', () => {
    for (const t of [
      'Read',
      'Write(./infra/**)',
      'Write(./.github/**)',
      'Write(./docs/ops/**)',
      'Write(./.arima/outbox/*.json)',
      'Bash(git commit *)',
      'Bash(git add *)',
      'Bash(git diff *)',
      'Bash(npm audit)',
      'Bash(npm sbom *)',
      'Bash(npm outdated)',
    ])
      expect(allowed, t).toContain(t);
    for (const t of [
      'Write',
      'Edit',
      'Bash',
      'Bash(git push *)',
      'Bash(npm run *)',
      'Bash(npm ci)',
    ])
      expect(allowed, t).not.toContain(t);
    expect(allowed.filter((t) => /^Bash\((git push|gh)\b/.test(t))).toEqual([]);
  });

  it('has no Docker command at all, and no GitHub command or credential (D-47, D-49)', () => {
    expect(allowed.filter((t) => /docker|podman|kubectl|compose/i.test(t))).toEqual([]);
    expect(allowed.filter((t) => /\bgh\b/.test(t))).toEqual([]);
  });

  it('may run arima-env check, and status/logs/smoke for staging and preview-* only', () => {
    const env = allowed.filter((t) => t.includes('arima-env.mjs'));
    expect(env.length).toBeGreaterThan(0);
    for (const t of env) {
      expect(t).toMatch(
        /arima-env\.mjs"? (check|(status|logs|smoke) (staging|preview-\*))( \*)?\)$/,
      );
      expect(t).not.toMatch(/backup|restore-test|production|\b(up|down)\b/);
    }
    for (const sub of ['status', 'logs', 'smoke'])
      expect(env.some((t) => t.includes(` ${sub} staging`))).toBe(true);
    // The agent file quotes the path, and a rule matches only the spelling it was written in.
    expect(env.some((t) => t.includes('arima-env.mjs" status staging'))).toBe(true);
    expect(env.some((t) => t.includes('mjs status staging'))).toBe(true);
  });

  it('grants every subcommand and target in both path spellings (a missing one denies the call)', () => {
    const want: string[] = ['check'];
    for (const sub of ['status', 'logs', 'smoke'])
      for (const target of ['staging', 'preview-*']) want.push(`${sub} ${target}`);
    for (const w of want) {
      const quoted = allowed.some((t) => t.includes(`arima-env.mjs" ${w}`));
      const plain = allowed.some((t) => t.includes(`arima-env.mjs ${w}`));
      expect({ w, quoted, plain }).toEqual({ w, quoted: true, plain: true });
    }
  });

  it('cannot run npm test, npm run or npm ci (they execute files a devops run can write)', () => {
    expect(allowed.filter((t) => /npm (test|run|ci|exec|start)/.test(t))).toEqual([]);
    expect(allowed.some((t) => t.includes('npm audit'))).toBe(true);
  });

  it('may propose bugs and lessons to the outbox, as the card says', () => {
    expect(OUTBOX_DATABASES.devops).toEqual(expect.arrayContaining(['bugs', 'lessons']));
  });

  it('no other role may run arima-env', () => {
    for (const r of ROLES.filter((x) => x !== 'devops'))
      expect(
        allowedTools(r, DIR).some((t) => t.includes('arima-env')),
        r,
      ).toBe(false);
  });

  it('denies docker, the host scripts and the production config folder to every role', () => {
    for (const r of ROLES) {
      const d = deniedTools(r);
      for (const t of [
        'Bash(docker *)',
        'Bash(docker compose *)',
        'Bash(kubectl *)',
        'Bash(node */arima-release.mjs *)',
        'Bash(node */arima-merge.mjs *)',
        'Bash(node */arima-publish.mjs *)',
        'Read(~/.config/arima/**)',
      ])
        expect(d, `${r}: ${t}`).toContain(t);
    }
  });
});

describe('the guard in a devops run: forbidden actions are blocked (card sections 6 and 7)', () => {
  const blocked: [string, string][] = [
    // docker in any form
    ['docker ps', 'container'],
    ['docker compose -p tas-production up -d', 'container'],
    ['docker compose up', 'container'],
    ['docker inspect tas-production-web-1', 'container'],
    ['docker run --privileged -v /:/host alpine', 'container'],
    ['docker run -v /var/run/docker.sock:/var/run/docker.sock alpine', 'container'],
    ['bash -c "docker rm -f x"', 'container'],
    ['FOO=1 docker.exe ps', 'container'],
    ['docker-compose down -v', 'container'],
    ['kubectl apply -f x.yaml', 'container'],
    // production through arima-env, in every spelling
    ['node /p/scripts/dist/arima-env.mjs up production', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs up Production', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs down tas-production', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs up staging --ref production', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs up', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs up "$ENVNAME"', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs up $(echo production)', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs up preview-0', 'production-barrier'],
    ['bash -c "node /p/scripts/dist/arima-env.mjs up production"', 'production-barrier'],
    // up and down are the host's: a run could deploy its own files or erase the failure record
    ['node /p/scripts/dist/arima-env.mjs up staging', 'host-script'],
    ['node /p/scripts/dist/arima-env.mjs up preview-12', 'host-script'],
    ['node /p/scripts/dist/arima-env.mjs down staging', 'host-script'],
    ['node /p/scripts/dist/arima-env.mjs down preview-3', 'host-script'],
    // npm options that load code
    ['npm audit --node-options=--require=./infra/x.cjs', 'vcs'],
    ['npm test --node-options=--require=./infra/x.cjs', 'vcs'],
    // host-run subcommands and scripts
    ['node /p/scripts/dist/arima-env.mjs backup staging', 'host-script'],
    ['node /p/scripts/dist/arima-env.mjs restore-test staging', 'host-script'],
    ['node /p/scripts/dist/arima-release.mjs deploy v1.0.0', 'host-script'],
    ['node /p/scripts/dist/arima-merge.mjs --pr 1', 'host-script'],
    ['node /p/scripts/dist/arima-publish.mjs push --branch x', 'host-script'],
    // found by the independent attack (WP-213 review, section 7)
    ["git fetch --upload-pack='touch /tmp/m' ./other", 'vcs'],
    ['git fetch -u evil origin', 'vcs'],
    ['npm test --prefix infra', 'vcs'],
    ['npm run --prefix infra x', 'vcs'],
    ['npm ci --prefix=infra', 'vcs'],
    ['npm test -C infra', 'vcs'],
    ['npm test --script-shell /tmp/sh', 'vcs'],
    [
      'node /p/scripts/dist/arima-env.mjs check --file ~/.config/ar?ma/ACME/pro?uction/env',
      'secret-file',
    ],
    ['node /p/scripts/dist/arima-env.mjs check --file infra/compose.yaml', 'production-barrier'],
    [
      'node /p/scripts/dist/arima-env.mjs up staging --project /home/u/other-app',
      'production-barrier',
    ],
    ['node /p/scripts/dist/arima-env.mjs up staging --project=/x', 'production-barrier'],
    ['node /p/scripts/dist/arima-env.mjs logs ../x', 'production-barrier'],
    ['git diff --no-index /dev/null ~/.config//arima/ACME/staging/env', 'secret-file'],
    ['git diff --no-index /dev/null ~/.config/ar?ma/ACME/production/env', 'secret-file'],
    ['git commit -F ~/.config/ar*ma/x', 'secret-file'],
    ['cat ~/.config/*/ACME/production/env', 'secret-file'],
    // the old controls still hold
    ['git push origin chore/x', 'vcs'],
    ['gh workflow run deploy.yml', 'vcs'],
    ['gh pr merge 3', 'vcs'],
    ['cat ~/.config/arima/tas/production/env', 'secret-file'],
    ['cat .env', 'secret-file'],
  ];
  it.each(blocked)('%s is blocked (%s)', (cmd, rule) => {
    expect(guardBash(cmd, ctx)?.rule).toBe(rule);
  });

  it('what a devops run is meant to do passes the guard', () => {
    for (const cmd of [
      'node /p/scripts/dist/arima-env.mjs check',
      'node /p/scripts/dist/arima-env.mjs logs staging --tail 100',
      'node /p/scripts/dist/arima-env.mjs smoke preview-3',
      'node /p/scripts/dist/arima-env.mjs status staging --json',
      'git diff HEAD~1',
      'git commit -m "chore: compose healthcheck"',
      'npm audit',
    ])
      expect(guardBash(cmd, ctx), cmd).toBeUndefined();
  });

  it.each([
    ['Grep', { pattern: 'DB_', path: '~/.config', glob: 'arima/**' }],
    ['Grep', { pattern: 'DB_', path: '~/.config/ar*ma' }],
    ['Glob', { pattern: 'ar*ma/**/env', path: '~/.config' }],
    ['Glob', { pattern: '.config/arima/**', path: '~' }],
    ['Read', { file_path: '~/.config//arima/ACME/production/env' }],
  ])('%s of ~/.config is blocked for a role', (tool, input) => {
    expect(guardTool(tool, input, ctx)?.rule).toBe('secret-file');
  });

  it('a human (no role) may still run docker', () => {
    expect(guardBash('docker ps', {})).toBeUndefined();
  });
});

describe('a preview-diagnose run is read-only like deploy-staging, and may only read a preview (WP-218)', () => {
  const pd = { role: 'devops', kind: 'preview-diagnose', defaultBranch: 'main' };
  it.each([
    ['Write', { file_path: 'infra/compose.yaml', content: 'x' }],
    ['Edit', { file_path: 'Dockerfile', old_string: 'a', new_string: 'b' }],
  ])('%s is blocked', (tool, input) => {
    expect(guardTool(tool, input, pd)?.rule).toBe('read-only-kind');
  });
  it.each(['git add -A', 'git commit -m x', 'git checkout -- .', 'git reset --hard'])(
    '%s is blocked',
    (cmd) => {
      expect(guardBash(cmd, pd)?.rule).toBe('read-only-kind');
    },
  );
  it.each([
    ['node /p/scripts/dist/arima-env.mjs up preview-7', 'host-script'],
    ['node /p/scripts/dist/arima-env.mjs down preview-7', 'host-script'],
    ['node /p/scripts/dist/arima-env.mjs logs production', 'production-barrier'],
  ])('%s is blocked (%s)', (cmd, rule) => {
    expect(guardBash(cmd, pd)?.rule).toBe(rule);
  });
  it('status, logs and smoke of a preview pass, and the role list grants exactly those for preview-*', () => {
    for (const cmd of [
      'node /p/scripts/dist/arima-env.mjs status preview-7',
      'node /p/scripts/dist/arima-env.mjs logs preview-7 --tail 100',
      'node /p/scripts/dist/arima-env.mjs smoke preview-7',
    ])
      expect(guardBash(cmd, pd), cmd).toBeUndefined();
    expect(allowed.some((t) => t.includes('arima-env.mjs" logs preview-*'))).toBe(true);
  });
});

describe('a deploy-staging run is read-only (judge J-agent:devops, blocker 2)', () => {
  const ro = { role: 'devops', kind: 'deploy-staging', defaultBranch: 'main' };
  it.each([
    ['Write', { file_path: 'infra/compose.yaml', content: 'x' }],
    ['Edit', { file_path: 'Dockerfile', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: 'docs/ops/runbook.md', content: 'x' }],
    ['Write', { file_path: '.arima/outbox/x/y.json', content: '{}' }],
  ])('%s %j is blocked', (tool, input) => {
    expect(guardTool(tool, input, ro)?.rule).toBe('read-only-kind');
  });
  it('may still propose in the outbox', () => {
    expect(
      guardTool('Write', { file_path: '.arima/outbox/q1.json', content: '{}' }, ro),
    ).toBeUndefined();
  });
  it.each([
    'git add -A',
    'git commit -m x',
    'git checkout -- .',
    'git reset --hard',
    'git stash',
    'git tag v1',
  ])('%s is blocked', (cmd) => expect(guardBash(cmd, ro)?.rule).toBe('read-only-kind'));
  it('reading git is fine, and other kinds of devops runs may still commit', () => {
    for (const cmd of ['git status', 'git log --oneline -3', 'git diff HEAD~1'])
      expect(guardBash(cmd, ro), cmd).toBeUndefined();
    expect(guardBash('git commit -m x', { ...ro, kind: 'env-plan' })).toBeUndefined();
    expect(
      guardTool(
        'Write',
        { file_path: 'infra/compose.yaml', content: 'x' },
        { ...ro, kind: 'env-plan' },
      ),
    ).toBeUndefined();
  });
});
