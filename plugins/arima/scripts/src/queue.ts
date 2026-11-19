import type { UnitKind } from './kinds.js';
import type { Role } from './ledger.js';
import { findRow, readMirror } from './notion/mirror.js';
import { unitBudget } from './story-budget.js';
import type { ItemStatus, Size } from './item.js';

/**
 * Plan the day (spec 7.2 step 4; F02 "Plan-the-day priority rules"): given what is true now, which
 * work units exist today and in what order. Pure: it reads a snapshot and returns a plan; the
 * dispatcher (WP-120) turns each unit into a packet and a run. Only a Ready story (DoR met, enforced
 * by the state machine) is ever started; budget, work in progress, parallelism and the review queue
 * are limits, not suggestions.
 */

export const RANK_NAMES = [
  'incident',
  'broken_main',
  'rework',
  'qa_of_prs',
  'test_cases',
  'new_stories',
  'recurring',
  'docs_and_debt',
] as const;
export type RankName = (typeof RANK_NAMES)[number];

/** The priority order of spec 7.2 step 4: position in this table is the rank (1 first). */
export const RANKS: readonly RankName[] = RANK_NAMES;

export interface StoryFacts {
  id: string;
  status: ItemStatus;
  /** Review and QA rework attempts so far; 1 means none. */
  attempt: number;
  /** PO priority: lower is more urgent; undefined sorts last. */
  priority?: number | undefined;
  size?: Size | undefined;
  /** Test cases linked to the story. */
  testCases: number;
  /** Open bugs linked to the story. */
  openBugs: number;
  /** The story budget leaves room for a run (see `unitBudget`). */
  budgetOk: boolean;
  /** A PR is open, CI is green and every criterion is mapped (from the host's read of GitHub). */
  prReady?: boolean;
  /** QA already passed this head of the PR: the story now waits for the human approval and the merge. */
  qaPassed?: boolean;
  /** Last rework came from QA rather than review (`failed_qa` instead of `failed_review`). */
  lastFailureQa?: boolean;
}

export interface Incident {
  id: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  needsHotfix?: boolean;
}

export interface RecurringJob {
  name: string;
  kind: UnitKind;
  role: Role;
}

export interface PlanInput {
  stories: StoryFacts[];
  incidents?: Incident[];
  /** CI is red on `main` after the flaky re-run. */
  ciRedOnMain?: boolean;
  /** The staging smoke test is failing. */
  stagingSmokeFailing?: boolean;
  recurringDue?: RecurringJob[];
  /** Documentation and tech-debt units, already shaped. */
  docsAndDebt?: { item: string; kind: UnitKind; role: Role }[];
}

export interface PlanLimits {
  /** min(parallelism.max_developer_agents, team developer.count). */
  maxDevelopers: number;
  /** review.max_prs_awaiting_human (default 5). */
  maxPrsAwaitingHuman: number;
  /** Pull requests awaiting the human's approval right now. */
  prsAwaitingHuman: number;
  /** One reviewer unit, or two for a regulated profile. */
  reviewers: 1 | 2;
}

export interface PlannedUnit {
  order: number;
  rank: number;
  rankName: RankName;
  kind: UnitKind;
  role: Role;
  /** Item id, or "none". */
  item: string;
  reworkReason?: 'failed_review' | 'failed_qa' | 'bug';
  /** 1 or 2: which reviewer, for a second review unit. */
  reviewer?: number;
  why: string;
}

export interface Skipped {
  rankName: RankName;
  item: string;
  reason: string;
}

export interface Plan {
  units: PlannedUnit[];
  skipped: Skipped[];
}

const SIZE_ORDER: Record<string, number> = { S: 0, M: 1, L: 2 };
const idNumber = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** Ties inside a rank (RD-F02-2): PO priority, then S before L, then the oldest (lowest id) first. */
export function byTieBreak(a: StoryFacts, b: StoryFacts): number {
  const p = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
  if (p !== 0) return p;
  const s = (SIZE_ORDER[a.size ?? ''] ?? 3) - (SIZE_ORDER[b.size ?? ''] ?? 3);
  if (s !== 0) return s;
  return idNumber(a.id) - idNumber(b.id) || a.id.localeCompare(b.id);
}

type Draft = Omit<PlannedUnit, 'order' | 'rank'>;

/**
 * Builds the day's plan. `ranks` is the order of the rules; the real one is `RANKS`, and tests pass
 * a permuted one to prove they would notice a change.
 */
export function planDay(
  input: PlanInput,
  limits: PlanLimits,
  ranks: readonly RankName[] = RANKS,
): Plan {
  const skipped: Skipped[] = [];
  const skip = (rankName: RankName, item: string, reason: string): void =>
    void skipped.push({ rankName, item, reason });
  const developerCap = Math.max(1, limits.maxDevelopers);
  const wipLimit = developerCap;
  let developerRuns = 0;
  const claimed = new Set<string>(); // an item gets at most one unit a day
  const stories = [...input.stories].sort(byTieBreak);
  const inProgress = stories.filter((s) => s.status === 'In Progress').length;

  const draft = (rankName: RankName): Draft[] => {
    const out: Draft[] = [];
    switch (rankName) {
      case 'incident':
        for (const inc of (input.incidents ?? []).filter(
          (i) => i.priority === 'P1' || i.priority === 'P2',
        )) {
          out.push({
            rankName,
            kind: 'triage',
            role: 'devops',
            item: inc.id,
            why: `${inc.priority} incident`,
          });
          if (inc.needsHotfix === true) {
            if (developerRuns < developerCap) {
              developerRuns += 1;
              out.push({
                rankName,
                kind: 'hotfix',
                role: 'developer',
                item: inc.id,
                why: `${inc.priority} incident needs a hotfix`,
              });
            } else skip(rankName, inc.id, 'no developer slot left for the hotfix');
          }
        }
        return out;
      case 'broken_main':
        if (input.ciRedOnMain === true) {
          if (developerRuns < developerCap) {
            developerRuns += 1;
            out.push({
              rankName,
              kind: 'fix',
              role: 'developer',
              item: 'none',
              why: 'CI is red on main after the re-run',
            });
          } else skip(rankName, 'none', 'no developer slot left to fix main');
        }
        if (input.stagingSmokeFailing === true)
          out.push({
            rankName,
            kind: 'deploy-staging',
            role: 'devops',
            item: 'none',
            why: 'the staging deploy failed its smoke test',
          });
        return out;
      case 'rework':
        for (const s of stories.filter(
          (x) => x.status === 'In Progress' && (x.attempt > 1 || x.openBugs > 0),
        )) {
          if (claimed.has(s.id)) continue;
          if (!s.budgetOk) {
            skip(rankName, s.id, 'story budget used up');
            continue;
          }
          if (developerRuns >= developerCap) {
            skip(rankName, s.id, 'no developer slot left');
            continue;
          }
          developerRuns += 1;
          out.push({
            rankName,
            kind: 'develop',
            role: 'developer',
            item: s.id,
            reworkReason:
              s.openBugs > 0 && s.attempt <= 1
                ? 'bug'
                : s.lastFailureQa === true
                  ? 'failed_qa'
                  : 'failed_review',
            why: s.openBugs > 0 ? 'open bug on an in-flight story' : `attempt ${s.attempt}`,
          });
        }
        return out;
      case 'qa_of_prs':
        for (const s of stories) {
          if (claimed.has(s.id)) continue;
          if (s.status === 'In Review' && s.prReady === true) {
            if (!s.budgetOk) {
              skip(rankName, s.id, 'story budget used up');
              continue;
            }
            for (let r = 1; r <= limits.reviewers; r++)
              out.push({
                rankName,
                kind: 'review',
                role: 'tech-lead',
                item: s.id,
                ...(limits.reviewers > 1 ? { reviewer: r } : {}),
                why: 'PR open, CI green, criteria mapped',
              });
          } else if (s.status === 'In QA' && s.qaPassed === true) {
            skip(
              rankName,
              s.id,
              'QA already passed this head; waiting for the human approval and the merge',
            );
          } else if (s.status === 'In QA') {
            if (!s.budgetOk) {
              skip(rankName, s.id, 'story budget used up');
              continue;
            }
            out.push({
              rankName,
              kind: 'qa',
              role: 'qa',
              item: s.id,
              why: 'the tech-lead approved; QA runs on the preview',
            });
          }
        }
        return out;
      case 'test_cases':
        for (const s of stories.filter((x) => x.status === 'Ready' && x.testCases === 0)) {
          if (claimed.has(s.id)) continue;
          if (!s.budgetOk) {
            skip(rankName, s.id, 'story budget used up');
            continue;
          }
          out.push({
            rankName,
            kind: 'test-write',
            role: 'qa',
            item: s.id,
            why: 'Ready story with no test cases',
          });
        }
        return out;
      case 'new_stories': {
        const ready = stories.filter((x) => x.status === 'Ready' && x.testCases > 0);
        if (limits.prsAwaitingHuman >= limits.maxPrsAwaitingHuman) {
          for (const s of ready)
            skip(
              rankName,
              s.id,
              `${limits.prsAwaitingHuman} pull requests await your approval (limit ${limits.maxPrsAwaitingHuman})`,
            );
          return out;
        }
        let wip = inProgress;
        for (const s of ready) {
          if (claimed.has(s.id)) continue;
          if (!s.budgetOk) {
            skip(rankName, s.id, 'story budget used up');
            continue;
          }
          if (wip >= wipLimit) {
            skip(rankName, s.id, `work in progress is at its limit (${wipLimit})`);
            continue;
          }
          if (developerRuns >= developerCap) {
            skip(rankName, s.id, `all ${developerCap} developer slots are in use`);
            continue;
          }
          wip += 1;
          developerRuns += 1;
          out.push({
            rankName,
            kind: 'develop',
            role: 'developer',
            item: s.id,
            why: 'Ready, has test cases, budget and a free slot',
          });
        }
        return out;
      }
      case 'recurring':
        for (const j of input.recurringDue ?? [])
          out.push({
            rankName,
            kind: j.kind,
            role: j.role,
            item: 'none',
            why: `recurring job ${j.name} is due`,
          });
        return out;
      case 'docs_and_debt':
        for (const d of input.docsAndDebt ?? [])
          out.push({
            rankName,
            kind: d.kind,
            role: d.role,
            item: d.item,
            why: 'documentation or tech-debt item',
          });
        return out;
    }
  };

  const units: PlannedUnit[] = [];
  ranks.forEach((rankName, i) => {
    // An item claimed by an EARLIER rank gets no second unit; one rank may give an item several
    // (an incident's triage and hotfix, a PR's two reviewers).
    const claimedHere: string[] = [];
    for (const d of draft(rankName)) {
      if (d.item !== 'none' && claimed.has(d.item)) continue;
      if (d.item !== 'none') claimedHere.push(d.item);
      units.push({ ...d, order: units.length + 1, rank: i + 1 });
    }
    for (const item of claimedHere) claimed.add(item);
  });
  return { units, skipped };
}

/** What the plan needs about each story, from the Notion mirror and the ledger. */
export function storiesFromMirror(
  projectDir: string,
  cfg: { perStoryDefault: number; bySize?: Partial<Record<Size, number>>; perRunCap: number },
  pr: Record<string, { prReady?: boolean; lastFailureQa?: boolean }> = {},
): StoryFacts[] {
  const mirror = readMirror(projectDir, 'stories');
  if (mirror === undefined) return [];
  const bugs = readMirror(projectDir, 'bugs');
  const openBugStatuses = new Set(['Open', 'In progress', 'Fixed']);
  const rel = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const out: StoryFacts[] = [];
  for (const row of mirror.rows) {
    if (!/^US-\d+$/.test(row.id)) continue;
    const p = row.properties;
    const status = p['Status'];
    if (typeof status !== 'string') continue;
    const size = p['Complexity'];
    const budget = typeof p['Budget USD'] === 'number' ? p['Budget USD'] : undefined;
    const bugIds = rel(p['Bugs']);
    const openBugs = bugIds.filter((b) =>
      openBugStatuses.has(String(findRow(bugs, b)?.properties['Status'] ?? 'Open')),
    ).length;
    const sizeOk = size === 'S' || size === 'M' || size === 'L' ? size : undefined;
    const storyBudget =
      budget ?? (sizeOk ? cfg.bySize?.[sizeOk] : undefined) ?? cfg.perStoryDefault;
    out.push({
      id: row.id,
      status: status as ItemStatus,
      attempt: typeof p['Attempt'] === 'number' ? p['Attempt'] : 1,
      priority: typeof p['Priority'] === 'number' ? p['Priority'] : undefined,
      size: sizeOk,
      testCases: rel(p['Test Cases']).length,
      openBugs,
      budgetOk: unitBudget(projectDir, row.id, storyBudget, cfg.perRunCap).ok,
      ...(pr[row.id]?.prReady !== undefined ? { prReady: pr[row.id]?.prReady as boolean } : {}),
      ...(pr[row.id]?.lastFailureQa !== undefined
        ? { lastFailureQa: pr[row.id]?.lastFailureQa as boolean }
        : {}),
    });
  }
  return out;
}
