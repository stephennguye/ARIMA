import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent } from './events.js';
import { parseAllowlist, scanSecrets } from './lib/secrets.js';

export class StateError extends Error {}

export interface StateOptions {
  /** The app repo (the directory that contains `.arima/`). */
  projectDir: string;
  /** Orphan branch that holds `.arima/`. Never the default branch. */
  branch?: string;
  /** The app's default branch; the state branch must differ from it. */
  defaultBranch?: string;
  remote?: string;
  /** Allow pushing state (client data) to a PUBLIC GitHub repository. Off unless the owner opts in. */
  allowPublic?: boolean;
  /** Tells whether a GitHub repo is private; defaults to asking `gh`. Tests inject this. */
  isPrivate?: (owner: string, repo: string) => boolean | undefined;
}

const DEFAULT_BRANCH = 'arima-state';
const STATE_GITIGNORE = '*.lock\n*.tmp\nrun.lock\n';
const STATE_GITATTRIBUTES = '* -text\n';
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

function git(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const detail = (err.stderr ? String(err.stderr) : err.message).trim();
    throw new StateError(`git ${args.join(' ')} failed: ${detail}`, { cause: e });
  }
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Identity for commits we create ourselves, only if git has none configured. */
function identityArgs(cwd: string): string[] {
  const has = (key: string): boolean => {
    try {
      return execFileSync('git', ['config', key], { cwd, encoding: 'utf8' }).trim() !== '';
    } catch {
      return false;
    }
  };
  return has('user.name') && has('user.email')
    ? []
    : ['-c', 'user.name=ARIMA', '-c', 'user.email=arima@users.noreply.github.com'];
}

interface Resolved {
  repo: string;
  stateDir: string;
  branch: string;
  remote: string;
  hasRemote: boolean;
}

function resolve(o: StateOptions): Resolved {
  const repo = path.resolve(o.projectDir);
  if (!existsSync(repo) || !gitOk(repo, ['rev-parse', '--git-dir'])) {
    throw new StateError(`${repo} is not a git repository`);
  }
  // .arima/ belongs at the repo root; a project dir nested in some other repo is a mistake.
  const norm = (p: string): string => {
    const real = realpathSync.native(p);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  if (norm(git(repo, ['rev-parse', '--show-toplevel'])) !== norm(repo)) {
    throw new StateError(`${repo} is not the root of a git repository`);
  }
  const branch = o.branch ?? DEFAULT_BRANCH;
  if (branch === (o.defaultBranch ?? 'main') || branch === 'main' || branch === 'master') {
    throw new StateError(
      `refusing to use "${branch}" as the state branch; ARIMA never touches the default branch`,
    );
  }
  const remote = o.remote ?? 'origin';
  const hasRemote = git(repo, ['remote']).split('\n').includes(remote);
  return { repo, stateDir: path.join(repo, '.arima'), branch, remote, hasRemote };
}

function excludeArima(repo: string): void {
  const rel = git(repo, ['rev-parse', '--git-path', 'info/exclude']);
  const file = path.resolve(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('/.arima/')) {
    appendFileSync(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}/.arima/\n`);
  }
}

const isWorktree = (stateDir: string): boolean => existsSync(path.join(stateDir, '.git'));
const isEmptyDir = (dir: string): boolean => !existsSync(dir) || readdirSync(dir).length === 0;

function localBranchExists(r: Resolved): boolean {
  return gitOk(r.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${r.branch}`]);
}

function remoteBranchExists(r: Resolved): boolean {
  return gitOk(r.repo, ['show-ref', '--verify', '--quiet', `refs/remotes/${r.remote}/${r.branch}`]);
}

/** Creates the state branch as an orphan with one initial commit, using plumbing only. */
function createOrphanBranch(r: Resolved): void {
  const tree = git(r.repo, ['mktree'], '');
  const commit = git(r.repo, [
    ...identityArgs(r.repo),
    'commit-tree',
    tree,
    '-m',
    'chore(state): initialise arima-state',
  ]);
  git(r.repo, ['branch', r.branch, commit]);
}

/**
 * Makes `.arima/` a git worktree of the state branch, creating the branch if it does not exist
 * anywhere. Existing local files in `.arima/` are preserved when the branch is new; if the branch
 * already exists elsewhere and `.arima/` has files, it stops rather than risk overwriting them.
 */
function ensureWorktree(r: Resolved): void {
  excludeArima(r.repo);
  if (r.hasRemote) {
    try {
      git(r.repo, ['fetch', r.remote, `${r.branch}:refs/remotes/${r.remote}/${r.branch}`]);
    } catch {
      /* the remote may not have the branch yet; that is fine */
    }
  }
  if (isWorktree(r.stateDir)) {
    const head = git(r.stateDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head !== r.branch)
      throw new StateError(`.arima/ is on branch "${head}", expected "${r.branch}"`);
    return;
  }

  const exists = localBranchExists(r) || remoteBranchExists(r);
  const hasFiles = !isEmptyDir(r.stateDir);
  if (exists && hasFiles) {
    throw new StateError(
      `.arima/ already has files but is not the "${r.branch}" worktree, and that branch already exists. ` +
        'Move .arima/ aside (or delete it if it is disposable) and run again.',
    );
  }
  if (!exists) createOrphanBranch(r);

  let aside: string | undefined;
  if (hasFiles) {
    aside = mkdtempSync(path.join(tmpdir(), 'arima-state-'));
    cpSync(r.stateDir, aside, { recursive: true });
    rmSync(r.stateDir, { recursive: true, force: true });
  }
  try {
    if (!localBranchExists(r)) {
      git(r.repo, ['branch', '--track', r.branch, `${r.remote}/${r.branch}`]);
    }
    git(r.repo, ['worktree', 'add', r.stateDir, r.branch]);
  } finally {
    if (aside !== undefined) {
      mkdirSync(r.stateDir, { recursive: true });
      cpSync(aside, r.stateDir, { recursive: true, force: false, errorOnExist: false });
      rmSync(aside, { recursive: true, force: true });
    }
  }
}

function ensureStateFiles(r: Resolved): void {
  const write = (name: string, body: string): void => {
    const file = path.join(r.stateDir, name);
    if (!existsSync(file)) writeFileSync(file, body, 'utf8');
  };
  write('.gitignore', STATE_GITIGNORE);
  write('.gitattributes', STATE_GITATTRIBUTES);
}

export interface PullResult {
  updated: boolean;
  head: string;
}

/** Brings `.arima/` up to date with the remote state branch (fast-forward only). */
export async function pullState(o: StateOptions): Promise<PullResult> {
  const r = resolve(o);
  ensureWorktree(r);
  const before = git(r.stateDir, ['rev-parse', 'HEAD']);
  if (r.hasRemote && remoteBranchExists(r)) {
    const remoteRef = `refs/remotes/${r.remote}/${r.branch}`;
    if (!gitOk(r.stateDir, ['merge-base', '--is-ancestor', 'HEAD', remoteRef])) {
      const ahead = gitOk(r.stateDir, ['merge-base', '--is-ancestor', remoteRef, 'HEAD']);
      if (!ahead) {
        throw new StateError(
          `local and remote "${r.branch}" have diverged; resolve by hand (state is written by one runner at a time)`,
        );
      }
    } else {
      git(r.stateDir, ['merge', '--ff-only', remoteRef]);
    }
  }
  const head = git(r.stateDir, ['rev-parse', 'HEAD']);
  await appendEvent(r.repo, {
    type: 'state.pull',
    actor: 'system',
    data: { branch: r.branch, updated: head !== before },
  });
  return { updated: head !== before, head };
}

export interface PushResult {
  committed: boolean;
  pushed: boolean;
  commit?: string;
  files: number;
  warnings: string[];
}

/** One thing in a staged file that stops the commit. */
interface StagedProblem {
  file: string;
  rule: string;
  fingerprint?: string;
}

/**
 * Staged files (relative to `.arima/`) that look like they contain a credential, or are too big
 * to scan. A human may allow a reviewed false alarm by adding its fingerprint to
 * `.arima/secret-allowlist.txt` (agents cannot write that file).
 */
function scanStaged(r: Resolved): StagedProblem[] {
  const names = git(r.stateDir, ['diff', '--cached', '--name-only', '--diff-filter=AM'])
    .split('\n')
    .filter(Boolean);
  const allowFile = path.join(r.stateDir, 'secret-allowlist.txt');
  const allowed = existsSync(allowFile)
    ? parseAllowlist(readFileSync(allowFile, 'utf8'))
    : new Set<string>();
  const bad: StagedProblem[] = [];
  for (const name of names) {
    const file = path.join(r.stateDir, name);
    try {
      if (statSync(file).size > MAX_SCAN_BYTES) {
        bad.push({ file: name, rule: 'file too large to scan for secrets' });
        continue;
      }
      for (const f of scanSecrets(readFileSync(file, 'utf8'), allowed)) {
        bad.push({ file: name, rule: f.rule, fingerprint: f.fingerprint });
      }
    } catch {
      /* deleted or unreadable: nothing to scan */
    }
  }
  return bad;
}

/**
 * Commits everything in `.arima/` as ONE commit whose message carries the run id, then pushes the
 * state branch. Refuses to commit anything that looks like a secret. Never touches the default
 * branch. Returns committed=false when nothing changed.
 */
export async function pushState(o: StateOptions & { runId: string }): Promise<PushResult> {
  if (!/^r-\d{8}-\d{4}-\d{2,}$/.test(o.runId)) {
    throw new StateError(`run id "${o.runId}" does not look like r-YYYYMMDD-HHMM-NN`);
  }
  const r = resolve(o);
  ensureWorktree(r);
  ensureStateFiles(r);
  await appendEvent(r.repo, {
    type: 'state.push',
    actor: 'system',
    run_id: o.runId,
    data: { branch: r.branch },
  });

  git(r.stateDir, ['add', '-A']);
  const staged = git(r.stateDir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (staged.length === 0) {
    return { committed: false, pushed: false, files: 0, warnings: [] };
  }
  const bad = scanStaged(r);
  if (bad.length > 0) {
    git(r.stateDir, ['reset', '-q']);
    const lines = bad.map(
      (p) => `  ${p.file}: ${p.rule}${p.fingerprint ? ` (${p.fingerprint})` : ''}`,
    );
    throw new StateError(
      `refusing to commit state: ${bad.length} finding(s) that look like secrets:\n${lines.join('\n')}\nIf you have reviewed a finding and it is NOT a secret, add its fingerprint on its own line to .arima/secret-allowlist.txt and run again.`,
    );
  }
  git(r.stateDir, [
    ...identityArgs(r.stateDir),
    'commit',
    '-q',
    '-m',
    `chore(state): run ${o.runId}`,
  ]);
  const commit = git(r.stateDir, ['rev-parse', 'HEAD']);

  let pushed = false;
  const warnings: string[] = [];
  if (r.hasRemote) {
    // The state branch holds the Notion mirror: client names, requirements, costs. It must go only
    // to a private repository (spec §9.4, §11.3).
    const privacy = checkRemotePrivacy(r, o);
    if (privacy.kind === 'public' && o.allowPublic !== true) {
      throw new StateError(
        `refusing to push state: ${privacy.slug} is a PUBLIC GitHub repository, and the state branch holds your Notion data (requirements, client names, costs). Make the repository private, or set github.allow_public_state: true in arima.yaml if you really mean it.`,
      );
    }
    if (privacy.kind === 'unknown' && o.allowPublic !== true) {
      throw new StateError(
        `refusing to push state: could not check whether ${privacy.slug} is private (is the gh CLI installed and signed in, and is the remote a normal github.com repository?). The state branch holds your Notion data, so ARIMA refuses when it cannot be sure. Sign in with 'gh auth login' and run again, or set github.allow_public_state: true in arima.yaml if you accept the risk.`,
      );
    }
    git(r.stateDir, ['push', '--set-upstream', r.remote, `${r.branch}:${r.branch}`]);
    pushed = true;
  }
  return { committed: true, pushed, commit, files: staged.length, warnings };
}

export interface StateStatus {
  worktree: boolean;
  branch: string;
  dirty: boolean;
  ahead: number;
}

export function stateStatus(o: StateOptions): StateStatus {
  const r = resolve(o);
  if (!isWorktree(r.stateDir)) return { worktree: false, branch: r.branch, dirty: false, ahead: 0 };
  const dirty = git(r.stateDir, ['status', '--porcelain']) !== '';
  let ahead = 0;
  if (r.hasRemote && remoteBranchExists(r)) {
    ahead = Number(
      git(r.stateDir, ['rev-list', '--count', `refs/remotes/${r.remote}/${r.branch}..HEAD`]),
    );
  }
  return { worktree: true, branch: r.branch, dirty, ahead };
}

/**
 * Whether the PAUSE file exists on the remote state branch (spec §11.3: the kill switch must be
 * readable from the state branch when Notion is unreachable). Fetches with a short timeout and
 * never prompts. Returns true or false, or undefined if the answer could not be obtained (no git
 * repo, no remote, or the network is down).
 */
export function remotePauseFlag(o: StateOptions): boolean | undefined {
  let r: Resolved;
  try {
    r = resolve(o);
  } catch {
    return undefined;
  }
  if (!r.hasRemote) return undefined;
  const ref = `refs/remotes/${r.remote}/${r.branch}`;
  try {
    execFileSync('git', ['fetch', '--quiet', r.remote, `+refs/heads/${r.branch}:${ref}`], {
      cwd: r.repo,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (e) {
    // A remote that simply has no state branch yet has no PAUSE file either.
    const msg = String((e as { stderr?: unknown }).stderr ?? '');
    if (!/couldn't find remote ref/i.test(msg)) return undefined;
    return false;
  }
  return gitOk(r.repo, ['cat-file', '-e', `${ref}:PAUSE`]);
}

type Privacy = { kind: 'private' | 'public' | 'unknown'; slug: string } | { kind: 'not-github' };

/** owner/repo from a GitHub remote URL (https or ssh), or undefined for any other remote. */
const SLUG_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * owner/repo from a GitHub remote URL (https or ssh), or undefined for any other remote, or for a
 * github.com URL whose owner or repo contains characters GitHub does not allow (so that a hostile
 * remote URL can never become an option to the gh CLI).
 */
export function githubSlug(url: string): { owner: string; repo: string } | undefined {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  if (!m) return undefined;
  const owner = m[1] as string;
  const repo = m[2] as string;
  if (!SLUG_PART.test(owner) || !SLUG_PART.test(repo) || repo === '.' || repo === '..') {
    return undefined;
  }
  return { owner, repo };
}

/** A URL that points at github.com in any form, valid or not. */
const MENTIONS_GITHUB = /(^|[/@:])github\.com[/:]/i;

function checkRemotePrivacy(r: Resolved, o: StateOptions): Privacy {
  let url: string;
  try {
    url = git(r.repo, ['config', '--get', 'remote.' + r.remote + '.url']);
  } catch {
    return { kind: 'not-github' };
  }
  const slug = githubSlug(url);
  if (slug === undefined) {
    // A github.com URL we cannot parse safely is not "somewhere else": refuse rather than guess.
    return MENTIONS_GITHUB.test(url)
      ? { kind: 'unknown', slug: 'the remote' }
      : { kind: 'not-github' };
  }
  const name = `${slug.owner}/${slug.repo}`;
  let priv: boolean | undefined;
  if (o.isPrivate) {
    priv = o.isPrivate(slug.owner, slug.repo);
  } else {
    try {
      const out = execFileSync(
        'gh',
        ['repo', 'view', name, '--json', 'isPrivate', '--jq', '.isPrivate'],
        { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      priv = out === 'true' ? true : out === 'false' ? false : undefined;
    } catch {
      priv = undefined;
    }
  }
  return { kind: priv === undefined ? 'unknown' : priv ? 'private' : 'public', slug: name };
}
