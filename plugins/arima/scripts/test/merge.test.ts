// WP-112: arima-merge, the only merger (spec 10.3, D-21, D-29, D-38; F08 5.3).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMergeCli } from '../src/cli/merge-cli.js';
import { validateProject } from '../src/config.js';
import { appendEvent, readEvents } from '../src/events.js';
import {
  MERGE_EXIT,
  MergeRefused,
  evaluateMerge,
  humanApprovers,
  humanApproval,
  mergePr,
  summariseChecks,
} from '../src/merge.js';
import type { Condition, MergeFacts, MergeInput } from '../src/merge.js';
import { outboxDir } from '../src/notion/outbox.js';
import type { GhResult, GhRunner } from '../src/publish.js';
import { ROLES, allowedTools, deniedTools } from '../src/roles.js';
import { example, tempDir } from './helpers.js';

const RUN = 'r-20261119-1500-01';
const SHA = 'a'.repeat(40);

interface Pr {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviews: {
    author: { login: string };
    state: string;
    commit: { oid: string };
    submittedAt: string;
  }[];
  statusCheckRollup: Record<string, string>[];
}
const goodPr = (over: Partial<Pr> = {}): Pr => ({
  number: 7,
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'feat/US-112-cart',
  headRefOid: SHA,
  reviews: [
    {
      author: { login: 'your-handle' },
      state: 'APPROVED',
      commit: { oid: SHA },
      submittedAt: '2026-11-19T10:00:00Z',
    },
  ],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'secret-scan', state: 'SUCCESS' },
  ],
  ...over,
});

const row = (id: string, properties: Record<string, unknown>) => ({
  page_id: `p-${id}`,
  last_edited_time: 't',
  id,
  properties,
});
const mirror = (dir: string, db: string, rows: unknown[]): void => {
  mkdirSync(path.join(dir, '.arima', 'mirror'), { recursive: true });
  writeFileSync(
    path.join(dir, '.arima', 'mirror', `${db}.json`),
    JSON.stringify({ database: db, rows }),
  );
};

interface World {
  dir: string;
  calls: string[][];
  pr: Pr;
  mergeResult: GhResult;
  gh: GhRunner;
  input: MergeInput;
}

/** A project where every condition holds; each test breaks exactly one. */
async function world(): Promise<World> {
  const parent = tempDir('arima-merge-');
  const dir = path.join(parent, 'app');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(path.join(dir, 'arima.yaml'), example('arima.yaml'));
  writeFileSync(path.join(dir, 'team.yaml'), example('team.yaml'));
  mirror(dir, 'stories', [
    row('US-112', { Status: 'In QA', 'Test Cases': ['TC-0001', 'TC-0002'] }),
  ]);
  mirror(dir, 'test_cases', [
    row('TC-0001', { 'Last result': 'Pass' }),
    row('TC-0002', { 'Last result': 'Pass' }),
  ]);
  await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: RUN });
  await appendEvent(dir, {
    type: 'pr.published',
    actor: 'system',
    item: 'US-112',
    data: { pr: 7 },
  });
  await appendEvent(dir, {
    type: 'report.accepted',
    actor: 'system',
    item: 'US-112',
    data: { role: 'tech-lead', kind: 'review', verdict: 'approve' },
  });
  const w = {
    dir,
    calls: [] as string[][],
    pr: goodPr(),
    mergeResult: { code: 0, stdout: '', stderr: '' },
  } as unknown as World;
  w.gh = (args) => {
    w.calls.push(args);
    if (args[1] === 'view') return { code: 0, stdout: JSON.stringify(w.pr), stderr: '' };
    return w.mergeResult;
  };
  const team = validateProject(dir).team!;
  w.input = {
    projectDir: dir,
    runId: RUN,
    pr: 7,
    item: 'US-112',
    repo: 'your-handle/tasty-app',
    defaultBranch: 'main',
    machineAccount: 'your-arima-bot',
    team,
    token: 'ghp_t',
    gh: w.gh,
    isPaused: () => Promise.resolve(false),
  };
  return w;
}

const refusal = async (p: Promise<unknown>): Promise<MergeRefused> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(MergeRefused);
  return e as MergeRefused;
};
const merged = (w: World): boolean => w.calls.some((c) => c[1] === 'merge');
const conditions = (e: MergeRefused): Condition[] => e.missing.map((m) => m.condition);

describe('merging with every condition present', () => {
  it('squash-merges at exactly the checked head, records merge.done, moves the story and cleans up', async () => {
    const w = await world();
    const r = await mergePr(w.input);
    expect(r).toEqual({ sha: SHA, item: 'US-112' });
    expect(w.calls.find((c) => c[1] === 'merge')).toEqual([
      'pr',
      'merge',
      '7',
      '--repo',
      'your-handle/tasty-app',
      '--squash',
      '--match-head-commit',
      SHA,
    ]);
    expect(readEvents(w.dir).find((e) => e.type === 'merge.done')).toMatchObject({
      item: 'US-112',
      run_id: RUN,
      data: { pr: 7, sha: SHA, branch: 'feat/US-112-cart' },
    });
    const move = readEvents(w.dir).find((e) => e.type === 'item.status');
    expect(move).toMatchObject({
      actor: 'merge-script',
      item: 'US-112',
      data: { from: 'In QA', to: 'PO Acceptance' },
    });
    const entries = readdirSync(outboxDir(w.dir)).filter((f) => f.endsWith('.json'));
    expect(entries).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(path.join(outboxDir(w.dir), entries[0] as string), 'utf8'))
        .properties,
    ).toMatchObject({ Status: 'PO Acceptance' });
    expect(readEvents(w.dir).some((e) => e.type === 'merge.refused')).toBe(false);
  });

  it('never uses a merge commit, rebase, admin override or auto-merge', async () => {
    const w = await world();
    await mergePr(w.input);
    const args = w.calls.find((c) => c[1] === 'merge') as string[];
    for (const bad of ['--merge', '--rebase', '--admin', '--auto', '--delete-branch'])
      expect(args).not.toContain(bad);
  });
});

describe('each missing condition is refused with exit 30 and named', () => {
  const cases: [string, (w: World) => void | Promise<void>, Condition][] = [
    [
      'a failing check',
      (w) =>
        void (w.pr.statusCheckRollup[1] = {
          __typename: 'CheckRun',
          name: 'test',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
        }),
      'ci_green',
    ],
    [
      'a check that has not finished',
      (w) =>
        void (w.pr.statusCheckRollup[0] = {
          __typename: 'CheckRun',
          name: 'lint',
          status: 'IN_PROGRESS',
          conclusion: '',
        }),
      'ci_green',
    ],
    [
      'a failing status context',
      (w) =>
        void (w.pr.statusCheckRollup[2] = {
          __typename: 'StatusContext',
          context: 'secret-scan',
          state: 'FAILURE',
        }),
      'ci_green',
    ],
    ['no checks at all', (w) => void (w.pr.statusCheckRollup = []), 'ci_green'],
    ['a draft pull request', (w) => void (w.pr.isDraft = true), 'pr_open'],
    ['a closed pull request', (w) => void (w.pr.state = 'CLOSED'), 'pr_open'],
    ['a pull request against another base', (w) => void (w.pr.baseRefName = 'develop'), 'pr_open'],
    ['no human review', (w) => void (w.pr.reviews = []), 'human_approval'],
    [
      'an approval of an older commit (stale)',
      (w) => void (w.pr.reviews[0]!.commit.oid = 'b'.repeat(40)),
      'human_approval',
    ],
    [
      'an approval by the machine account',
      (w) =>
        void (w.pr.reviews = [
          {
            author: { login: 'your-arima-bot' },
            state: 'APPROVED',
            commit: { oid: SHA },
            submittedAt: 'x',
          },
        ]),
      'human_approval',
    ],
    [
      'an approval by someone not listed in team.yaml',
      (w) =>
        void (w.pr.reviews = [
          {
            author: { login: 'stranger' },
            state: 'APPROVED',
            commit: { oid: SHA },
            submittedAt: 'x',
          },
        ]),
      'human_approval',
    ],
    [
      'changes requested after the approval',
      (w) =>
        void w.pr.reviews.push({
          author: { login: 'your-handle' },
          state: 'CHANGES_REQUESTED',
          commit: { oid: SHA },
          submittedAt: '2026-11-19T11:00:00Z',
        }),
      'human_approval',
    ],
    ['a dismissed approval', (w) => void (w.pr.reviews[0]!.state = 'DISMISSED'), 'human_approval'],
    ['only a comment review', (w) => void (w.pr.reviews[0]!.state = 'COMMENTED'), 'human_approval'],
    [
      'a story that is not In QA',
      (w) =>
        mirror(w.dir, 'stories', [
          row('US-112', { Status: 'In Review', 'Test Cases': ['TC-0001', 'TC-0002'] }),
        ]),
      'story_in_qa',
    ],
    [
      'a story with no test cases',
      (w) => mirror(w.dir, 'stories', [row('US-112', { Status: 'In QA', 'Test Cases': [] })]),
      'test_cases_pass',
    ],
    [
      'a test case that has not passed',
      (w) =>
        mirror(w.dir, 'test_cases', [
          row('TC-0001', { 'Last result': 'Pass' }),
          row('TC-0002', { 'Last result': 'Fail' }),
        ]),
      'test_cases_pass',
    ],
    [
      'a test case that was never run',
      (w) =>
        mirror(w.dir, 'test_cases', [
          row('TC-0001', { 'Last result': 'Pass' }),
          row('TC-0002', { 'Last result': 'Not run' }),
        ]),
      'test_cases_pass',
    ],
    [
      'a UI story with no design QA pass',
      (w) => void mkdirSync(path.join(w.dir, 'design', 'screens', 'US-112'), { recursive: true }),
      'design_qa',
    ],
  ];

  it.each(cases)('%s', async (_name, breakIt, condition) => {
    const w = await world();
    await breakIt(w);
    const e = await refusal(mergePr(w.input));
    expect(e.exitCode).toBe(30);
    expect(conditions(e)).toEqual([condition]);
    expect(e.message).toContain(condition);
    expect(merged(w)).toBe(false);
    expect(readEvents(w.dir).find((x) => x.type === 'merge.refused')).toMatchObject({
      item: 'US-112',
      data: { missing: [condition] },
    });
    expect(readEvents(w.dir).some((x) => x.type === 'merge.done' || x.type === 'item.status')).toBe(
      false,
    );
  });

  it('tech-lead verdicts: changes_requested, none, and an approve that predates the last push all refuse', async () => {
    for (const make of [
      async (w: World) =>
        appendEvent(w.dir, {
          type: 'report.accepted',
          actor: 'system',
          item: 'US-112',
          data: { role: 'tech-lead', kind: 'review', verdict: 'changes_requested' },
        }),
      async (w: World) =>
        appendEvent(w.dir, {
          type: 'pr.published',
          actor: 'system',
          item: 'US-112',
          data: { pr: 7, created: false },
        }),
    ]) {
      const w = await world();
      await make(w);
      const e = await refusal(mergePr(w.input));
      expect(conditions(e)).toEqual(['tech_lead_approve']);
    }
    const w = await world();
    writeFileSync(
      path.join(w.dir, '.arima', 'events.jsonl'),
      readFileSync(path.join(w.dir, '.arima', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => !l.includes('report.accepted'))
        .join('\n'),
    );
    expect(conditions(await refusal(mergePr(w.input)))).toEqual(['tech_lead_approve']);
  });

  it('design QA passes the merge when the ux verdict came after the last push', async () => {
    const w = await world();
    mkdirSync(path.join(w.dir, 'design', 'screens', 'US-112'), { recursive: true });
    await appendEvent(w.dir, {
      type: 'report.accepted',
      actor: 'system',
      item: 'US-112',
      data: { role: 'ux', kind: 'design-qa', verdict: 'pass' },
    });
    await mergePr(w.input);
    expect(merged(w)).toBe(true);
    const f = await world();
    mkdirSync(path.join(f.dir, 'design', 'screens', 'US-112'), { recursive: true });
    await appendEvent(f.dir, {
      type: 'report.accepted',
      actor: 'system',
      item: 'US-112',
      data: { role: 'ux', kind: 'design-qa', verdict: 'fail' },
    });
    expect(await refusal(mergePr(f.input)).then(conditions)).toEqual(['design_qa']);
  });

  it('several missing conditions are all named in one refusal', async () => {
    const w = await world();
    w.pr.statusCheckRollup = [];
    w.pr.reviews = [];
    mirror(w.dir, 'stories', [row('US-112', { Status: 'In Progress', 'Test Cases': [] })]);
    const e = await refusal(mergePr(w.input));
    expect(conditions(e)).toEqual(['ci_green', 'story_in_qa', 'test_cases_pass', 'human_approval']);
  });
});

describe('the baseline exception (F04 RD-F04-9)', () => {
  const baseline = async (status: string | undefined, over: Partial<Pr> = {}): Promise<World> => {
    const w = await world();
    w.pr = goodPr({ headRefName: 'chore/baseline-G1', reviews: [], ...over });
    mirror(w.dir, 'gates', status === undefined ? [] : [row('G1', { Status: status })]);
    mirror(w.dir, 'stories', []);
    return w;
  };
  it('green checks and an Approved gate replace QA, the tech-lead verdict and the PR review', async () => {
    for (const status of ['Approved', 'Approved with conditions']) {
      const w = await baseline(status);
      await mergePr({ ...w.input, item: 'none' });
      expect(merged(w)).toBe(true);
      expect(readEvents(w.dir).some((e) => e.type === 'item.status')).toBe(false);
    }
  });
  it('a gate that is not Approved, or failing checks, still refuse', async () => {
    for (const status of ['Ready for review', 'Rejected', undefined]) {
      const w = await baseline(status);
      expect(conditions(await refusal(mergePr({ ...w.input, item: 'none' })))).toEqual([
        'gate_approved',
      ]);
    }
    const w = await baseline('Approved', {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    });
    expect(conditions(await refusal(mergePr({ ...w.input, item: 'none' })))).toEqual(['ci_green']);
  });
  it('only the exact branch pattern is a baseline', async () => {
    const w = await baseline('Approved', { headRefName: 'chore/baseline-G9' });
    expect((await refusal(mergePr({ ...w.input, item: 'none' }))).missing.length).toBeGreaterThan(
      1,
    );
  });
});

describe('the hard stops around the merge', () => {
  it('the kill switch stops it with exit 12 and records the hard stop; GitHub is not even asked', async () => {
    const w = await world();
    const e = await refusal(mergePr({ ...w.input, isPaused: () => Promise.resolve(true) }));
    expect(e.exitCode).toBe(MERGE_EXIT.killSwitch);
    expect(w.calls).toEqual([]);
    expect(
      readEvents(w.dir).some(
        (x) => x.type === 'hardstop.hit' && x.data?.['stop'] === 'kill_switch',
      ),
    ).toBe(true);
  });

  it('a missing token is exit 14 and nothing is asked of GitHub', async () => {
    const w = await world();
    const e = await mergePr({ ...w.input, token: undefined }).then(
      () => undefined,
      (x: unknown) => x as { exitCode: number },
    );
    expect(e?.exitCode).toBe(14);
    expect(w.calls).toEqual([]);
  });

  it('GitHub refusing the merge (the head moved after the check) is exit 32, with no merge.done and no state change', async () => {
    const w = await world();
    w.mergeResult = {
      code: 1,
      stdout: '',
      stderr: 'Head branch was modified. Review and try the merge again. ghp_t',
    };
    const e = await refusal(mergePr(w.input));
    expect(e.exitCode).toBe(MERGE_EXIT.githubFailed);
    expect(e.message).not.toContain('ghp_t');
    expect(readEvents(w.dir).some((x) => x.type === 'merge.done' || x.type === 'item.status')).toBe(
      false,
    );
    expect(readEvents(w.dir).find((x) => x.type === 'merge.refused')).toMatchObject({
      data: { github: expect.stringContaining('Head branch was modified') },
    });
  });

  it('an unreadable pull request is exit 32', async () => {
    const w = await world();
    const bad: GhRunner = () => ({ code: 1, stdout: '', stderr: 'not found' });
    expect((await refusal(mergePr({ ...w.input, gh: bad }))).exitCode).toBe(32);
    const junk: GhRunner = () => ({ code: 0, stdout: 'not json', stderr: '' });
    expect((await refusal(mergePr({ ...w.input, gh: junk }))).exitCode).toBe(32);
  });
});

describe('no agent role can merge', () => {
  it('no role lists arima-merge, arima-publish or arima-worktree, and every role denies gh pr merge', () => {
    for (const role of ROLES) {
      const allowed = allowedTools(role, '/p/scripts/dist').join('\n');
      for (const s of ['arima-merge', 'arima-publish', 'arima-worktree'])
        expect(allowed, `${role} ${s}`).not.toContain(s);
      expect(allowed, role).not.toMatch(/gh pr merge/);
      expect(deniedTools(role)).toContain('Bash(gh pr merge *)');
    }
  });
});

describe('pure pieces', () => {
  const ok: MergeFacts = {
    prOpen: true,
    ci: { checks: 3, failing: [], pending: [] },
    techLeadVerdict: 'approve',
    storyStatus: 'In QA',
    testCases: { total: 2, notPassed: [] },
    designQa: 'na',
    human: { approved: true, reason: '' },
  };
  it('evaluateMerge: all good merges; each fact flipped alone names exactly its condition', () => {
    expect(evaluateMerge(ok)).toEqual([]);
    const flips: [Partial<MergeFacts>, Condition][] = [
      [{ prOpen: false }, 'pr_open'],
      [{ ci: { checks: 3, failing: ['x'], pending: [] } }, 'ci_green'],
      [{ ci: { checks: 3, failing: [], pending: ['y'] } }, 'ci_green'],
      [{ ci: { checks: 0, failing: [], pending: [] } }, 'ci_green'],
      [{ techLeadVerdict: 'changes_requested' }, 'tech_lead_approve'],
      [{ techLeadVerdict: undefined }, 'tech_lead_approve'],
      [{ storyStatus: 'Ready' }, 'story_in_qa'],
      [{ testCases: { total: 0, notPassed: [] } }, 'test_cases_pass'],
      [{ testCases: { total: 2, notPassed: ['TC-1'] } }, 'test_cases_pass'],
      [{ designQa: 'missing' }, 'design_qa'],
      [{ designQa: 'fail' }, 'design_qa'],
      [{ human: { approved: false, reason: 'no' } }, 'human_approval'],
    ];
    for (const [over, c] of flips)
      expect(
        evaluateMerge({ ...ok, ...over }).map((m) => m.condition),
        c,
      ).toEqual([c]);
    expect(evaluateMerge({ ...ok, designQa: 'pass' })).toEqual([]);
  });

  it('humanApprovers: only human po or sponsor with a github login', () => {
    expect(humanApprovers(validateProject(tempDirWith()).team!)).toEqual(['your-handle']);
    expect(
      humanApprovers({
        people: { a: { name: 'A', notion_user: 'x' } },
        roles: { po: { type: 'human', person: 'a' } },
      }),
    ).toEqual([]);
    expect(
      humanApprovers({
        people: { a: { name: 'A', notion_user: 'x', github: 'Alice' } },
        roles: { sponsor: { type: 'human', person: 'a' }, po: { type: 'agent' } },
      }),
    ).toEqual(['alice']);
  });

  it('humanApproval: the latest review of each person counts, logins are case-insensitive', () => {
    const r = (login: string, state: string, at: string, oid = SHA) => ({
      author: { login },
      state,
      commit: { oid },
      submittedAt: at,
    });
    expect(humanApproval([r('Your-Handle', 'APPROVED', '1')], SHA, ['your-handle']).approved).toBe(
      true,
    );
    expect(
      humanApproval(
        [r('your-handle', 'CHANGES_REQUESTED', '1'), r('your-handle', 'APPROVED', '2')],
        SHA,
        ['your-handle'],
      ).approved,
    ).toBe(true);
    expect(
      humanApproval(
        [r('your-handle', 'APPROVED', '1'), r('your-handle', 'CHANGES_REQUESTED', '2')],
        SHA,
        ['your-handle'],
      ).approved,
    ).toBe(false);
    expect(humanApproval([r('your-handle', 'APPROVED', '1')], SHA, []).reason).toMatch(
      /nobody can approve/,
    );
  });

  it('summariseChecks: success, neutral and skipped count as green; anything else does not', () => {
    const c = summariseChecks([
      { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'CheckRun', name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'd', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'e', status: 'QUEUED' },
      { __typename: 'StatusContext', context: 'f', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'g', state: 'ERROR' },
    ]);
    expect(c).toEqual({ checks: 7, failing: ['d', 'g'], pending: ['e', 'f'] });
  });
});

function tempDirWith(): string {
  const dir = tempDir('arima-team-');
  writeFileSync(path.join(dir, 'arima.yaml'), example('arima.yaml'));
  writeFileSync(path.join(dir, 'team.yaml'), example('team.yaml'));
  return dir;
}

describe('arima-merge', () => {
  const run = async (
    argv: string[],
    w: World,
    env: NodeJS.ProcessEnv = { ARIMA_GITHUB_TOKEN: 'ghp_t' },
  ) => {
    const r = { out: '', err: '' };
    const code = await runMergeCli(
      argv,
      { out: (s) => (r.out += s), err: (s) => (r.err += s), cwd: w.dir },
      { env, gh: w.gh },
    );
    return { code, ...r };
  };
  const args = ['--pr', '7', '--item', 'US-112', '--run-id', RUN];

  it('merges (0), refuses naming the condition (30), needs the token (14) and valid arguments (2)', async () => {
    const w = await world();
    const ok = await run(args, w);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ merged: true, pr: 7, sha: SHA });

    const w2 = await world();
    w2.pr.reviews = [];
    const no = await run(args, w2);
    expect(no.code).toBe(30);
    expect(no.err).toMatch(/human_approval/);

    expect((await run(args, await world(), {})).code).toBe(14);
    const w3 = await world();
    expect((await run([], w3)).code).toBe(2);
    expect((await run(['--pr', 'x', '--item', 'US-1', '--run-id', RUN], w3)).code).toBe(2);
    expect((await run(['--pr', '7', '--item', 'story', '--run-id', RUN], w3)).code).toBe(2);
    expect((await run(['--pr', '7', '--item', 'US-1'], w3)).err).toMatch(/--run-id is required/);
    expect(merged(w3)).toBe(false);
  });
});
