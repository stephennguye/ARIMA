import { appendEvent } from './events.js';
import { readLedger } from './ledger.js';
import { findRow, readMirror } from './notion/mirror.js';

/**
 * The cost floor of one headless run, in est. USD. A `claude -p` run that does anything at all
 * costs about $0.15 to $0.25 (the system prompt and tool definitions are billed before the first
 * turn; measured on the dev project, handoff section 4). Spec 13.5 lets a run overshoot its cap
 * "after spend is added", so a run started with less than this left is bound to break the story
 * budget: the dispatcher refuses to start it instead of trusting the cap (RD-F02-11).
 */
export const RUN_COST_FLOOR_USD = 0.25;

export interface StoryBudgetConfig {
  perStoryDefault: number;
  /** Default story budgets by size (D-25): S 1, M 3, L 6. */
  bySize?: Partial<Record<'S' | 'M' | 'L', number>>;
  perRunCap: number;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * The budget of one story: the `Budget USD` on its Stories row when set, else the default for its
 * size, else `budget.per_story_default` (spec 7.1, 13.5; RD-F05-4: the budget lives on the row,
 * the ledger's `budget_usd` is the run cap).
 */
export function storyBudget(
  cfg: Pick<StoryBudgetConfig, 'perStoryDefault' | 'bySize'>,
  row: { size?: string | undefined; budget?: number | undefined } = {},
): number {
  if (typeof row.budget === 'number' && row.budget > 0) return row.budget;
  const bySize =
    row.size === 'S' || row.size === 'M' || row.size === 'L' ? cfg.bySize?.[row.size] : undefined;
  return bySize ?? cfg.perStoryDefault;
}

/** Reads `Budget USD` and `Complexity` of a story from the mirror and applies `storyBudget`. */
export function storyBudgetFromMirror(
  projectDir: string,
  item: string,
  cfg: Pick<StoryBudgetConfig, 'perStoryDefault' | 'bySize'>,
): number {
  const row = findRow(readMirror(projectDir, 'stories'), item);
  const b = row?.properties['Budget USD'];
  const size = row?.properties['Complexity'];
  return storyBudget(cfg, {
    budget: typeof b === 'number' ? b : undefined,
    size: typeof size === 'string' ? size : undefined,
  });
}

/** Est. USD already spent on an item, from the run ledger (every run of the item, rework included). */
export function itemSpent(projectDir: string, item: string): number {
  return round(
    readLedger(projectDir)
      .filter((r) => r.item === item)
      .reduce((s, r) => s + r.cost_usd, 0),
  );
}

export type UnitBudget =
  | { ok: true; budgetUsd: number; spent: number; remaining: number; storyBudget: number }
  | { ok: false; reason: 'story_budget'; spent: number; remaining: number; storyBudget: number };

/**
 * The cap for the next run of an item: `min(per_run_cap, remaining story budget)`. When what is
 * left is under the cost floor, or nothing, there is no run: the item is out of budget.
 */
export function unitBudget(
  projectDir: string,
  item: string,
  budget: number,
  perRunCap: number,
  floor: number = RUN_COST_FLOOR_USD,
): UnitBudget {
  const spent = itemSpent(projectDir, item);
  const remaining = round(budget - spent);
  if (!(remaining > 0) || remaining < floor)
    return {
      ok: false,
      reason: 'story_budget',
      spent,
      remaining: Math.max(0, remaining),
      storyBudget: budget,
    };
  return {
    ok: true,
    budgetUsd: round(Math.min(perRunCap, remaining)),
    spent,
    remaining,
    storyBudget: budget,
  };
}

/** Records the `story_budget` hard stop for an item (spec 11.1); the caller blocks the item and raises the question. */
export async function recordStoryBudgetHit(
  projectDir: string,
  item: string,
  b: Extract<UnitBudget, { ok: false }>,
  role?: string,
): Promise<string> {
  const message = `story budget used up for ${item}: spent ${b.spent} of ${b.storyBudget} est. USD, ${b.remaining} left (a run needs at least ${RUN_COST_FLOOR_USD})`;
  await appendEvent(projectDir, {
    type: 'hardstop.hit',
    actor: 'system',
    item,
    data: {
      stop: 'story_budget',
      ...(role !== undefined ? { role } : {}),
      message,
      spent: b.spent,
      budget: b.storyBudget,
      remaining: b.remaining,
    },
  });
  return message;
}
