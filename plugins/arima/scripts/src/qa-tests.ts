import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findSecrets } from './lib/secrets.js';
import { worktreePath } from './worktree.js';

/**
 * QA's tests reach the developer (WP-211, QA card decisions 4 and 10): QA has no git, so after a test-write
 * run the host commits what changed in QA's worktree, but only when it is all under `tests/`, then puts
 * those commits on the story branch, so the developer's worktree starts with the tests that judge the work.
 * The tip is recorded: the developer's publish check treats commits up to it as QA's, not the developer's.
 */

export class QaTestsError extends Error {}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const tryGit = (cwd: string, args: string[]): string | undefined => {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
};

function isAncestor(cwd: string, a: string, b: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const tipsFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'qa-tips.json');

export function readQaTips(projectDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(tipsFile(projectDir), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}
export const qaTipOf = (projectDir: string, item: string): string | undefined =>
  readQaTips(projectDir)[item];
function writeQaTip(projectDir: string, item: string, sha: string): void {
  const f = tipsFile(projectDir);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ ...readQaTips(projectDir), [item]: sha }, null, 2)}\n`);
}

export interface Adopted {
  /** The commit QA's tests are at (the story branch tip right after adoption). */
  sha: string;
  /** Created the story branch (true) or moved it forward (false). */
  created: boolean;
}

/**
 * Commits the files QA left in its worktree and brings the story branch to that commit. Refuses when
 * anything outside `tests/` changed, when a secret would be committed, or when the story branch has
 * work that is not an ancestor of QA's (it would not be a fast-forward).
 */
export function adoptQaTests(o: {
  projectDir: string;
  item: string;
  qaBranch: string;
  storyBranch: string;
}): Adopted | undefined {
  const dir = worktreePath(o.projectDir, o.qaBranch);
  if (!existsSync(dir)) throw new QaTestsError(`there is no QA worktree for ${o.qaBranch}`);
  const changed = git(dir, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
  const outside = changed.filter((f) => !f.startsWith('tests/'));
  if (outside.length > 0)
    throw new QaTestsError(`QA changed files outside tests/: ${outside.join(', ')}`);
  if (changed.length > 0) {
    git(dir, ['add', '--', 'tests']);
    const leaked = findSecrets(git(dir, ['diff', '--cached']));
    if (leaked.length > 0) {
      git(dir, ['reset', '-q']);
      throw new QaTestsError(`QA's tests look like they contain a secret (${leaked.join(', ')})`);
    }
    git(dir, [
      '-c',
      'user.name=ARIMA host',
      '-c',
      'user.email=arima@localhost.invalid',
      'commit',
      '-q',
      '-m',
      `test(${o.item}): end-to-end tests from the acceptance criteria`,
    ]);
  }
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const have = tryGit(o.projectDir, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${o.storyBranch}`,
  ]);
  if (have === sha) {
    writeQaTip(o.projectDir, o.item, sha);
    return { sha, created: false };
  }
  if (have === undefined) {
    // Nothing committed and no story branch: there is nothing to adopt.
    const base = tryGit(dir, ['merge-base', 'HEAD', 'refs/heads/main']);
    if (changed.length === 0 && base === sha) return undefined;
    git(o.projectDir, ['branch', o.storyBranch, sha]);
    writeQaTip(o.projectDir, o.item, sha);
    return { sha, created: true };
  }
  if (!isAncestor(o.projectDir, have, sha))
    throw new QaTestsError(
      `${o.storyBranch} has work that is not in QA's branch; not a fast-forward`,
    );
  git(o.projectDir, ['branch', '-f', o.storyBranch, sha]);
  writeQaTip(o.projectDir, o.item, sha);
  return { sha, created: false };
}
