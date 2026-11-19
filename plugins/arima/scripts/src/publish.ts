import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { findAttribution } from './attribution.js';
import { appendEvent } from './events.js';
import { isProtectedConfigPath, isProtectedStatePath } from './hooks.js';
import { checkKillSwitch } from './killswitch.js';
import type { Role } from './ledger.js';
import { findSecrets, loadSecretAllowlist } from './lib/secrets.js';
import { enqueue, outboxDir } from './notion/outbox.js';
import type { ReasonCode } from './reasons.js';
import { validatePrBody } from './pr-body.js';
import { githubSlug } from './state.js';
import { BRANCH, worktreePath } from './worktree.js';

/**
 * The host publish script (spec 10.3, D-37, D-49; F08 5.2; WP-111). It is the only code that pushes
 * a story branch and opens its pull request, and the only code that posts a role's review
 * comments. No role holds a GitHub credential or runs `gh`: a developer run cannot reach the
 * default branch even by writing its own script, because the branch is pushed here, from a checked
 * diff, with a token that exists only in this process.
 */

export const PUBLISH_EXIT = {
  ok: 0,
  usage: 2,
  killSwitch: 12,
  env: 14,
  refused: 31,
  pushFailed: 32,
} as const;

export class PublishError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code?: ReasonCode,
  ) {
    super(message);
  }
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs the GitHub CLI. Tests inject a stub; the real one is `ghRunner`. */
export type GhRunner = (
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) => GhResult;

export const ghRunner: GhRunner = (args, o) => {
  const r = spawnSync('gh', args, { cwd: o.cwd, env: o.env, input: o.input, encoding: 'utf8' });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : ''),
  };
};

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    throw new Error(
      `git ${args[0]} failed: ${(err.stderr ? String(err.stderr) : err.message).trim()}`,
      { cause: e },
    );
  }
}

export interface PublishInput {
  projectDir: string;
  /** The engine run publishing (needs a `run.start` event: the PR link goes through the outbox). */
  runId: string;
  branch: string;
  item: string;
  /** The role whose work this is: its protected-path and QA rules apply. */
  role: Role;
  title: string;
  /** The pull request body (see `renderPrBody`). */
  body: string;
  /**
   * The criterion ids of the developer's `criteria_map`. When given, the body must pass the DoD
   * check (`validatePrBody`): every section, every criterion mapped with evidence, a screenshot
   * for a UI story (`ui`).
   */
  criteria?: string[];
  ui?: boolean;
  type?: 'story' | 'bug' | 'hotfix' | 'chore';
  /** `github.repo` from arima.yaml: owner/name. */
  repo: string;
  defaultBranch: string;
  stateBranch?: string;
  /** Overrides the push URL (tests). Anything but github.com needs `allowUncheckedRemote`. */
  remoteUrl?: string;
  allowUncheckedRemote?: boolean;
  /** The machine-account token; required to push to github.com. Never written anywhere. */
  token?: string | undefined;
  gh?: GhRunner;
  /** Kill switch check; defaults to the local PAUSE file (the dispatcher passes the full check). */
  isPaused?: () => Promise<boolean>;
}

export interface Published {
  pr: number;
  url: string;
  sha: string;
  created: boolean;
}

const MAX_DIFF = 5_000_000;

/** The environment for the git push: the token only as a one-off header, never in the URL or argv. */
export function pushEnv(token: string | undefined, github: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (github && token !== undefined) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = 'http.https://github.com/.extraheader';
    env['GIT_CONFIG_VALUE_0'] = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

const ghEnv = (token: string | undefined): NodeJS.ProcessEnv => ({
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  ...(token !== undefined ? { GH_TOKEN: token } : {}),
});

const redact = (s: string, token: string | undefined): string => {
  let out = s;
  if (token) out = out.split(token).join('***');
  return out.slice(0, 600);
};

async function refuseIfPaused(i: PublishInput): Promise<void> {
  const paused = i.isPaused ? await i.isPaused() : (await checkKillSwitch(i.projectDir, null)).on;
  if (!paused) return;
  await appendEvent(i.projectDir, {
    type: 'hardstop.hit',
    actor: 'system',
    ...(i.item !== 'none' ? { item: i.item } : {}),
    data: { stop: 'kill_switch', message: 'refusing to publish: the kill switch is on' },
  });
  throw new PublishError(
    'refusing to publish: the kill switch is on',
    PUBLISH_EXIT.killSwitch,
    'kill_switch',
  );
}

/**
 * Checks the branch the way a reviewer would before it leaves the machine (F08 5.2 steps 1 to 3):
 * on the expected branch, clean tree, something to publish, no protected path, no secret, no AI
 * attribution, and the role's own scope (QA only under `tests/`, never the developer under
 * `tests/e2e/`). Returns the worktree path and head sha.
 */
export function checkBranch(i: PublishInput): { dir: string; sha: string; files: string[] } {
  const refuse = (m: string, code?: ReasonCode): never => {
    throw new PublishError(m, PUBLISH_EXIT.refused, code);
  };
  if (!BRANCH.test(i.branch) || i.branch.includes('..'))
    refuse(
      `"${i.branch}" is not a branch ARIMA publishes (feat/, fix/, hotfix/, chore/ or qa/ ...)`,
    );
  if ([i.defaultBranch, i.stateBranch ?? 'arima-state', 'main', 'master'].includes(i.branch))
    refuse(`"${i.branch}" is a protected branch; it is never published from here`, 'guard_blocked');
  const dir = worktreePath(i.projectDir, i.branch);
  if (!existsSync(dir)) refuse(`there is no worktree for ${i.branch} at ${dir}`);
  const head = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head !== i.branch) refuse(`the worktree is on "${head}", not ${i.branch}`);
  if (git(dir, ['status', '--porcelain']) !== '')
    refuse('the worktree has uncommitted changes: agents commit; this script does not');
  const files = git(dir, ['diff', '--name-only', `${i.defaultBranch}...${i.branch}`])
    .split('\n')
    .filter(Boolean);
  if (files.length === 0) refuse(`${i.branch} has no changes against ${i.defaultBranch}`);

  const bad = files.filter((f) => isProtectedConfigPath(f, i.role) || isProtectedStatePath(f));
  if (bad.length > 0)
    refuse(
      `the branch changes protected paths: ${bad.join(', ')} (CI, hooks, config and state are not an agent's to change)`,
      'protected_path',
    );
  if (i.role === 'qa') {
    const outside = files.filter((f) => !f.startsWith('tests/'));
    if (outside.length > 0)
      refuse(
        `QA may change only tests/**; this branch changes ${outside.join(', ')}`,
        'protected_path',
      );
  }
  if (i.role === 'developer') {
    const e2e = files.filter((f) => f.startsWith('tests/e2e/'));
    if (e2e.length > 0)
      refuse(
        `the developer may not change tests/e2e/** (QA's): ${e2e.join(', ')}`,
        'protected_path',
      );
  }

  const diff = git(dir, ['diff', `${i.defaultBranch}...${i.branch}`]).slice(0, MAX_DIFF);
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  const leaked = findSecrets(added, loadSecretAllowlist(i.projectDir));
  if (leaked.length > 0)
    refuse(
      `the branch adds something that looks like a secret (${leaked.join(', ')})`,
      'secret_in_output',
    );

  const messages = git(dir, ['log', `${i.defaultBranch}..${i.branch}`, '--format=%B']);
  const attr = findAttribution(messages);
  if (attr.length > 0)
    refuse(
      `a commit message on the branch contains ${attr.join(' and ')} (D-48: no AI attribution)`,
    );
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']), files };
}

const typeOf = (item: string, t?: string): string =>
  t ??
  (item.startsWith('BUG-')
    ? 'bug'
    : item.startsWith('INC-')
      ? 'hotfix'
      : item.startsWith('US-')
        ? 'story'
        : 'chore');

/**
 * Publishes a story branch: checks it, pushes `<branch>:<branch>` (no force, no other ref) to the
 * GitHub URL built from config, opens or updates its pull request, records `pr.published` and
 * queues the story's `PR link`. Idempotent: publishing again updates the PR instead of
 * duplicating it.
 */
export async function publishBranch(i: PublishInput): Promise<Published> {
  await refuseIfPaused(i);
  if (findAttribution(`${i.title}\n${i.body}`).length > 0)
    throw new PublishError(
      'the pull request title or body contains AI attribution (D-48)',
      PUBLISH_EXIT.refused,
    );
  const leakedBody = findSecrets(`${i.title}\n${i.body}`, loadSecretAllowlist(i.projectDir));
  if (leakedBody.length > 0)
    throw new PublishError(
      `the pull request text looks like it contains a secret (${leakedBody.join(', ')})`,
      PUBLISH_EXIT.refused,
      'secret_in_output',
    );
  if (i.criteria !== undefined) {
    const check = validatePrBody(i.body, {
      criteria: i.criteria,
      ...(i.ui !== undefined ? { ui: i.ui } : {}),
    });
    if (!check.ok)
      throw new PublishError(
        `the pull request body fails the DoD check: ${check.problems.join('; ')}`,
        PUBLISH_EXIT.refused,
      );
  }
  const { dir, sha } = checkBranch(i);

  const url = i.remoteUrl ?? `https://github.com/${i.repo}.git`;
  const slug = githubSlug(url);
  if (slug === undefined && i.allowUncheckedRemote !== true)
    throw new PublishError(
      `the remote is not a github.com repository, so ARIMA cannot check what it is; set github.allow_unchecked_remote: true in arima.yaml if you accept that`,
      PUBLISH_EXIT.pushFailed,
      'remote_unchecked',
    );
  if (slug !== undefined && `${slug.owner}/${slug.repo}`.toLowerCase() !== i.repo.toLowerCase())
    throw new PublishError(
      `the push URL names ${slug.owner}/${slug.repo}, but arima.yaml says ${i.repo}`,
      PUBLISH_EXIT.refused,
    );
  if (slug !== undefined && (i.token === undefined || i.token === ''))
    throw new PublishError(
      'the GitHub machine token is not set (github.machine_token_env)',
      PUBLISH_EXIT.env,
      'credential_missing',
    );

  try {
    git(
      dir,
      ['push', url, `refs/heads/${i.branch}:refs/heads/${i.branch}`],
      pushEnv(i.token, slug !== undefined),
    );
  } catch (e) {
    throw new PublishError(
      `push refused: ${redact(e instanceof Error ? e.message : String(e), i.token)}`,
      PUBLISH_EXIT.pushFailed,
    );
  }

  const gh = i.gh ?? ghRunner;
  const env = ghEnv(i.token);
  const run = (args: string[], input?: string): GhResult =>
    gh(args, { cwd: dir, env, ...(input !== undefined ? { input } : {}) });
  const fail = (what: string, r: GhResult): never => {
    throw new PublishError(
      `${what} failed: ${redact(r.stderr || r.stdout, i.token)}`,
      PUBLISH_EXIT.pushFailed,
    );
  };

  const title = `${i.item}: ${i.title}`;
  const labels = [`role:${i.role}`, `type:${typeOf(i.item, i.type)}`];
  for (const l of labels) run(['label', 'create', l, '--force', '--repo', i.repo]); // best effort
  const listed = run([
    'pr',
    'list',
    '--repo',
    i.repo,
    '--head',
    i.branch,
    '--state',
    'open',
    '--json',
    'number,url',
  ]);
  if (listed.code !== 0) fail('listing pull requests', listed);
  let existing: { number: number; url: string }[] = [];
  try {
    existing = JSON.parse(listed.stdout || '[]') as { number: number; url: string }[];
  } catch {
    fail('reading the pull request list', listed);
  }

  let pr: number;
  let prUrl: string;
  let created = false;
  const found = existing[0];
  if (found !== undefined) {
    const r = run(
      ['pr', 'edit', String(found.number), '--repo', i.repo, '--title', title, '--body-file', '-'],
      i.body,
    );
    if (r.code !== 0) fail('updating the pull request', r);
    pr = found.number;
    prUrl = found.url;
  } else {
    const r = run(
      [
        'pr',
        'create',
        '--repo',
        i.repo,
        '--head',
        i.branch,
        '--base',
        i.defaultBranch,
        '--title',
        title,
        '--body-file',
        '-',
        ...labels.flatMap((l) => ['--label', l]),
      ],
      i.body,
    );
    if (r.code !== 0) fail('opening the pull request', r);
    const m = /(https?:\/\/\S+\/pull\/(\d+))/.exec(r.stdout);
    if (!m) fail('reading the new pull request url', r);
    prUrl = (m as RegExpExecArray)[1] as string;
    pr = Number((m as RegExpExecArray)[2]);
    created = true;
  }

  await appendEvent(i.projectDir, {
    type: 'pr.published',
    actor: 'system',
    run_id: i.runId,
    ...(i.item !== 'none' ? { item: i.item } : {}),
    data: { pr, url: prUrl, sha, branch: i.branch, created },
  });
  if (/^US-\d+$/.test(i.item)) {
    const taken = new Set(
      existsSync(outboxDir(i.projectDir)) ? readdirSync(outboxDir(i.projectDir)) : [],
    );
    let n = 1;
    while (taken.has(`pub-${i.runId}-${i.item}-${n}.json`)) n += 1;
    enqueue(i.projectDir, {
      id: `pub-${i.runId}-${i.item}-${n}`,
      created_at: new Date().toISOString(),
      run_id: i.runId,
      role: 'orchestrator',
      op: 'update',
      database: 'stories',
      item_id: i.item,
      properties: { 'PR link': prUrl },
    });
  }
  return { pr, url: prUrl, sha, created };
}

// ---------------------------------------------------------------------------------------------
// Review comments: the roles "talk" on the PR without a credential

export interface ReviewFinding {
  severity: string;
  location: string;
  claim: string;
  evidence: string;
  recommendation: string;
  refutation?: string;
}

export interface ReviewInput {
  projectDir: string;
  role: Role;
  item: string;
  pr: number;
  repo: string;
  findings: ReviewFinding[];
  verdict?: { result: string; reasons: string[] } | undefined;
  token?: string | undefined;
  gh?: GhRunner;
  isPaused?: () => Promise<boolean>;
}

const LOCATION = /^([A-Za-z0-9_@. /-]+):(\d+)$/;

/** The body and inline comments of one COMMENT review; findings with a `file:line` become inline comments. */
export function buildReview(i: Pick<ReviewInput, 'role' | 'item' | 'findings' | 'verdict'>): {
  event: 'COMMENT';
  body: string;
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[];
} {
  const text = (f: ReviewFinding): string =>
    `**${f.severity}**: ${f.claim}\n\nEvidence: ${f.evidence}\n\nRecommendation: ${f.recommendation}${f.refutation ? `\n\nChecked: ${f.refutation}` : ''}`;
  const comments: { path: string; line: number; side: 'RIGHT'; body: string }[] = [];
  const general: ReviewFinding[] = [];
  for (const f of i.findings) {
    const m = LOCATION.exec(f.location);
    if (m && !(m[1] as string).includes('..') && !(m[1] as string).startsWith('/'))
      comments.push({ path: m[1] as string, line: Number(m[2]), side: 'RIGHT', body: text(f) });
    else general.push(f);
  }
  const head = `${i.role} review of ${i.item}${i.verdict ? `: ${i.verdict.result.replaceAll('_', ' ')}` : ''}`;
  const reasons = i.verdict?.reasons.map((r) => `- ${r}`).join('\n') ?? '';
  const rest = general
    .map((f) => `- \`${f.location}\`: ${text(f).replaceAll('\n\n', ' ')}`)
    .join('\n');
  // Always a COMMENT: only a human approves or requests changes (spec 10.3, D-21).
  return { event: 'COMMENT', body: [head, reasons, rest].filter(Boolean).join('\n\n'), comments };
}

/**
 * Posts a role's findings and verdict as ONE `COMMENT` review with the machine token. Never an
 * approval and never a change request, whatever the verdict says: approval is the human's.
 */
export async function postReview(i: ReviewInput): Promise<{ posted: number; inline: number }> {
  const paused = i.isPaused ? await i.isPaused() : (await checkKillSwitch(i.projectDir, null)).on;
  if (paused)
    throw new PublishError(
      'refusing to post: the kill switch is on',
      PUBLISH_EXIT.killSwitch,
      'kill_switch',
    );
  if (i.token === undefined || i.token === '')
    throw new PublishError(
      'the GitHub machine token is not set (github.machine_token_env)',
      PUBLISH_EXIT.env,
      'credential_missing',
    );
  const review = buildReview(i);
  const payload = JSON.stringify(review);
  // Scan the text the way a reader sees it (one line each), not the JSON, where a trailer is not at a line start.
  const readable = [review.body, ...review.comments.map((c) => c.body)].join('\n');
  if (findAttribution(readable).length > 0)
    throw new PublishError('the review contains AI attribution (D-48)', PUBLISH_EXIT.refused);
  const leaked = findSecrets(payload, loadSecretAllowlist(i.projectDir));
  if (leaked.length > 0)
    throw new PublishError(
      `the review looks like it contains a secret (${leaked.join(', ')})`,
      PUBLISH_EXIT.refused,
      'secret_in_output',
    );
  const gh = i.gh ?? ghRunner;
  const call = (body: string): GhResult =>
    gh(['api', `repos/${i.repo}/pulls/${i.pr}/reviews`, '--method', 'POST', '--input', '-'], {
      cwd: path.resolve(i.projectDir),
      env: ghEnv(i.token),
      input: body,
    });
  let r = call(payload);
  if (r.code !== 0 && review.comments.length > 0) {
    // An inline anchor GitHub cannot place (a line outside the diff): say it all in the body instead.
    const flat = buildReview({
      ...i,
      findings: i.findings.map((f) => ({ ...f, location: f.location.replace(':', ' line ') })),
    });
    r = call(JSON.stringify(flat));
    if (r.code === 0) return { posted: 1, inline: 0 };
  }
  if (r.code !== 0)
    throw new PublishError(
      `posting the review failed: ${redact(r.stderr || r.stdout, i.token)}`,
      PUBLISH_EXIT.pushFailed,
    );
  return { posted: 1, inline: review.comments.length };
}
