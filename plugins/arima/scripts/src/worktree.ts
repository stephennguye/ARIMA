import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileAtomic } from './lib/atomic-file.js';
import { withFileLock } from './lib/filelock.js';
import { killTree } from './run-agent.js';

/**
 * The worktree manager (spec 10.2, F08 5.1; WP-110): every role run gets its own branch and its own
 * worktree, `../<repo>-wt/<branch>` beside the project. It is host code; no role can call it.
 * Registers each worktree with the run and the process that made it, so a crash can be cleaned up.
 */

export class WorktreeError extends Error {}

const win = process.platform === 'win32';

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    throw new WorktreeError(
      `git ${args.join(' ')} failed: ${(err.stderr ? String(err.stderr) : err.message).trim()}`,
      { cause: e },
    );
  }
}

const gitOk = (cwd: string, args: string[]): boolean => {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
};

/** ASCII, lower case, words joined by `-`, at most 40 characters (F08 5.1 step 1). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^ -~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

const PREFIX: Record<string, string> = { US: 'feat', BUG: 'fix', INC: 'hotfix', CR: 'feat' };

/** `feat/US-112-cart-summary`: the branch for an item (and an optional title). */
export function branchFor(item: string, title?: string): string {
  const m = /^([A-Z]+)-(\d+)$/.exec(item);
  if (!m) throw new WorktreeError(`"${item}" is not an item id (US-112, BUG-045, ...)`);
  const slug = title ? slugify(title) : '';
  return `${PREFIX[m[1] as string] ?? 'chore'}/${item}${slug ? `-${slug}` : ''}`;
}

const BRANCH =
  /^(?:feat|fix|hotfix|chore|qa)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface WorktreeOptions {
  /** The app repo (root of the checkout that holds `.arima/`). */
  projectDir: string;
  /** Never used as a worktree branch. */
  defaultBranch?: string;
  stateBranch?: string;
}

const isProtected = (branch: string, o: WorktreeOptions): boolean =>
  ['main', 'master', o.defaultBranch ?? 'main', o.stateBranch ?? 'arima-state'].includes(branch);

/** `../<repo>-wt/`, the folder that holds every worktree of the project. */
export const worktreeRoot = (projectDir: string): string => {
  const repo = path.resolve(projectDir);
  return path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
};

/** `../<repo>-wt/feat/US-112-slug`: nested, because branch names contain `/`. */
export const worktreePath = (projectDir: string, branch: string): string =>
  path.join(worktreeRoot(projectDir), ...branch.split('/'));

export interface Registered {
  path: string;
  branch: string;
  run_id: string;
  /** The process that created it: if it is gone and the unit never finished, the worktree is crash debris. */
  pid: number;
  created_at: string;
}

const registryFile = (projectDir: string): string =>
  path.join(worktreeRoot(projectDir), 'registry.json');

function readRegistry(projectDir: string): Registered[] {
  const f = registryFile(projectDir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Registered[]) : [];
}

async function updateRegistry(
  projectDir: string,
  change: (r: Registered[]) => Registered[],
): Promise<void> {
  const f = registryFile(projectDir);
  mkdirSync(path.dirname(f), { recursive: true });
  await withFileLock(`${f}.lock`, () =>
    writeFileAtomic(f, `${JSON.stringify(change(readRegistry(projectDir)), null, 2)}\n`),
  );
}

export interface CreateOptions extends WorktreeOptions {
  branch: string;
  /** Branch, tag or commit the new branch starts from. */
  base: string;
  runId: string;
  /** Paths (or `dir/` directories) to check out, nothing else: QA's worktree (no product source). */
  sparse?: string[];
  /** Overrides the creating pid (tests). */
  pid?: number;
}

export interface Created {
  path: string;
  branch: string;
  /** The commit the branch starts at. */
  head: string;
}

const SPARSE_PATH = /^(?![/.-])(?!.*\.\.)(?!.*[*?[\]\\!#])[A-Za-z0-9_@. /-]+\/?$/;

/**
 * Creates the branch and its worktree from `base`. Refuses (STOP) when the branch name is not an
 * ARIMA branch or is the default or state branch, when the branch already exists, or when the
 * path already exists. The new tree must be clean and at the base commit.
 */
export async function createWorktree(o: CreateOptions): Promise<Created> {
  const repo = path.resolve(o.projectDir);
  if (!BRANCH.test(o.branch) || o.branch.includes('..') || o.branch.endsWith('.lock'))
    throw new WorktreeError(
      `"${o.branch}" is not a branch name ARIMA creates (feat/, fix/, hotfix/, chore/ or qa/ then letters, digits, . _ -)`,
    );
  if (isProtected(o.branch, o))
    throw new WorktreeError(`refusing to use the protected branch "${o.branch}"`);
  const baseCommit = git(repo, ['rev-parse', '--verify', `${o.base}^{commit}`]);
  if (gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${o.branch}`]))
    throw new WorktreeError(
      `branch ${o.branch} already exists; STOP (remove it, or this is a re-dispatch of a unit that was not cleaned up)`,
    );
  const dir = worktreePath(repo, o.branch);
  if (existsSync(dir)) throw new WorktreeError(`${dir} already exists; STOP`);
  for (const p of o.sparse ?? [])
    if (!SPARSE_PATH.test(p))
      throw new WorktreeError(
        `sparse path "${p}" must be a plain relative path inside the repository`,
      );

  mkdirSync(path.dirname(dir), { recursive: true });
  const cfg = win ? ['-c', 'core.longpaths=true'] : [];
  const sparse = o.sparse !== undefined && o.sparse.length > 0;
  git(repo, [
    ...cfg,
    'worktree',
    'add',
    ...(sparse ? ['--no-checkout'] : []),
    '-b',
    o.branch,
    dir,
    baseCommit,
  ]);
  try {
    if (win) git(dir, ['config', 'core.longpaths', 'true']);
    if (sparse) {
      git(dir, [
        'sparse-checkout',
        'set',
        '--no-cone',
        ...(o.sparse as string[]).map((p) => `/${p}`),
      ]);
      git(dir, ['read-tree', '-mu', 'HEAD']);
    }
    const head = git(dir, ['rev-parse', 'HEAD']);
    if (head !== baseCommit)
      throw new WorktreeError(`new worktree is at ${head}, expected ${baseCommit}`);
    if (git(dir, ['status', '--porcelain']) !== '')
      throw new WorktreeError('new worktree is not clean');
    await updateRegistry(repo, (r) => [
      ...r.filter((x) => x.path !== dir),
      {
        path: dir,
        branch: o.branch,
        run_id: o.runId,
        pid: o.pid ?? process.pid,
        created_at: new Date().toISOString(),
      },
    ]);
    return { path: dir, branch: o.branch, head };
  } catch (e) {
    await removeWorktree({ ...o, branch: o.branch, deleteBranch: true }).catch(() => undefined);
    throw e;
  }
}

export interface Listed {
  path: string;
  branch: string | undefined;
  head: string;
}

const same = (a: string, b: string): boolean => {
  const n = (p: string): string => path.resolve(p).replaceAll('\\', '/').replace(/\/+$/, '');
  return win ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Linked worktrees of the project, without the main checkout and without the `.arima/` state worktree. */
export function listWorktrees(o: WorktreeOptions): Listed[] {
  const repo = path.resolve(o.projectDir);
  const out: Listed[] = [];
  let cur: Partial<Listed> & { path?: string } = {};
  const flush = (): void => {
    if (cur.path !== undefined)
      out.push({ path: cur.path, branch: cur.branch, head: cur.head ?? '' });
    cur = {};
  };
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line === '') flush();
    else if (line.startsWith('worktree ')) cur.path = line.slice(9);
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  flush();
  const stateBranch = o.stateBranch ?? 'arima-state';
  return out.filter(
    (w) =>
      !same(w.path, repo) && w.branch !== stateBranch && !same(w.path, path.join(repo, '.arima')),
  );
}

export interface RemoveOptions extends WorktreeOptions {
  /** Branch of the worktree to remove. */
  branch: string;
  /** Delete the branch too (never the default or state branch). */
  deleteBranch?: boolean;
  /** Processes started in the worktree: their trees are killed first (a hung run can hold files open). */
  pids?: number[];
}

/**
 * Removes a worktree: kills leftover process trees, `git worktree remove --force` with retry and
 * backoff (Windows holds files open for a moment), falls back to deleting the folder, then prunes.
 * Returns true when the directory is gone. Never touches the state worktree or the main checkout.
 */
export async function removeWorktree(o: RemoveOptions): Promise<boolean> {
  const repo = path.resolve(o.projectDir);
  if (isProtected(o.branch, o))
    throw new WorktreeError(`refusing to remove the protected branch "${o.branch}"`);
  const dir = worktreePath(repo, o.branch);
  if (same(dir, repo) || same(dir, path.join(repo, '.arima')))
    throw new WorktreeError('refusing to remove the main or state worktree');
  for (const pid of o.pids ?? []) killTree(pid);
  let removed = !existsSync(dir);
  for (let i = 0; i < 5 && !removed; i++) {
    try {
      git(repo, ['worktree', 'remove', '--force', dir]);
      removed = true;
    } catch {
      await sleep(100 * 2 ** i);
      removed = !existsSync(dir);
    }
  }
  if (!removed) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* reported by the return value */
    }
    removed = !existsSync(dir);
  }
  gitOk(repo, ['worktree', 'prune']);
  if (
    o.deleteBranch === true &&
    gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${o.branch}`])
  )
    gitOk(repo, ['branch', '-D', o.branch]);
  await updateRegistry(repo, (r) => r.filter((x) => !same(x.path, dir)));
  return removed;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface PruneResult {
  removed: string[];
  kept: string[];
  /** Registered worktrees whose folder is already gone (dropped from the registry). */
  forgotten: string[];
}

/**
 * Crash cleanup, run when the dispatcher starts: a registered worktree whose creating process is
 * gone is debris and its folder is removed; the branch is kept, because commits on it may be work that
 * was never published. Worktrees whose creator is alive are kept. Finished units' worktrees are removed by the flow that is done
 * with them (publish, merge), not here.
 */
export async function pruneWorktrees(
  o: WorktreeOptions & { isAlive?: (pid: number) => boolean },
): Promise<PruneResult> {
  const repo = path.resolve(o.projectDir);
  const isAlive = o.isAlive ?? alive;
  const res: PruneResult = { removed: [], kept: [], forgotten: [] };
  for (const w of readRegistry(repo)) {
    if (!existsSync(w.path)) {
      res.forgotten.push(w.path);
      await updateRegistry(repo, (r) => r.filter((x) => x.path !== w.path));
      continue;
    }
    if (isAlive(w.pid)) {
      res.kept.push(w.path);
      continue;
    }
    if (await removeWorktree({ ...o, branch: w.branch })) res.removed.push(w.path);
    else res.kept.push(w.path);
  }
  gitOk(repo, ['worktree', 'prune']);
  return res;
}
