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
import { findSecrets } from './lib/secrets.js';

export class StateError extends Error {}

export interface StateOptions {
  /** The app repo (the directory that contains `.arima/`). */
  projectDir: string;
  /** Orphan branch that holds `.arima/`. Never the default branch. */
  branch?: string;
  /** The app's default branch; the state branch must differ from it. */
  defaultBranch?: string;
  remote?: string;
}

const DEFAULT_BRANCH = 'arima-state';
const STATE_GITIGNORE = '*.lock\n*.tmp\nrun.lock\n';
const STATE_GITATTRIBUTES = '* -text\n';
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

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
}

/** Files (relative to `.arima/`) that look like they contain a credential. */
function scanStaged(r: Resolved): string[] {
  const names = git(r.stateDir, ['diff', '--cached', '--name-only', '--diff-filter=AM'])
    .split('\n')
    .filter(Boolean);
  const bad: string[] = [];
  for (const name of names) {
    const file = path.join(r.stateDir, name);
    try {
      if (statSync(file).size > MAX_SCAN_BYTES) continue;
      if (findSecrets(readFileSync(file, 'utf8')).length > 0) bad.push(name);
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
    return { committed: false, pushed: false, files: 0 };
  }
  const bad = scanStaged(r);
  if (bad.length > 0) {
    git(r.stateDir, ['reset', '-q']);
    throw new StateError(
      `refusing to commit state: ${bad.length} file(s) look like they contain a secret: ${bad.join(', ')}`,
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
  if (r.hasRemote) {
    git(r.stateDir, ['push', '--set-upstream', r.remote, `${r.branch}:${r.branch}`]);
    pushed = true;
  }
  return { committed: true, pushed, commit, files: staged.length };
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
