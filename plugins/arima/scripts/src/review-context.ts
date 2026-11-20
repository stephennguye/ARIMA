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
}

/** `git diff <base>...<branch>`, capped; the second element says whether it was cut. */
export function branchDiff(
  projectDir: string,
  base: string,
  branch: string,
  cap = DIFF_CAP,
): { text: string; truncated: boolean; changedLines: number } {
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
  for (const l of run('diff', '--numstat', range).split('\n').filter(Boolean)) {
    const [a, d] = l.split('\t');
    changed += (Number(a) || 0) + (Number(d) || 0);
  }
  return full.length > cap
    ? { text: full.slice(0, cap), truncated: true, changedLines: changed }
    : { text: full, truncated: false, changedLines: changed };
}

/** The size limits of spec 7.1 in changed lines; a story of an unknown size is treated as M. */
export const SIZE_LIMIT_LINES = { S: 200, M: 400, L: 800 } as const;

/**
 * The blocks and conditions of a review packet: the diff, the developer's own criteria map, and for a
 * re-review the findings the last review raised.
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
    conditions.push(
      `The diff changes ${d.changedLines} lines; the size limit of this story is about ${limit}${d.changedLines > limit ? ' (over the limit: raise a major sizing finding)' : ''}`,
    );
  } catch (e) {
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
    'CI is green (the item reached In Review because the checks passed)',
    `Review attempt ${o.attempt}`,
  );
  return { untrusted, conditions };
}
