import { findAttribution } from './attribution.js';

/**
 * The commit-message rules of an ARIMA-built app repo (spec 2, 10.2; S9, D-48; WP-113). The
 * `commit-msg` hook shipped in `templates/git/commit-msg` is the same rules in POSIX sh (an app
 * repo has no Node toolchain at commit time); `commit-hook.test.ts` runs one corpus through both.
 *
 * - Every branch: no AI attribution (D-48).
 * - `feat/`, `fix/`, `hotfix/` and `qa/` branches: Conventional Commits with the item id as scope,
 *   `feat(US-112): ...` (ids US, BUG, INC, CR).
 * - Exempt (S9): `chore/`, `docs/`, `release/`, `arima-state`; the subject must still be
 *   conventional and the message must carry a run id (`r-YYYYMMDD-HHMM-NN`) or an ADR, task or
 *   work-package id. Dependency-bot branches (`dependabot/`, `renovate/`, `deps/`) are exempt
 *   from both, because a bot cannot add an id; the attribution rule still applies.
 * - Merge commits are not checked beyond attribution.
 */

export type BranchKind = 'item' | 'exempt' | 'bot' | 'other';

export function branchKind(branch: string): BranchKind {
  if (/^(feat|fix|hotfix|qa)\//.test(branch)) return 'item';
  if (/^(chore|docs|release)\//.test(branch) || branch === 'arima-state') return 'exempt';
  if (/^(dependabot|renovate|deps)\//.test(branch)) return 'bot';
  return 'other';
}

const TYPES = 'feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert';
const ITEM_SUBJECT = new RegExp(`^(${TYPES}|hotfix)\\((US|BUG|INC|CR)-\\d+\\)!?: \\S`);
const CONVENTIONAL = new RegExp(`^(${TYPES})(\\([^)\\s]+\\))?!?: \\S`);
const TRACE = /(r-\d{8}-\d{4}-\d{2,}|\bADR-\d+|\bWP-\d+|\bT-\d+\b)/;

export interface CommitCheck {
  ok: boolean;
  problems: string[];
}

/** Checks a commit message (as in `.git/COMMIT_EDITMSG`) made on `branch`. */
export function checkCommitMessage(message: string, branch: string): CommitCheck {
  const text = message
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('#'))
    .join('\n');
  const subject = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const problems: string[] = [];
  const attr = findAttribution(text);
  if (attr.length > 0)
    problems.push(`the message contains ${attr.join(' and ')} (D-48: no AI attribution)`);
  if (/^Merge /.test(subject)) return { ok: problems.length === 0, problems };
  const kind = branchKind(branch);
  if (kind === 'item' && !ITEM_SUBJECT.test(subject))
    problems.push(
      `on ${branch} the subject must be "type(ITEM-ID): summary" with an item id (US, BUG, INC or CR), for example "feat(US-112): add cart summary"; got "${subject.slice(0, 60)}"`,
    );
  if (kind === 'exempt') {
    if (!CONVENTIONAL.test(subject))
      problems.push(
        `the subject must be a conventional commit ("type(scope): summary"); got "${subject.slice(0, 60)}"`,
      );
    if (!TRACE.test(text))
      problems.push(
        'the message must carry a run id (r-YYYYMMDD-HHMM-NN) or an ADR, task or work-package id',
      );
  }
  if (kind === 'other' && !CONVENTIONAL.test(subject))
    problems.push(
      `the subject must be a conventional commit ("type(scope): summary"); got "${subject.slice(0, 60)}"`,
    );
  return { ok: problems.length === 0, problems };
}
