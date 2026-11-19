import { SIZE_POINTS } from './item.js';
import type { Size } from './item.js';
import { readLedger } from './ledger.js';
import { allocateId } from './notion/allocations.js';
import { findRow, readMirror } from './notion/mirror.js';
import { enqueue } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';

/**
 * Milestone planning (spec 7.1, D-25, D-27, F07 section 5.4, WP-216). A milestone holds 8 to 12 points
 * (S 1, M 2, L 4), is filled by priority, and a story is never split: one that would push the total
 * over 12 is skipped and left for the next milestone while smaller ones keep being tried.
 */

export const MILESTONE_MIN_POINTS = 8;
export const MILESTONE_MAX_POINTS = 12;
export const TECH_DEBT_SHARE = 0.15;

export interface PlanStory {
  id: string;
  status: string;
  size: Size | undefined;
  priority: number | undefined;
  /** Notion `Type`: Story, Bug fix, Tech task or Spike. */
  type: string;
  /** Estimated budget in USD (the story's own, else by size, else the default). */
  budget: number;
  /** Milestone ids the story is linked to (normally none or one). */
  milestones: string[];
  dependsOn: string[];
}

export interface PlanInput {
  stories: PlanStory[];
  /** Plan this existing milestone again (`MS-NN`); otherwise the next one is planned. */
  revise?: string;
  /** Remaining project budget in USD (project cap minus the ledger). */
  remainingBudget: number;
}

export interface Planned {
  id: string;
  size: Size;
  points: number;
  budget: number;
  pinned: boolean;
}

export interface Skipped {
  id: string;
  reason: string;
}

export interface MilestonePlan {
  revise?: string;
  stories: Planned[];
  points: number;
  budget: number;
  /** Under 8 points and nothing else fits: allowed, and said so. */
  short: boolean;
  skipped: Skipped[];
  warnings: string[];
  /** Set when the story budgets exceed the remaining project budget: nothing may be written. */
  overBudget: { remaining: number; needed: number } | undefined;
}

const NOT_STARTED = new Set(['Backlog', 'Ready']);
const DONE = new Set(['Done', 'Released']);

const idNumber = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
const byPriority = (a: PlanStory, b: PlanStory): number =>
  (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
  idNumber(a.id) - idNumber(b.id) ||
  a.id.localeCompare(b.id);

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function planMilestone(input: PlanInput): MilestonePlan {
  const target = input.revise;
  const byId = new Map(input.stories.map((s) => [s.id, s]));
  const skipped: Skipped[] = [];
  const warnings: string[] = [];

  // Pinned: already left the unstarted states in the milestone being revised. They stay.
  const pinned =
    target === undefined
      ? []
      : input.stories.filter((s) => s.milestones.includes(target) && !NOT_STARTED.has(s.status));
  const pinnedIds = new Set(pinned.map((s) => s.id));

  // Candidates: unstarted, sized, and not in another milestone.
  const pool: PlanStory[] = [];
  for (const s of [...input.stories].sort(byPriority)) {
    if (pinnedIds.has(s.id) || !NOT_STARTED.has(s.status)) continue;
    const others = s.milestones.filter((m) => m !== target);
    if (others.length > 0) {
      skipped.push({ id: s.id, reason: `already in ${others.join(', ')}` });
      continue;
    }
    if (s.size === undefined) {
      skipped.push({ id: s.id, reason: 'not sized S, M or L (D-25); size it first' });
      continue;
    }
    pool.push(s);
  }

  const points = (s: PlanStory): number => SIZE_POINTS[s.size as Size];
  let total = pinned.reduce((n, s) => n + (s.size ? points(s) : 0), 0);
  if (total > MILESTONE_MAX_POINTS)
    warnings.push(
      `the stories already started in ${target ?? 'this milestone'} are ${total} points, above ${MILESTONE_MAX_POINTS}`,
    );

  const chosen: PlanStory[] = [];
  const inPlan = new Set<string>(pinnedIds);
  /** A dependency is met when it is finished, in an earlier milestone, or already in this plan. */
  const depMet = (dep: string): boolean => {
    const d = byId.get(dep);
    if (d === undefined) return false;
    if (DONE.has(d.status) || inPlan.has(dep)) return true;
    return d.milestones.some((m) => m !== target);
  };

  const remaining = [...pool];
  for (;;) {
    const i = remaining.findIndex(
      (s) => total + points(s) <= MILESTONE_MAX_POINTS && s.dependsOn.every(depMet),
    );
    if (i < 0) break;
    const [s] = remaining.splice(i, 1) as [PlanStory];
    chosen.push(s);
    inPlan.add(s.id);
    total += points(s);
  }
  for (const s of remaining) {
    const missing = s.dependsOn.filter((d) => !depMet(d));
    skipped.push({
      id: s.id,
      reason:
        missing.length > 0
          ? `waits for ${missing.join(', ')}, which is not finished or planned earlier`
          : `would make ${total + points(s)} points (over ${MILESTONE_MAX_POINTS}); never split, left for the next milestone`,
    });
  }

  const stories: Planned[] = [...pinned, ...chosen].map((s) => ({
    id: s.id,
    size: (s.size ?? 'M') as Size,
    points: s.size ? points(s) : 0,
    budget: s.budget,
    pinned: pinnedIds.has(s.id),
  }));
  const sum = stories.reduce((n, s) => n + s.points, 0);
  const budget = round(stories.reduce((n, s) => n + s.budget, 0));

  const short = sum < MILESTONE_MIN_POINTS;
  if (short && stories.length > 0)
    warnings.push(
      `short milestone: ${sum} points, below ${MILESTONE_MIN_POINTS}, and no other unstarted story fits`,
    );
  const debt = stories
    .filter((s) => byId.get(s.id)?.type === 'Tech task')
    .reduce((n, s) => n + s.points, 0);
  if (sum > 0 && debt / sum < TECH_DEBT_SHARE)
    warnings.push(
      `tech debt is ${Math.round((debt / sum) * 100)}% of the points; the target is about 15 to 20% (spec 7.10)`,
    );

  return {
    ...(target !== undefined ? { revise: target } : {}),
    stories,
    points: sum,
    budget,
    short,
    skipped,
    warnings,
    overBudget:
      budget > input.remainingBudget
        ? { remaining: round(input.remainingBudget), needed: budget }
        : undefined,
  };
}

// ---- reading the project ---------------------------------------------------------------------------------

const asList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : typeof v === 'string'
      ? v.split(/[,\s]+/).filter((x) => /^US-\d+$/.test(x))
      : [];

export function storiesForPlan(
  projectDir: string,
  cfg: { perStoryDefault: number; bySize?: Partial<Record<Size, number>> },
): PlanStory[] {
  const mirror = readMirror(projectDir, 'stories');
  if (mirror === undefined) return [];
  // The real mirror holds a relation as page ids (UUIDs); name the rows by their ids.
  const names = new Map<string, string>();
  for (const db of ['stories', 'milestones'] as const)
    for (const r of readMirror(projectDir, db)?.rows ?? []) names.set(r.page_id, r.id);
  const named = (v: unknown): string[] => asList(v).map((x) => names.get(x) ?? x);
  const out: PlanStory[] = [];
  for (const row of mirror.rows) {
    if (!/^US-\d+$/.test(row.id)) continue;
    const p = row.properties;
    if (typeof p['Status'] !== 'string') continue;
    const size =
      p['Complexity'] === 'S' || p['Complexity'] === 'M' || p['Complexity'] === 'L'
        ? p['Complexity']
        : undefined;
    out.push({
      id: row.id,
      status: p['Status'],
      size,
      priority: typeof p['Priority'] === 'number' ? p['Priority'] : undefined,
      type: typeof p['Type'] === 'string' ? p['Type'] : 'Story',
      budget:
        (typeof p['Budget USD'] === 'number' ? p['Budget USD'] : undefined) ??
        (size ? cfg.bySize?.[size] : undefined) ??
        cfg.perStoryDefault,
      milestones: named(p['Milestone']),
      // `Depends on` is not a Notion property of the template yet: read it when a human added it.
      dependsOn: named(p['Depends on']),
    });
  }
  return out;
}

export function remainingBudget(projectDir: string, projectCap: number): number {
  return round(projectCap - readLedger(projectDir).reduce((n, r) => n + r.cost_usd, 0));
}

// ---- writing ----------------------------------------------------------------------------------------------

/**
 * Queues the Milestones row (a new `MS-NN` from the engine, or an update of the revised one) with the
 * story links on its side of the relation. Nothing is applied until `arima-notion push`.
 */
export async function queueMilestone(o: {
  projectDir: string;
  runId: string;
  plan: MilestonePlan;
  now?: Date;
}): Promise<{ milestone: string; entry: string }> {
  const now = o.now ?? new Date();
  const ids = o.plan.stories.map((s) => s.id);
  const entryId = `ms-${o.runId}-0001`;
  let milestone: string;
  let entry: OutboxEntry;
  if (o.plan.revise !== undefined) {
    const row = findRow(readMirror(o.projectDir, 'milestones'), o.plan.revise);
    if (row === undefined)
      throw new Error(`${o.plan.revise} is not in the Notion mirror; run arima-notion pull`);
    if (row.properties['Status'] === 'Done')
      throw new Error(`${o.plan.revise} is Done; plan a new milestone instead`);
    milestone = o.plan.revise;
    entry = {
      id: entryId,
      created_at: now.toISOString(),
      run_id: o.runId,
      role: 'orchestrator',
      op: 'update',
      database: 'milestones',
      item_id: milestone,
      properties: { 'Budget USD': o.plan.budget, Stories: ids },
    };
  } else {
    milestone = await allocateId(o.projectDir, 'MS', o.runId);
    entry = {
      id: entryId,
      created_at: now.toISOString(),
      run_id: o.runId,
      role: 'orchestrator',
      op: 'create',
      database: 'milestones',
      properties: {
        ID: milestone,
        Name: `Milestone ${milestone.replace(/^MS-0*/, '')}`,
        'Budget USD': o.plan.budget,
        Stories: ids,
      },
    };
  }
  enqueue(o.projectDir, entry);
  return { milestone, entry: entryId };
}
