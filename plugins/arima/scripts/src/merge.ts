import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TeamConfig } from './config.js';
import { appendEvent, readEvents } from './events.js';
import { moveItem } from './item-status.js';
import { checkKillSwitch } from './killswitch.js';
import { findRow, readMirror } from './notion/mirror.js';
import { PublishError, ghRunner } from './publish.js';
import type { GhRunner } from './publish.js';
import type { ReasonCode } from './reasons.js';
import { removeWorktree } from './worktree.js';

/**
 * The merge script (spec 10.3, D-21, D-29, D-38; F08 5.3; WP-112): the only code that merges a
 * pull request. GitHub Free has no protected branches or required reviewers on private repos, so
 * ARIMA enforces the policy itself. It merges (squash, linear history) only when all four
 * conditions hold, each checked here and not taken on trust: green checks, the tech-lead's
 * `approve`, a QA pass recorded on the story, and a human's approving review of the CURRENT head.
 */

export const MERGE_EXIT = {
  ok: 0,
  usage: 2,
  killSwitch: 12,
  refused: 30,
  githubFailed: 32,
} as const;

export type Condition =
  | 'pr_open'
  | 'ci_green'
  | 'tech_lead_approve'
  | 'story_in_qa'
  | 'test_cases_pass'
  | 'design_qa'
  | 'human_approval'
  | 'gate_approved';

export interface MergeFacts {
  /** The PR is open, not a draft, targets the default branch. */
  prOpen: boolean;
  /** Names of checks that are not (yet) successful; `none` when the PR has no checks at all. */
  ci: { checks: number; failing: string[]; pending: string[] };
  /** `approve` is the only verdict that counts; undefined when there is none or it predates the last push. */
  techLeadVerdict: string | undefined;
  storyStatus: string | undefined;
  testCases: { total: number; notPassed: string[] };
  /** UI stories need a design-QA pass; `na` for a story with no screens. */
  designQa: 'pass' | 'fail' | 'missing' | 'na';
  human: { approved: boolean; reason: string };
  /** Baseline PRs (`chore/baseline-G<n>`): the gate has a recorded Approved decision. */
  baselineGate?: { gate: string; approved: boolean } | undefined;
}

export interface Missing {
  condition: Condition;
  detail: string;
}

/**
 * The decision, pure: which conditions are missing. A baseline PR (F04 RD-F04-9) replaces the QA
 * pass, the tech-lead verdict and the PR review with a recorded Approved gate decision; its checks
 * must still be green.
 */
export function evaluateMerge(f: MergeFacts): Missing[] {
  const miss: Missing[] = [];
  if (!f.prOpen)
    miss.push({
      condition: 'pr_open',
      detail: 'the pull request is not open, is a draft, or does not target the default branch',
    });
  if (f.ci.checks === 0)
    miss.push({
      condition: 'ci_green',
      detail: 'the pull request has no checks: nothing proves it is green',
    });
  else if (f.ci.failing.length + f.ci.pending.length > 0)
    miss.push({
      condition: 'ci_green',
      detail: [
        f.ci.failing.length ? `failing: ${f.ci.failing.join(', ')}` : '',
        f.ci.pending.length ? `not finished: ${f.ci.pending.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    });
  if (f.baselineGate !== undefined) {
    if (!f.baselineGate.approved)
      miss.push({
        condition: 'gate_approved',
        detail: `gate ${f.baselineGate.gate} has no recorded Approved decision`,
      });
    return miss;
  }
  if (f.techLeadVerdict !== 'approve')
    miss.push({
      condition: 'tech_lead_approve',
      detail:
        f.techLeadVerdict === undefined
          ? 'no tech-lead verdict after the last push'
          : `the tech-lead verdict is "${f.techLeadVerdict}", not approve`,
    });
  if (f.storyStatus !== 'In QA')
    miss.push({
      condition: 'story_in_qa',
      detail: `the story is "${f.storyStatus ?? 'unknown'}", not In QA`,
    });
  if (f.testCases.total === 0)
    miss.push({ condition: 'test_cases_pass', detail: 'the story has no test cases' });
  else if (f.testCases.notPassed.length > 0)
    miss.push({
      condition: 'test_cases_pass',
      detail: `not passed: ${f.testCases.notPassed.join(', ')}`,
    });
  if (f.designQa === 'fail' || f.designQa === 'missing')
    miss.push({
      condition: 'design_qa',
      detail: f.designQa === 'fail' ? 'design QA failed' : 'a UI story needs a design QA pass',
    });
  if (!f.human.approved) miss.push({ condition: 'human_approval', detail: f.human.reason });
  return miss;
}

// ---------------------------------------------------------------------------------------------
// Gathering the facts

interface PrJson {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviews: {
    author?: { login?: string };
    state: string;
    commit?: { oid?: string };
    submittedAt?: string;
  }[];
  statusCheckRollup: {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }[];
}

/** Logins that may approve: `team.yaml` people with the human role po or sponsor and a GitHub login. */
export function humanApprovers(team: Pick<TeamConfig, 'people' | 'roles'>): string[] {
  const out = new Set<string>();
  for (const role of ['po', 'sponsor']) {
    const r = team.roles[role];
    if (r?.type !== 'human' || r.person === undefined) continue;
    const login = team.people[r.person]?.github;
    if (login) out.add(login.toLowerCase());
  }
  return [...out];
}

const OK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export function summariseChecks(rollup: PrJson['statusCheckRollup']): MergeFacts['ci'] {
  const failing: string[] = [];
  const pending: string[] = [];
  for (const c of rollup) {
    const name = c.name ?? c.context ?? 'check';
    if (c.__typename === 'StatusContext' || c.state !== undefined) {
      if (c.state === 'SUCCESS') continue;
      (c.state === 'PENDING' || c.state === 'EXPECTED' ? pending : failing).push(name);
    } else if (c.status !== 'COMPLETED') pending.push(name);
    else if (!OK_CONCLUSIONS.has(c.conclusion ?? '')) failing.push(name);
  }
  return { checks: rollup.length, failing, pending };
}

/** At least one review by a listed human is APPROVED on the current head, and it is that human's latest. */
export function humanApproval(
  reviews: PrJson['reviews'],
  headSha: string,
  approvers: string[],
  machineAccount?: string,
): MergeFacts['human'] {
  const machine = machineAccount?.toLowerCase();
  const latest = new Map<string, PrJson['reviews'][number]>();
  for (const r of [...reviews].sort((a, b) =>
    (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''),
  )) {
    const login = r.author?.login?.toLowerCase();
    if (login === undefined || r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.set(login, r);
  }
  const listed = [...latest.entries()].filter(
    ([login]) => approvers.includes(login) && login !== machine,
  );
  if (approvers.length === 0)
    return {
      approved: false,
      reason: 'no po or sponsor in team.yaml has a github login, so nobody can approve',
    };
  const good = listed.find(([, r]) => r.state === 'APPROVED' && r.commit?.oid === headSha);
  if (good) return { approved: true, reason: '' };
  const stale = listed.find(([, r]) => r.state === 'APPROVED');
  if (stale)
    return {
      approved: false,
      reason: `${stale[0]} approved an earlier commit; the head changed since, so the approval must be given again`,
    };
  const changes = listed.find(
    ([, r]) => r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED',
  );
  if (changes)
    return { approved: false, reason: `${changes[0]}'s latest review is ${changes[1].state}` };
  return {
    approved: false,
    reason: `no approving review by ${approvers.join(' or ')} on the current head`,
  };
}

export interface MergeInput {
  projectDir: string;
  runId: string;
  pr: number;
  item: string;
  /** `github.repo`. */
  repo: string;
  defaultBranch: string;
  machineAccount?: string | undefined;
  team: Pick<TeamConfig, 'people' | 'roles'>;
  token?: string | undefined;
  gh?: GhRunner;
  isPaused?: () => Promise<boolean>;
}

export class MergeRefused extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly missing: Missing[] = [],
    readonly code?: ReasonCode,
  ) {
    super(message);
  }
}

const REASON: Partial<Record<Condition, ReasonCode>> = {
  ci_green: 'merge_refused_ci',
  tech_lead_approve: 'merge_refused_review',
  human_approval: 'merge_refused_review',
  gate_approved: 'merge_refused_review',
  story_in_qa: 'merge_refused_qa',
  test_cases_pass: 'merge_refused_qa',
  design_qa: 'merge_refused_qa',
};

/** The latest accepted report of a role and kind for an item, if it is newer than the last push of the branch. */
export function verdictAfterLastPush(
  projectDir: string,
  item: string,
  role: string,
  kind: string,
): string | undefined {
  const events = readEvents(projectDir);
  let lastPush = -1;
  let verdict: { at: number; result: string | undefined } | undefined;
  events.forEach((e, i) => {
    if (e.item !== item) return;
    if (e.type === 'pr.published') lastPush = i;
    if (e.type === 'report.accepted' && e.data?.['role'] === role && e.data?.['kind'] === kind)
      verdict = {
        at: i,
        result: typeof e.data['verdict'] === 'string' ? e.data['verdict'] : undefined,
      };
  });
  const v = verdict as { at: number; result: string | undefined } | undefined;
  return v !== undefined && v.at > lastPush ? v.result : undefined;
}

/** Everything a merge decision depends on, read from GitHub, the mirror and the event log. */
export function gatherFacts(i: MergeInput, pr: PrJson): MergeFacts {
  const baseline = /^chore\/baseline-(G[0-4])$/.exec(pr.headRefName);
  const prOpen = pr.state === 'OPEN' && !pr.isDraft && pr.baseRefName === i.defaultBranch;
  const ci = summariseChecks(pr.statusCheckRollup ?? []);
  const human = humanApproval(
    pr.reviews ?? [],
    pr.headRefOid,
    humanApprovers(i.team),
    i.machineAccount,
  );
  if (baseline) {
    const gate = findRow(readMirror(i.projectDir, 'gates'), baseline[1] as string);
    const status = gate?.properties['Status'];
    return {
      prOpen,
      ci,
      human,
      techLeadVerdict: undefined,
      storyStatus: undefined,
      testCases: { total: 0, notPassed: [] },
      designQa: 'na',
      baselineGate: {
        gate: baseline[1] as string,
        approved: status === 'Approved' || status === 'Approved with conditions',
      },
    };
  }
  const story = findRow(readMirror(i.projectDir, 'stories'), i.item);
  const caseIds = Array.isArray(story?.properties['Test Cases'])
    ? (story?.properties['Test Cases'] as string[])
    : [];
  const cases = readMirror(i.projectDir, 'test_cases');
  const notPassed = caseIds.filter(
    (id) => findRow(cases, id)?.properties['Last result'] !== 'Pass',
  );
  const ui = existsSync(path.join(i.projectDir, 'design', 'screens', i.item));
  const dq = verdictAfterLastPush(i.projectDir, i.item, 'ux', 'design-qa');
  return {
    prOpen,
    ci,
    human,
    techLeadVerdict: verdictAfterLastPush(i.projectDir, i.item, 'tech-lead', 'review'),
    storyStatus:
      typeof story?.properties['Status'] === 'string' ? story.properties['Status'] : undefined,
    testCases: { total: caseIds.length, notPassed },
    designQa: !ui ? 'na' : dq === 'pass' ? 'pass' : dq === undefined ? 'missing' : 'fail',
  };
}

/**
 * Merges a pull request when, and only when, every condition holds: squash only, and only if the
 * head is still the commit that was checked (`--match-head-commit`, so a push after the checks is
 * a refusal, not a merge of unreviewed code). Then moves the story In QA to PO Acceptance (engine)
 * and removes the worktree. Records `merge.done` or `merge.refused`. Writes no ledger row: it is
 * not a model run (RD-F08-6).
 */
export async function mergePr(i: MergeInput): Promise<{ sha: string; item: string }> {
  const paused = i.isPaused ? await i.isPaused() : (await checkKillSwitch(i.projectDir, null)).on;
  if (paused) {
    await appendEvent(i.projectDir, {
      type: 'hardstop.hit',
      actor: 'system',
      item: i.item,
      data: { stop: 'kill_switch', message: 'refusing to merge: the kill switch is on' },
    });
    throw new MergeRefused(
      'refusing to merge: the kill switch is on',
      MERGE_EXIT.killSwitch,
      [],
      'kill_switch',
    );
  }
  if (i.token === undefined || i.token === '')
    throw new PublishError(
      'the GitHub machine token is not set (github.machine_token_env)',
      14,
      'credential_missing',
    );
  const gh = i.gh ?? ghRunner;
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_TOKEN: i.token };
  const run = (args: string[]) => gh(args, { cwd: path.resolve(i.projectDir), env });

  const view = run([
    'pr',
    'view',
    String(i.pr),
    '--repo',
    i.repo,
    '--json',
    'number,state,isDraft,baseRefName,headRefName,headRefOid,reviews,statusCheckRollup',
  ]);
  if (view.code !== 0)
    throw new MergeRefused(
      `reading the pull request failed: ${(view.stderr || view.stdout).slice(0, 300)}`,
      MERGE_EXIT.githubFailed,
    );
  let pr: PrJson;
  try {
    pr = JSON.parse(view.stdout) as PrJson;
  } catch {
    throw new MergeRefused(
      'GitHub returned something that is not a pull request',
      MERGE_EXIT.githubFailed,
    );
  }

  const missing = evaluateMerge(gatherFacts(i, pr));
  if (missing.length > 0) {
    await appendEvent(i.projectDir, {
      type: 'merge.refused',
      actor: 'system',
      run_id: i.runId,
      item: i.item,
      data: {
        pr: i.pr,
        sha: pr.headRefOid,
        missing: missing.map((m) => m.condition),
        reasons: [...new Set(missing.map((m) => REASON[m.condition]).filter(Boolean))],
      },
    });
    throw new MergeRefused(
      `refusing to merge #${i.pr}: ${missing.map((m) => `${m.condition} (${m.detail})`).join('; ')}`,
      MERGE_EXIT.refused,
      missing,
      REASON[(missing[0] as Missing).condition],
    );
  }

  const merged = run([
    'pr',
    'merge',
    String(i.pr),
    '--repo',
    i.repo,
    '--squash',
    '--match-head-commit',
    pr.headRefOid,
  ]);
  if (merged.code !== 0) {
    const detail = (merged.stderr || merged.stdout).replaceAll(i.token, '***').slice(0, 300);
    await appendEvent(i.projectDir, {
      type: 'merge.refused',
      actor: 'system',
      run_id: i.runId,
      item: i.item,
      data: { pr: i.pr, sha: pr.headRefOid, github: detail },
    });
    throw new MergeRefused(`GitHub refused the merge: ${detail}`, MERGE_EXIT.githubFailed);
  }
  await appendEvent(i.projectDir, {
    type: 'merge.done',
    actor: 'system',
    run_id: i.runId,
    item: i.item,
    data: { pr: i.pr, sha: pr.headRefOid, branch: pr.headRefName },
  });

  const baseline = /^chore\/baseline-G[0-4]$/.test(pr.headRefName);
  if (!baseline && /^US-\d+$/.test(i.item)) {
    // QA pass and human approval are exactly the guards of In QA -> PO Acceptance (contracts section 9).
    await moveItem({
      projectDir: i.projectDir,
      item: i.item,
      to: 'PO Acceptance',
      actor: 'merge-script',
      runId: i.runId,
      facts: { guards: { all_tests_passed: true, design_qa_ok: true, human_pr_approved: true } },
    });
  }
  await removeWorktree({
    projectDir: i.projectDir,
    branch: pr.headRefName,
    defaultBranch: i.defaultBranch,
  }).catch(() => undefined);
  return { sha: pr.headRefOid, item: i.item };
}
