// Shared setup for the Stage 1 scenarios (WP-121): a temp app repo with a bare remote, a bootstrapped
// fake Notion, five stories, a stub `claude` for every role, and a fake `gh` that records every call.
// No network, no model, no cost.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DispatchDeps, DispatchOptions, GithubFacts } from '../../plugins/arima/scripts/src/dispatch.js';
import { appendEvent } from '../../plugins/arima/scripts/src/events.js';
import { moveItem } from '../../plugins/arima/scripts/src/item-status.js';
import { Throttle } from '../../plugins/arima/scripts/src/lib/throttle.js';
import { allocateId, registerEngineEntry } from '../../plugins/arima/scripts/src/notion/allocations.js';
import { bootstrapTemplate } from '../../plugins/arima/scripts/src/notion/build.js';
import { mapWorkspace } from '../../plugins/arima/scripts/src/notion/mapper.js';
import { pullMirror, readMirror } from '../../plugins/arima/scripts/src/notion/mirror.js';
import { enqueue, pushOutbox } from '../../plugins/arima/scripts/src/notion/outbox.js';
import { createNotionPort } from '../../plugins/arima/scripts/src/notion/port.js';
import type { GhResult, GhRunner } from '../../plugins/arima/scripts/src/publish.js';
import { FakeNotion } from '../../plugins/arima/scripts/test/fake-notion.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const STUB = path.join(ROOT, 'plugins/arima/scripts/test/fixtures/stub-claude.mjs');
const FENCE = '```';
export const RUN0 = 'r-20261119-0800-01';

export const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** What a stub role says: one `arima-report` block, `__RUN_ID__` and `__ITEM__` filled in by the stub CLI. */
export const reportText = (role: string, over: Record<string, unknown> = {}): string =>
  `Done.\n\n${FENCE}arima-report\n${JSON.stringify({
    schema_version: 1,
    run_id: '__RUN_ID__',
    role,
    item: '__ITEM__',
    status: 'done',
    summary: `${role} finished.`,
    ...over,
  })}\n${FENCE}\n`;

export interface World {
  dir: string;
  remote: string;
  stub: string;
  fake: FakeNotion;
  port: ReturnType<typeof createNotionPort>;
  stories: string[];
  /** Every `gh` call, in order. */
  calls: string[][];
  /** PR number by head branch. */
  prs: Map<string, number>;
  /** PRs a scripted human has approved (by number). */
  approved: Set<number>;
  deps: (over?: Partial<DispatchDeps>) => DispatchDeps;
  opts: (over?: Partial<DispatchOptions>) => DispatchOptions;
  pull: () => Promise<unknown>;
  push: () => Promise<unknown>;
  status: (id: string) => string;
}

export async function world(o: { stories?: number } = {}): Promise<World> {
  const parent = mkdtempSync(path.join(tmpdir(), 'arima-es1-'));
  const dir = path.join(parent, 'app');
  const remote = path.join(parent, 'origin.git');
  const stub = path.join(parent, 'stub');
  for (const d of [dir, remote, stub]) mkdirSync(d);
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']] as const)
    git(dir, 'config', k, v);
  const yaml = readFileSync(path.join(ROOT, 'examples/arima.yaml'), 'utf8').replace(
    'question_policy: block_story',
    'question_policy: assume_and_log',
  );
  writeFileSync(path.join(dir, 'arima.yaml'), yaml);
  writeFileSync(path.join(dir, 'team.yaml'), readFileSync(path.join(ROOT, 'examples/team.yaml'), 'utf8'));
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  writeFileSync(path.join(dir, '.gitignore'), '.arima/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');

  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  mkdirSync(path.join(dir, '.arima'), { recursive: true });
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  writeFileSync(
    path.join(dir, 'arima.yaml'),
    readFileSync(path.join(dir, 'arima.yaml'), 'utf8').replace(/root_page_id: .*/, `root_page_id: ${fake.rootId}`),
  );
  await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN0 });

  const pull = (): Promise<unknown> => pullMirror(dir, port, map);
  const push = (): Promise<unknown> => pushOutbox(dir, port, map, { allowStatusWrites: { idPrefix: 'st-' } });
  let seedN = 0;
  const seed = async (db: 'gates' | 'stories' | 'test_cases', props: Record<string, unknown>): Promise<void> => {
    seedN += 1;
    const id = `st-seed-${seedN}`;
    await registerEngineEntry(dir, id);
    enqueue(dir, {
      id,
      created_at: new Date(Date.UTC(2026, 10, 19, 7, 0, seedN)).toISOString(),
      run_id: RUN0,
      role: 'orchestrator',
      op: 'create',
      database: db,
      properties: props,
    });
  };

  await seed('gates', { Gate: 'G2', Phase: 2, Status: 'Ready for review' });
  const stories: string[] = [];
  const sizes = ['S', 'M', 'S', 'M', 'S'];
  for (let i = 0; i < (o.stories ?? 5); i++) {
    const tc = await allocateId(dir, 'TC', RUN0);
    await seed('test_cases', { ID: tc, Title: `Case ${i + 1}`, Type: 'unit' });
    const us = await allocateId(dir, 'US', RUN0);
    stories.push(us);
    await seed('stories', {
      ID: us,
      Title: `Story ${i + 1}`,
      Status: 'Backlog',
      Complexity: sizes[i % sizes.length],
      Priority: i + 1,
      'Acceptance criteria': 'Given a cart When I open it Then I see the total',
      'Test Cases': [tc],
      Attempt: 1,
    });
  }
  await push();
  await pull();

  const calls: string[][] = [];
  const prs = new Map<string, number>();
  const approved = new Set<number>();
  const headOf = (branch: string): string => {
    try {
      return git(remote, 'rev-parse', `refs/heads/${branch}`);
    } catch {
      return '0'.repeat(40);
    }
  };
  const gh: GhRunner = (args): GhResult => {
    calls.push(args);
    const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = args[args.indexOf('--head') + 1] as string;
      const n = prs.get(head);
      return ok(JSON.stringify(n === undefined ? [] : [{ number: n, url: `https://github.com/x/y/pull/${n}` }]));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const head = args[args.indexOf('--head') + 1] as string;
      const n = prs.size + 1;
      prs.set(head, n);
      return ok(`https://github.com/x/y/pull/${n}\n`);
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const n = Number(args[2]);
      const head = [...prs.entries()].find(([, v]) => v === n)?.[0] ?? '';
      const oid = headOf(head);
      return ok(
        JSON.stringify({
          number: n,
          state: 'OPEN',
          isDraft: false,
          baseRefName: 'main',
          headRefName: head,
          headRefOid: oid,
          reviews: approved.has(n)
            ? [{ author: { login: 'your-handle' }, state: 'APPROVED', commit: { oid }, submittedAt: '2026-11-19T10:00:00Z' }]
            : [],
          statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
      );
    }
    return ok('');
  };

  const green: GithubFacts = {
    prReady: (item) => Promise.resolve([...prs.keys()].some((b) => b.includes(item))),
    ciRedOnMain: () => Promise.resolve(false),
    prsAwaitingHuman: () => Promise.resolve(0),
  };

  const w: World = {
    dir,
    remote,
    stub,
    fake,
    port,
    stories,
    calls,
    prs,
    approved,
    pull,
    push,
    status: (id) => String(readMirror(dir, 'stories')?.rows.find((r) => r.id === id)?.properties['Status'] ?? '?'),
    deps: (over = {}) => ({
      claudeBin: STUB,
      killSwitchPollMs: 0,
      notion: { port },
      token: 'ghp_t',
      gh,
      github: green,
      remoteUrl: remote,
      skipState: true,
      now: new Date('2026-11-19T09:00:00Z'),
      env: { ...process.env, ARIMA_NOTION_TOKEN: 'ntn_not_real', ARIMA_GITHUB_TOKEN: 'ghp_t' },
      extraEnv: { STUB_MODE: 'by_unit', STUB_DIR: stub },
      ...over,
    }),
    opts: (over = {}) => ({ projectDir: dir, deps: w.deps(), ...over }),
  };
  return w;
}

/** The business analyst's step of the scenario: Backlog to Ready, with the DoR guards, as the engine's state machine demands. */
export async function readyAll(w: World): Promise<void> {
  for (const id of w.stories)
    await moveItem({
      projectDir: w.dir,
      item: id,
      to: 'Ready',
      actor: 'ba',
      runId: RUN0,
      facts: { guards: { dor_met: true, priority_set: true } },
    });
  await w.push();
  await w.pull();
}

/** The standard stub answers: a developer that commits, a tech-lead that approves, a QA that passes. */
export function stubRoles(w: World): void {
  const put = (name: string, text: string): void => writeFileSync(path.join(w.stub, name), text);
  put(
    'developer-develop.txt',
    reportText('developer', {
      criteria_map: [{ criterion: 'AC-1', status: 'met', evidence: ['src/cart.ts:1'] }],
    }),
  );
  put('developer-develop.commit', '');
  put(
    'tech-lead-review.txt',
    reportText('tech-lead', { verdict: { result: 'approve', reasons: ['meets the criteria'] } }),
  );
  put(
    'qa-qa.txt',
    reportText('qa', {
      verdict: { result: 'pass', reasons: ['every test case passed'] },
      criteria_map: [{ criterion: 'AC-1', status: 'met', evidence: ['TC-0001'] }],
    }),
  );
}
