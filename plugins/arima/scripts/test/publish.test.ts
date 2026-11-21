// WP-111: the host publish script, on real temporary repositories with a local bare remote and a
// stub gh (spec 10.3, D-37, D-49; F08 5.2). The live GitHub check is recorded in STATE.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAttribution } from '../src/attribution.js';
import { runPublishCli } from '../src/cli/publish-cli.js';
import { readEvents, appendEvent } from '../src/events.js';
import { outboxDir } from '../src/notion/outbox.js';
import {
  PUBLISH_EXIT,
  PublishError,
  buildReview,
  postReview,
  publishBranch,
  pushEnv,
} from '../src/publish.js';
import type { GhResult, GhRunner, PublishInput } from '../src/publish.js';
import { createWorktree } from '../src/worktree.js';
import { example, tempDir } from './helpers.js';

const RUN = 'r-20261119-1300-01';
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface World {
  repo: string;
  remote: string;
  calls: { args: string[]; input?: string; env: NodeJS.ProcessEnv }[];
  prs: { number: number; url: string; head: string }[];
  gh: GhRunner;
}

/** An app repo on main with a bare origin, a config, and a stub gh that keeps a list of PRs. */
async function world(configExtra = ''): Promise<World> {
  const parent = tempDir('arima-pub-');
  const repo = path.join(parent, 'app');
  const remote = path.join(parent, 'origin.git');
  mkdirSync(repo);
  mkdirSync(remote);
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['core.autocrlf', 'false'],
  ] as const)
    git(repo, 'config', k, v);
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(
    path.join(repo, 'arima.yaml'),
    example('arima.yaml').replace(
      '  machine_token_env: ARIMA_GITHUB_TOKEN',
      `  machine_token_env: ARIMA_GITHUB_TOKEN\n  allow_unchecked_remote: true${configExtra}`,
    ),
  );
  writeFileSync(path.join(repo, 'team.yaml'), example('team.yaml'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  await appendEvent(repo, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
  const w: World = {
    repo,
    remote,
    calls: [],
    prs: [],
    gh: () => ({ code: 0, stdout: '', stderr: '' }),
  };
  w.gh = (args, o): GhResult => {
    w.calls.push({ args, env: o.env, ...(o.input !== undefined ? { input: o.input } : {}) });
    const [a, b] = args;
    if (a === 'pr' && b === 'list') {
      const head = args[args.indexOf('--head') + 1];
      return {
        code: 0,
        stdout: JSON.stringify(
          w.prs.filter((p) => p.head === head).map(({ number, url }) => ({ number, url })),
        ),
        stderr: '',
      };
    }
    if (a === 'pr' && b === 'create') {
      const n = w.prs.length + 7;
      const url = `https://github.com/your-handle/tasty-app/pull/${n}`;
      w.prs.push({ number: n, url, head: args[args.indexOf('--head') + 1] as string });
      return { code: 0, stdout: `${url}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return w;
}

/** A worktree for the branch with one commit that changes `files`. */
async function work(
  w: World,
  branch: string,
  files: Record<string, string>,
  message = 'feat(US-112): add cart summary',
): Promise<string> {
  const c = await createWorktree({ projectDir: w.repo, branch, base: 'main', runId: RUN });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(c.path, f)), { recursive: true });
    writeFileSync(path.join(c.path, f), body);
  }
  git(c.path, 'add', '-A');
  git(
    c.path,
    '-c',
    'user.name=Dev',
    '-c',
    'user.email=dev@example.com',
    'commit',
    '-q',
    '-m',
    message,
  );
  return c.path;
}

const input = (w: World, over: Partial<PublishInput> = {}): PublishInput => ({
  projectDir: w.repo,
  runId: RUN,
  branch: 'feat/US-112-cart',
  item: 'US-112',
  role: 'developer',
  title: 'Cart summary',
  body: '## Linked items\nUS-112\n',
  repo: 'your-handle/tasty-app',
  defaultBranch: 'main',
  remoteUrl: w.remote,
  allowUncheckedRemote: true,
  gh: w.gh,
  isPaused: () => Promise.resolve(false),
  ...over,
});

const refused = async (p: Promise<unknown>): Promise<PublishError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(PublishError);
  return e as PublishError;
};

describe('publishBranch: push the checked branch and open the PR', () => {
  it('pushes the branch, opens the PR with title, base, head, labels and body, records the event and the PR link', async () => {
    const w = await world();
    const dir = await work(w, 'feat/US-112-cart', { 'src/cart.ts': 'export const cart = 1;\n' });
    const p = await publishBranch(input(w));
    expect(p).toMatchObject({
      pr: 7,
      url: 'https://github.com/your-handle/tasty-app/pull/7',
      created: true,
    });
    expect(p.sha).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(git(w.remote, 'rev-parse', 'refs/heads/feat/US-112-cart')).toBe(p.sha);
    expect(git(w.remote, 'rev-parse', 'refs/heads/main')).toBe(git(w.repo, 'rev-parse', 'main'));

    const create = w.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create?.args).toEqual(
      expect.arrayContaining([
        '--head',
        'feat/US-112-cart',
        '--base',
        'main',
        '--title',
        'US-112: Cart summary',
        '--label',
        'role:developer',
        '--label',
        'type:story',
        '--body-file',
        '-',
      ]),
    );
    expect(create?.input).toBe('## Linked items\nUS-112\n');
    expect(w.calls.filter((c) => c.args[0] === 'label').map((c) => c.args[2])).toEqual([
      'role:developer',
      'type:story',
    ]);

    expect(readEvents(w.repo).find((e) => e.type === 'pr.published')).toMatchObject({
      run_id: RUN,
      item: 'US-112',
      data: { pr: 7, branch: 'feat/US-112-cart', sha: p.sha, created: true },
    });
    const files = readdirSync(outboxDir(w.repo)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(path.join(outboxDir(w.repo), files[0] as string), 'utf8')),
    ).toMatchObject({
      op: 'update',
      database: 'stories',
      item_id: 'US-112',
      role: 'orchestrator',
      properties: { 'PR link': p.url },
    });
  });

  it('is idempotent: a second publish updates the PR and pushes new commits fast-forward', async () => {
    const w = await world();
    const dir = await work(w, 'feat/US-112-cart', { 'src/cart.ts': 'v1\n' });
    await publishBranch(input(w));
    writeFileSync(path.join(dir, 'src', 'cart.ts'), 'v2\n');
    git(dir, 'add', '-A');
    git(
      dir,
      '-c',
      'user.name=Dev',
      '-c',
      'user.email=dev@example.com',
      'commit',
      '-q',
      '-m',
      'fix(US-112): second',
    );
    const again = await publishBranch(input(w, { runId: RUN, title: 'Cart summary v2' }));
    expect(again).toMatchObject({ pr: 7, created: false });
    expect(w.prs).toHaveLength(1);
    expect(w.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toHaveLength(1);
    const edit = w.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'edit');
    expect(edit?.args).toEqual(expect.arrayContaining(['7', '--title', 'US-112: Cart summary v2']));
    expect(git(w.remote, 'rev-parse', 'refs/heads/feat/US-112-cart')).toBe(again.sha);
    // two outbox entries with distinct ids, never an overwrite
    expect(readdirSync(outboxDir(w.repo)).filter((f) => f.endsWith('.json'))).toHaveLength(2);
  });

  it('refuses to push the default or state branch, or anything not an ARIMA branch', async () => {
    const w = await world();
    await work(w, 'feat/US-112-cart', { 'src/c.ts': 'x\n' });
    for (const branch of ['main', 'master', 'arima-state', 'evil', 'feat/../x'])
      expect((await refused(publishBranch(input(w, { branch })))).exitCode, branch).toBe(
        PUBLISH_EXIT.refused,
      );
    expect(
      (await refused(publishBranch(input(w, { branch: 'trunk', defaultBranch: 'trunk' }))))
        .exitCode,
    ).toBe(PUBLISH_EXIT.refused);
    expect(git(w.remote, 'branch', '--list').replace('* ', '')).toBe('main');
  });

  it('never forces: a diverged remote branch is refused with exit 32, and the remote keeps its commit', async () => {
    const w = await world();
    await work(w, 'feat/US-112-cart', { 'src/c.ts': 'mine\n' });
    // someone pushed a different commit to the same branch name
    const other = path.join(tempDir('arima-other-'), 'o');
    git(path.dirname(other), 'clone', '-q', w.remote, 'o');
    git(other, 'checkout', '-q', '-b', 'feat/US-112-cart');
    writeFileSync(path.join(other, 'theirs.txt'), 'theirs');
    git(other, 'add', '-A');
    git(other, '-c', 'user.name=T', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q', 'origin', 'feat/US-112-cart');
    const before = git(w.remote, 'rev-parse', 'refs/heads/feat/US-112-cart');
    const e = await refused(publishBranch(input(w)));
    expect(e.exitCode).toBe(PUBLISH_EXIT.pushFailed);
    expect(e.message).toMatch(/push refused/);
    expect(git(w.remote, 'rev-parse', 'refs/heads/feat/US-112-cart')).toBe(before);
    expect(w.calls.some((c) => c.args[1] === 'create')).toBe(false);
  });
});

describe('the branch is checked before it leaves the machine (exit 31)', () => {
  const code = async (p: Promise<unknown>): Promise<[number, string, string | undefined]> => {
    const e = await refused(p);
    return [e.exitCode, e.message, e.code];
  };

  it('uncommitted changes, nothing to publish, wrong branch and no worktree', async () => {
    const w = await world();
    const dir = await work(w, 'feat/US-112-cart', { 'src/c.ts': 'x\n' });
    writeFileSync(path.join(dir, 'dirty.txt'), 'x');
    expect((await code(publishBranch(input(w))))[1]).toMatch(/uncommitted changes/);
    expect((await code(publishBranch(input(w, { branch: 'feat/US-999-none' }))))[1]).toMatch(
      /no worktree/,
    );
    const c2 = await createWorktree({
      projectDir: w.repo,
      branch: 'feat/US-113-empty',
      base: 'main',
      runId: RUN,
    });
    expect(c2.branch).toBe('feat/US-113-empty');
    expect((await code(publishBranch(input(w, { branch: 'feat/US-113-empty' }))))[1]).toMatch(
      /no changes against (origin\/)?main/,
    );
    git(dir, 'checkout', '-q', '--detach');
    expect((await code(publishBranch(input(w))))[1]).toMatch(/not feat\/US-112-cart/);
  });

  it('protected paths (config, CI, hooks, state) are refused, except .github for devops', async () => {
    const w = await world();
    await work(w, 'feat/US-1-a', { 'arima.yaml': 'x: 1\n' });
    expect((await code(publishBranch(input(w, { branch: 'feat/US-1-a' }))))[2]).toBe(
      'protected_path',
    );
    await work(w, 'feat/US-2-b', { '.github/workflows/ci.yml': 'name: x\n' });
    expect((await code(publishBranch(input(w, { branch: 'feat/US-2-b' }))))[2]).toBe(
      'protected_path',
    );
    expect(
      (await publishBranch(input(w, { branch: 'feat/US-2-b', role: 'devops', item: 'US-2' })))
        .created,
    ).toBe(true);
    await work(w, 'feat/US-3-c', { '.githooks/pre-commit': '#!/bin/sh\n' });
    expect((await code(publishBranch(input(w, { branch: 'feat/US-3-c' }))))[0]).toBe(31);
    await work(w, 'feat/US-4-d', { '.arima/ledger.jsonl': '{}\n' });
    expect((await code(publishBranch(input(w, { branch: 'feat/US-4-d' }))))[2]).toBe(
      'protected_path',
    );
  });

  it('QA may publish only tests/**, and the developer never tests/e2e/**', async () => {
    const w = await world();
    await work(w, 'qa/US-5-tests', { 'tests/e2e/a.spec.ts': 't\n', 'src/leak.ts': 'x\n' });
    const [c, m] = await code(
      publishBranch(input(w, { branch: 'qa/US-5-tests', role: 'qa', item: 'US-5' })),
    );
    expect(c).toBe(31);
    expect(m).toMatch(/QA may change only tests\/\*\*.*src\/leak\.ts/);
    await work(w, 'qa/US-6-tests', { 'tests/e2e/a.spec.ts': 't\n' });
    expect(
      (await publishBranch(input(w, { branch: 'qa/US-6-tests', role: 'qa', item: 'US-6' })))
        .created,
    ).toBe(true);
    await work(w, 'feat/US-7-x', { 'tests/e2e/b.spec.ts': 't\n' });
    expect(
      (await code(publishBranch(input(w, { branch: 'feat/US-7-x', item: 'US-7' }))))[1],
    ).toMatch(/tests\/e2e/);
  });

  it('a default branch moved onto a forbidden commit cannot hide it (judge J-agent:developer, blocker 1)', async () => {
    const w = await world();
    const wt = await work(w, 'feat/US-9-hide', { 'tests/e2e/a.spec.ts': 'weakened\n' });
    // The role moves the local default branch onto its forbidden commit, then adds a clean commit.
    git(wt, 'update-ref', 'refs/heads/main', 'HEAD');
    writeFileSync(path.join(wt, 'ok.txt'), 'fine\n');
    git(wt, 'add', '-A');
    git(
      wt,
      '-c',
      'user.name=Dev',
      '-c',
      'user.email=dev@example.com',
      'commit',
      '-q',
      '-m',
      'feat(US-9): ok',
    );
    const [c, m] = await code(publishBranch(input(w, { branch: 'feat/US-9-hide', item: 'US-9' })));
    expect(c).toBe(31);
    expect(m).toMatch(/was moved/);
  });

  it('a secret added anywhere in the diff is refused, unless a human allow-listed its fingerprint', async () => {
    const w = await world();
    const token = `ntn_${'aB3xQ9zLm2Kp7Vd4Ts8Wy1Nc6Hf0JgReUo5Xi'}`;
    await work(w, 'feat/US-8-leak', { 'src/config.ts': `export const t = "${token}";\n` });
    const [c, , reason] = await code(
      publishBranch(input(w, { branch: 'feat/US-8-leak', item: 'US-8' })),
    );
    expect([c, reason]).toEqual([31, 'secret_in_output']);
    expect(git(w.remote, 'branch', '--list')).not.toContain('US-8');
  });

  it('AI attribution in a commit message or the PR text is refused (D-48)', async () => {
    const w = await world();
    await work(
      w,
      'feat/US-9-attr',
      { 'src/x.ts': 'x\n' },
      'feat(US-9): x\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    );
    expect(
      (await code(publishBranch(input(w, { branch: 'feat/US-9-attr', item: 'US-9' }))))[1],
    ).toMatch(/Co-Authored-By trailer.*D-48/);
    await work(w, 'feat/US-10-ok', { 'src/y.ts': 'y\n' });
    expect(
      (
        await code(
          publishBranch(
            input(w, {
              branch: 'feat/US-10-ok',
              item: 'US-10',
              body: 'Done.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
            }),
          ),
        )
      )[1],
    ).toMatch(/AI attribution/);
    expect(
      (
        await code(
          publishBranch(
            input(w, {
              branch: 'feat/US-10-ok',
              item: 'US-10',
              body: `token ntn_${'aB3xQ9zLm2Kp7Vd4Ts8Wy1Nc6Hf0JgReUo5Xi'}`,
            }),
          ),
        )
      )[2],
    ).toBe('secret_in_output');
    expect(w.prs).toHaveLength(0);
  });
});

describe('the kill switch, the remote and the token', () => {
  it('a set kill switch stops the publish with exit 12 and a hardstop.hit, pushing nothing', async () => {
    const w = await world();
    await work(w, 'feat/US-112-cart', { 'src/c.ts': 'x\n' });
    writeFileSync(path.join(w.repo, '.arima', 'PAUSE'), 'freeze\n');
    const e = await refused(publishBranch(input(w, { isPaused: undefined as never })));
    expect(e.exitCode).toBe(PUBLISH_EXIT.killSwitch);
    expect(
      readEvents(w.repo).some(
        (x) => x.type === 'hardstop.hit' && x.data?.['stop'] === 'kill_switch',
      ),
    ).toBe(true);
    expect(git(w.remote, 'branch', '--list')).not.toContain('US-112');
  });

  it('a remote that is not github.com is refused unless github.allow_unchecked_remote is true', async () => {
    const w = await world();
    await work(w, 'feat/US-112-cart', { 'src/c.ts': 'x\n' });
    const e = await refused(publishBranch(input(w, { allowUncheckedRemote: false })));
    expect(e).toMatchObject({ exitCode: PUBLISH_EXIT.pushFailed, code: 'remote_unchecked' });
    expect(git(w.remote, 'branch', '--list')).not.toContain('US-112');
  });

  it('a github.com push needs the machine token (exit 14) and must name the configured repo', async () => {
    const w = await world();
    await work(w, 'feat/US-112-cart', { 'src/c.ts': 'x\n' });
    const noToken = await refused(
      publishBranch(
        input(w, {
          remoteUrl: 'https://github.com/your-handle/tasty-app.git',
          allowUncheckedRemote: false,
        }),
      ),
    );
    expect(noToken).toMatchObject({ exitCode: PUBLISH_EXIT.env, code: 'credential_missing' });
    const other = await refused(
      publishBranch(
        input(w, {
          remoteUrl: 'https://github.com/someone-else/other.git',
          allowUncheckedRemote: false,
          token: 'x',
        }),
      ),
    );
    expect(other.exitCode).toBe(PUBLISH_EXIT.refused);
    expect(other.message).toMatch(/someone-else\/other.*your-handle\/tasty-app/);
  });

  it('the token travels only as a one-off header in the push environment, never in the URL or arguments', () => {
    const env = pushEnv('ghp_secret_token_value', true);
    expect(env['GIT_CONFIG_COUNT']).toBe('1');
    expect(env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
    expect(
      Buffer.from(
        (env['GIT_CONFIG_VALUE_0'] as string).split(' ').pop() as string,
        'base64',
      ).toString(),
    ).toBe('x-access-token:ghp_secret_token_value');
    expect(pushEnv('ghp_secret_token_value', false)['GIT_CONFIG_COUNT']).toBeUndefined();
    expect(pushEnv(undefined, true)['GIT_CONFIG_COUNT']).toBeUndefined();
    const src = readFileSync(path.join(import.meta.dirname, '..', 'src', 'publish.ts'), 'utf8');
    expect(src).not.toMatch(/x-access-token:\$\{token\}@/);
  });

  it('gh gets the token as GH_TOKEN and no prompt; git errors are redacted', async () => {
    const w = await world();
    await work(w, 'feat/US-112-cart', { 'src/c.ts': 'x\n' });
    await publishBranch(input(w, { token: 'ghp_secret_token_value' }));
    expect(
      w.calls.every(
        (c) =>
          c.env['GH_TOKEN'] === 'ghp_secret_token_value' && c.env['GH_PROMPT_DISABLED'] === '1',
      ),
    ).toBe(true);
    const failing: GhRunner = () => ({
      code: 1,
      stdout: '',
      stderr: 'denied for ghp_secret_token_value',
    });
    await work(w, 'feat/US-20-x', { 'src/z.ts': 'z\n' });
    const e = await refused(
      publishBranch(
        input(w, {
          branch: 'feat/US-20-x',
          item: 'US-20',
          token: 'ghp_secret_token_value',
          gh: failing,
        }),
      ),
    );
    expect(e.message).not.toContain('ghp_secret_token_value');
    expect(e.message).toContain('***');
  });
});

describe('review comments are posted by the host, as COMMENT reviews only', () => {
  const finding = (location: string) => ({
    severity: 'major',
    location,
    claim: 'Discount ignored',
    evidence: 'line 41 sums price',
    recommendation: 'Apply it',
  });

  it('every verdict becomes event COMMENT, never an approval or a change request', () => {
    for (const result of ['approve', 'changes_requested', 'pass', 'fail', 'no_go', 'go']) {
      const r = buildReview({
        role: 'tech-lead',
        item: 'US-1',
        findings: [finding('src/a.ts:41')],
        verdict: { result, reasons: ['why'] },
      });
      expect(r.event).toBe('COMMENT');
      expect(JSON.stringify(r)).not.toMatch(/APPROVE|REQUEST_CHANGES/);
    }
  });

  it('file:line findings are inline comments, the rest go in the body', () => {
    const r = buildReview({
      role: 'qa',
      item: 'US-1',
      findings: [
        finding('src/a.ts:41'),
        finding('TC-0231'),
        finding('../etc/passwd:3'),
        finding('/abs/x.ts:1'),
      ],
      verdict: { result: 'fail', reasons: ['a test failed'] },
    });
    expect(r.comments).toEqual([
      {
        path: 'src/a.ts',
        line: 41,
        side: 'RIGHT',
        body: expect.stringContaining('Discount ignored'),
      },
    ]);
    expect(r.body).toContain('qa review of US-1: fail');
    expect(r.body).toContain('- a test failed');
    expect(r.body).toContain('`TC-0231`');
    expect(r.body).toContain('`../etc/passwd:3`');
  });

  it('posts one review through gh api with the machine token; falls back to the body when an anchor is refused', async () => {
    const w = await world();
    const sent: { args: string[]; input: string; env: NodeJS.ProcessEnv }[] = [];
    const gh: GhRunner = (args, o) => {
      sent.push({ args, input: o.input as string, env: o.env });
      return sent.length === 1
        ? { code: 1, stdout: '', stderr: 'Unprocessable: line must be part of the diff' }
        : { code: 0, stdout: '{}', stderr: '' };
    };
    const r = await postReview({
      projectDir: w.repo,
      role: 'tech-lead',
      item: 'US-1',
      pr: 7,
      repo: 'your-handle/tasty-app',
      findings: [finding('src/a.ts:41')],
      verdict: { result: 'changes_requested', reasons: ['x'] },
      token: 'ghp_t',
      gh,
      isPaused: () => Promise.resolve(false),
    });
    expect(r).toEqual({ posted: 1, inline: 0 });
    expect(sent[0]?.args).toEqual([
      'api',
      'repos/your-handle/tasty-app/pulls/7/reviews',
      '--method',
      'POST',
      '--input',
      '-',
    ]);
    expect(JSON.parse(sent[0]?.input as string)).toMatchObject({
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', line: 41 }],
    });
    expect(JSON.parse(sent[1]?.input as string)).toMatchObject({ event: 'COMMENT', comments: [] });
    expect(sent[1]?.input).toContain('src/a.ts line 41');
    expect(sent.every((s) => s.env['GH_TOKEN'] === 'ghp_t')).toBe(true);
  });

  it('refuses without a token (14), while paused (12), and with a secret or attribution in the text (31)', async () => {
    const w = await world();
    const base = {
      projectDir: w.repo,
      role: 'security' as const,
      item: 'US-1',
      pr: 7,
      repo: 'a/b',
      findings: [finding('src/a.ts:1')],
      token: 'ghp_t',
      gh: w.gh,
      isPaused: () => Promise.resolve(false),
    };
    expect((await refused(postReview({ ...base, token: undefined }))).exitCode).toBe(14);
    expect(
      (await refused(postReview({ ...base, isPaused: () => Promise.resolve(true) }))).exitCode,
    ).toBe(12);
    expect(
      (
        await refused(
          postReview({
            ...base,
            findings: [
              {
                ...finding('src/a.ts:1'),
                claim: `key ntn_${'aB3xQ9zLm2Kp7Vd4Ts8Wy1Nc6Hf0JgReUo5Xi'}`,
              },
            ],
          }),
        )
      ).code,
    ).toBe('secret_in_output');
    expect(
      (
        await refused(
          postReview({
            ...base,
            findings: [
              { ...finding('src/a.ts:1'), claim: 'Co-Authored-By: Claude <x@anthropic.com>' },
            ],
          }),
        )
      ).exitCode,
    ).toBe(31);
    expect(w.calls.filter((c) => c.args[0] === 'api')).toEqual([]);
  });
});

describe('findAttribution (D-48)', () => {
  it('finds the usual forms and leaves normal text alone', () => {
    expect(findAttribution('Co-Authored-By: Claude <noreply@anthropic.com>')).toHaveLength(1);
    expect(findAttribution('co-authored-by: Dana <dana@example.com>')).toEqual([]);
    expect(
      findAttribution('🤖 Generated with [Claude Code](https://claude.com/claude-code)').length,
    ).toBeGreaterThan(0);
    expect(findAttribution('Generated with ChatGPT')).toHaveLength(1);
    expect(findAttribution('written with Claude')).toHaveLength(1);
    expect(
      findAttribution('feat(US-1): add a claude.md loader\n\nGenerated types are in src/gen.'),
    ).toEqual([]);
  });
});

describe('arima-publish', () => {
  const run = async (argv: string[], cwd: string, w: World, env: NodeJS.ProcessEnv = {}) => {
    const r = { out: '', err: '' };
    const code = await runPublishCli(
      argv,
      { out: (s) => (r.out += s), err: (s) => (r.err += s), cwd },
      { env, gh: w.gh, remoteUrl: w.remote },
    );
    return { code, ...r };
  };

  it('push opens the PR (exit 0), refuses a protected branch (31) and a missing option (2)', async () => {
    const w = await world();
    await work(w, 'feat/US-112-cart', { 'src/c.ts': 'x\n' });
    writeFileSync(path.join(w.repo, 'body.md'), 'Body\n');
    const args = [
      'push',
      '--branch',
      'feat/US-112-cart',
      '--item',
      'US-112',
      '--role',
      'developer',
      '--title',
      'Cart',
      '--body-file',
      'body.md',
      '--run-id',
      RUN,
    ];
    const ok = await run(args, w.repo, w);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ pr: 7, created: true });
    expect(
      (
        await run(
          args.map((a) => (a === 'feat/US-112-cart' ? 'main' : a)),
          w.repo,
          w,
        )
      ).code,
    ).toBe(31);
    expect((await run(['push', '--branch', 'x'], w.repo, w)).code).toBe(2);
    expect((await run([], w.repo, w)).code).toBe(2);
    expect(
      (await run(['push', ...args.slice(1, -2), '--run-id', RUN, '--role', 'sponsor'], w.repo, w))
        .code,
    ).toBe(2);
  });

  it('comment posts a COMMENT review from a validated report (exit 0) and needs the token (14)', async () => {
    const w = await world();
    const report = path.join(w.repo, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        role: 'tech-lead',
        item: 'US-1',
        verdict: { result: 'approve', reasons: ['ok'] },
        findings: [],
      }),
    );
    expect((await run(['comment', '--pr', '7', '--report', 'report.json'], w.repo, w)).code).toBe(
      14,
    );
    const ok = await run(['comment', '--pr', '7', '--report', 'report.json'], w.repo, w, {
      ARIMA_GITHUB_TOKEN: 'ghp_t',
    });
    expect(ok.code).toBe(0);
    expect(
      w.calls.some((c) => c.args[0] === 'api' && JSON.parse(c.input as string).event === 'COMMENT'),
    ).toBe(true);
    expect((await run(['comment', '--pr', 'x', '--report', 'report.json'], w.repo, w)).code).toBe(
      2,
    );
    expect(existsSync(report)).toBe(true);
  });
});
