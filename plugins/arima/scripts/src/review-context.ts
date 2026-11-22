import { execFileSync } from 'node:child_process';
import type { AgentReport } from './report.js';

/**
 * What the host puts in a tech-lead review packet (D-49: no role holds a GitHub token, so the host
 * reads the pull request and the role gets it as data). Everything here is untrusted text: code,
 * comments and the developer's own claims are quoted and never followed.
 */

/** Characters of diff inlined in the packet (the packet itself is capped at 40,000). */
export const DIFF_CAP = 22_000;

export interface ReviewContext {
  untrusted: { label: string; source: string; text: string }[];
  conditions: string[];
  /**
   * False when an `approve` of this review cannot be trusted because the reviewer could not have seen
   * the whole change (unreadable, empty, truncated or binary diff) or the author's report is missing.
   * The dispatcher then treats an approve as changes_requested (judge J-agent:tech-lead, major 3).
   */
  approvable: boolean;
  /** Why not, one line each. */
  unapprovable: string[];
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

/** `git diff <base>...<branch>`, capped, with the list of changed files (binary ones flagged). */
export function branchDiff(
  projectDir: string,
  base: string,
  branch: string,
  cap = DIFF_CAP,
): { text: string; truncated: boolean; changedLines: number; files: ChangedFile[] } {
  const run = (...a: string[]): string =>
    execFileSync('git', a, {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const range = `${base}...${branch}`;
  const full = run('diff', '--no-color', '--no-ext-diff', range);
  let changed = 0;
  const files: ChangedFile[] = [];
  for (const l of run('-c', 'core.quotePath=false', 'diff', '--numstat', range)
    .split('\n')
    .filter(Boolean)) {
    const [a, d, ...rest] = l.split('\t');
    const binary = a === '-' && d === '-';
    changed += (Number(a) || 0) + (Number(d) || 0);
    files.push({
      path: rest.join('\t'),
      added: Number(a) || 0,
      removed: Number(d) || 0,
      binary,
    });
  }
  return full.length > cap
    ? { text: full.slice(0, cap), truncated: true, changedLines: changed, files }
    : { text: full, truncated: false, changedLines: changed, files };
}

/** The size limits of spec 7.1 in changed lines; a story of an unknown size is treated as M. */
export const SIZE_LIMIT_LINES = { S: 200, M: 400, L: 800 } as const;

/**
 * The blocks and conditions of a review packet: the diff, the list of changed files, the developer's
 * own criteria map, and for a re-review the findings the last review raised.
 */
export function reviewContext(o: {
  projectDir: string;
  defaultBranch: string;
  branch: string;
  size: 'S' | 'M' | 'L' | undefined;
  developerReport: AgentReport | undefined;
  priorFindings: Record<string, unknown>[] | undefined;
  attempt: number;
}): ReviewContext {
  const untrusted: ReviewContext['untrusted'] = [];
  const conditions: string[] = [];
  const unapprovable: string[] = [];
  const limit = SIZE_LIMIT_LINES[o.size ?? 'M'];
  try {
    const d = branchDiff(o.projectDir, o.defaultBranch, o.branch);
    untrusted.push({
      label: `Pull request diff (git diff ${o.defaultBranch}...${o.branch})`,
      source: 'git',
      text: d.truncated
        ? `${d.text}\n[diff truncated at ${DIFF_CAP} characters; read the rest with git diff ${o.defaultBranch}...${o.branch} -- <path>]`
        : d.text === ''
          ? '(the branch has no changes against the default branch)'
          : d.text,
    });
    untrusted.push({
      label: 'Changed files (git diff --numstat; binary files are flagged)',
      source: 'git',
      text:
        d.files
          .map((f) => `${f.binary ? 'BINARY ' : ''}${f.path} +${f.added} -${f.removed}`)
          .join('\n') || '(none)',
    });
    conditions.push(
      `The diff changes ${d.changedLines} lines in ${d.files.length} files; the size limit of this story is about ${limit}${d.changedLines > limit ? ' (over the limit: raise a major sizing finding)' : ''}`,
    );
    if (d.text === '') unapprovable.push('the diff is empty');
    if (d.truncated) unapprovable.push(`the diff is longer than ${DIFF_CAP} characters`);
    const bin = d.files.filter((f) => f.binary).map((f) => f.path);
    if (bin.length > 0) unapprovable.push(`binary files cannot be reviewed: ${bin.join(', ')}`);
  } catch (e) {
    unapprovable.push('the host could not read the diff');
    untrusted.push({
      label: 'Pull request diff',
      source: 'git',
      text: `(the host could not read the diff: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}. Say so and give verdict changes_requested with a blocker finding)`,
    });
  }
  if (o.developerReport !== undefined) {
    const r = o.developerReport;
    untrusted.push({
      label: "Developer's report (criteria map and summary, the author's claims to check)",
      source: 'report',
      text: JSON.stringify({ summary: r.summary, criteria_map: r.criteria_map ?? [] }, null, 2),
    });
  } else {
    unapprovable.push('there is no developer report with a criteria map for this item');
    untrusted.push({
      label: "Developer's report",
      source: 'report',
      text: '(no developer report with a criteria map exists for this item: that is a blocker finding)',
    });
  }
  if (o.priorFindings !== undefined && o.priorFindings.length > 0)
    untrusted.push({
      label: `Findings of the previous review (attempt ${o.attempt - 1})`,
      source: 'report',
      text: JSON.stringify(o.priorFindings, null, 2),
    });
  conditions.push(
    'The host moved the item to In Review because the checks were green; the packet carries no CI log, and the merge script checks the checks again',
    `Review attempt ${o.attempt}`,
  );
  return { untrusted, conditions, approvable: unapprovable.length === 0, unapprovable };
}
