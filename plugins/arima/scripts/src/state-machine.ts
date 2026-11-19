import { ITEM_STATUSES } from './item.js';
import type { ItemStatus } from './item.js';
import { ROLES } from './roles.js';
import type { Role } from './ledger.js';

/**
 * The ticket state machine (spec 7.1, 03-contracts 9): pure and table-driven. It decides; it
 * writes nothing. The caller (WP-108, the dispatcher) applies the result: the `item.status` event,
 * the item counters and the Notion `Status` write (engine only, never from an agent outbox).
 */

/** Who may drive a transition. Roles are agents; `po` and `sponsor` are humans; the rest are programs. */
export type Actor = Role | 'po' | 'sponsor' | 'engine' | 'merge-script';
export const ACTORS: readonly Actor[] = [...ROLES, 'po', 'sponsor', 'engine', 'merge-script'];

/** The facts a guard can ask for. A guard is satisfied only by `true`; a missing fact is false. */
export type Guard =
  | 'dor_met'
  | 'priority_set'
  | 'test_cases_exist'
  | 'story_budget_available'
  | 'wip_ok'
  | 'pr_open'
  | 'ci_green'
  | 'criteria_mapped'
  | 'changes_requested'
  | 'review_approved'
  | 'preview_deployed'
  | 'test_failed'
  | 'bug_linked'
  | 'all_tests_passed'
  | 'design_qa_ok'
  | 'human_pr_approved'
  | 'qa_passed'
  | 'vetoed'
  | 'bug_with_reason'
  | 'production_deploy_recorded'
  | 'cause_resolved'
  | 'reason_recorded';

export interface Facts {
  guards: Partial<Record<Guard, boolean>>;
  /** The matter is one of the 16 hard stops: nothing moves forward on an assumption. */
  hard_stop?: boolean;
  /** Budget (project, day and story) is left for a run the target state will cause. */
  budget_available?: boolean;
  /** Why the item is being Blocked or Cancelled; also the text of the question raised. */
  reason?: string;
}

export interface Transition {
  from: ItemStatus | 'open' | 'before_done';
  to: ItemStatus | 'previous';
  actors: readonly Actor[];
  guards: readonly Guard[];
  /** A review or QA failure: `attempt` + 1, and the third one blocks the item. */
  rework?: boolean;
}

const OPEN: readonly ItemStatus[] = [
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'In QA',
  'PO Acceptance',
];
const BEFORE_DONE: readonly ItemStatus[] = [...OPEN, 'Blocked'];
const AGENTS: readonly Actor[] = [...ROLES, 'engine'];

/** 03-contracts section 9, row for row. */
export const TRANSITIONS: readonly Transition[] = [
  { from: 'Backlog', to: 'Ready', actors: ['ba'], guards: ['dor_met', 'priority_set'] },
  {
    from: 'Ready',
    to: 'In Progress',
    actors: ['orchestrator'],
    guards: ['test_cases_exist', 'story_budget_available', 'wip_ok'],
  },
  {
    from: 'In Progress',
    to: 'In Review',
    actors: ['developer'],
    guards: ['pr_open', 'ci_green', 'criteria_mapped'],
  },
  {
    from: 'In Review',
    to: 'In Progress',
    actors: ['tech-lead'],
    guards: ['changes_requested'],
    rework: true,
  },
  {
    from: 'In Review',
    to: 'In QA',
    actors: ['tech-lead'],
    guards: ['review_approved', 'preview_deployed'],
  },
  {
    from: 'In QA',
    to: 'In Progress',
    actors: ['qa'],
    guards: ['test_failed', 'bug_linked'],
    rework: true,
  },
  {
    from: 'In QA',
    to: 'PO Acceptance',
    actors: ['merge-script'],
    guards: ['all_tests_passed', 'design_qa_ok', 'human_pr_approved'],
  },
  { from: 'PO Acceptance', to: 'Done', actors: ['orchestrator'], guards: ['qa_passed'] },
  {
    from: 'PO Acceptance',
    to: 'In Progress',
    actors: ['po', 'sponsor'],
    guards: ['vetoed', 'bug_with_reason'],
  },
  { from: 'Done', to: 'Released', actors: ['engine'], guards: ['production_deploy_recorded'] },
  { from: 'open', to: 'Blocked', actors: AGENTS, guards: ['reason_recorded'] },
  { from: 'Blocked', to: 'previous', actors: ['orchestrator'], guards: ['cause_resolved'] },
  { from: 'before_done', to: 'Cancelled', actors: ['po'], guards: ['reason_recorded'] },
];

/** A review or QA failure number that blocks the item (spec 7.1: the third). */
export const MAX_FAILED_ATTEMPTS = 3;
/** A second failed run blocks the item (spec 7.12). */
export const MAX_RUN_FAILURES = 2;
/** Targets whose runs cost money: they need budget (condition 4). */
const SPENDING: readonly ItemStatus[] = ['In Progress', 'In Review', 'In QA'];

/** What the engine holds for an item (03-contracts 9a), plus its Notion status. */
export interface ItemState {
  status: ItemStatus;
  attempt: number;
  run_failures: number;
  blocked_from?: ItemStatus | null;
  blocked_reason?: string | null;
}

export interface TransitionRequest {
  to: ItemStatus;
  actor: Actor;
  facts: Facts;
}

export type RefusalCode =
  | 'no_such_edge'
  | 'actor_not_allowed'
  | 'guard_failed'
  | 'hard_stop'
  | 'no_budget'
  | 'wrong_return';

export interface Refusal {
  ok: false;
  code: RefusalCode;
  message: string;
  /** The guards that were false, for `guard_failed`. */
  failed?: Guard[];
}

export interface Applied {
  ok: true;
  /** The state to write. */
  next: ItemState;
  /** True when the machine moved the item somewhere other than asked (the third failed attempt blocks it). */
  redirected: boolean;
  /** The `item.status` event to append. */
  event: { type: 'item.status'; actor: string; data: Record<string, unknown> };
  /** The Notion `Status` write: engine-made, never from an agent outbox (WP-108). */
  notion: { property: 'Status'; value: ItemStatus; by: 'engine' };
  /** Set when the item is Blocked: a blocking question must be raised with this summary. */
  question?: { reason: 'blocked' | 'attempt_limit'; summary: string };
}

export type Result = Applied | Refusal;

const refuse = (code: RefusalCode, message: string, failed?: Guard[]): Refusal => ({
  ok: false,
  code,
  message,
  ...(failed ? { failed } : {}),
});

const matches = (t: Transition, from: ItemStatus): boolean =>
  t.from === from ||
  (t.from === 'open' && OPEN.includes(from)) ||
  (t.from === 'before_done' && BEFORE_DONE.includes(from));

/** Builds a state machine over a table. Tests build one over a mutated table to prove they would notice. */
export function createMachine(table: readonly Transition[] = TRANSITIONS): {
  transition: (state: ItemState, req: TransitionRequest) => Result;
  edges: (from: ItemStatus) => Transition[];
} {
  const edges = (from: ItemStatus): Transition[] => table.filter((t) => matches(t, from));

  const transition = (state: ItemState, req: TransitionRequest): Result => {
    const { to, actor, facts } = req;
    const edge = edges(state.status).find((t) =>
      t.to === 'previous' ? to === state.blocked_from : t.to === to,
    );
    // (1) the edge exists and the actor may drive it
    if (edge === undefined) {
      if (state.status === 'Blocked' && to !== 'Blocked' && to !== 'Cancelled')
        return refuse(
          'wrong_return',
          `a Blocked item returns only to ${state.blocked_from ?? 'its previous status'}, not ${to}`,
        );
      return refuse('no_such_edge', `${state.status} -> ${to} is not a transition`);
    }
    if (!edge.actors.includes(actor))
      return refuse(
        'actor_not_allowed',
        `${actor} may not move ${state.status} -> ${to} (allowed: ${edge.actors.join(', ')})`,
      );

    // (2) every guard is true
    const failed = edge.guards.filter((g) => facts.guards[g] !== true);
    if (failed.length > 0)
      return refuse(
        'guard_failed',
        `${state.status} -> ${to}: ${failed.join(', ')} not satisfied`,
        [...failed],
      );

    // (3) not a hard-stop matter (Blocked and Cancelled are how a hard stop is held, so they pass)
    if (facts.hard_stop === true && to !== 'Blocked' && to !== 'Cancelled')
      return refuse(
        'hard_stop',
        `${state.status} -> ${to} is a hard-stop matter; only a human decision moves it`,
      );

    // (4) budget, where the target spends
    if (SPENDING.includes(to) && facts.budget_available !== true)
      return refuse('no_budget', `no budget left for a run in ${to}`);

    // Apply. The attempt counter moves only on the rework arrows; the third failure blocks.
    const base: ItemState = { ...state, run_failures: 0 };
    const finish = (
      next: ItemState,
      redirected: boolean,
      question?: Applied['question'],
    ): Applied => ({
      ok: true,
      next,
      redirected,
      event: {
        type: 'item.status',
        actor,
        data: {
          from: state.status,
          to: next.status,
          attempt: next.attempt,
          ...(redirected ? { requested: to } : {}),
          ...(facts.reason ? { reason: facts.reason } : {}),
        },
      },
      notion: { property: 'Status', value: next.status, by: 'engine' },
      ...(question ? { question } : {}),
    });

    if (edge.rework === true) {
      const attempt = state.attempt + 1;
      if (attempt > MAX_FAILED_ATTEMPTS) {
        const reason = `failed review or QA ${MAX_FAILED_ATTEMPTS} times`;
        return finish(
          {
            ...base,
            attempt,
            status: 'Blocked',
            blocked_from: state.status,
            blocked_reason: reason,
          },
          true,
          {
            reason: 'attempt_limit',
            summary: `${reason}; options: re-scope the story, change the approach, or cancel it`,
          },
        );
      }
      return finish(
        { ...base, attempt, status: to, blocked_from: null, blocked_reason: null },
        false,
      );
    }
    if (to === 'Blocked') {
      const reason = facts.reason ?? '';
      return finish(
        { ...base, status: 'Blocked', blocked_from: state.status, blocked_reason: reason },
        false,
        { reason: 'blocked', summary: reason },
      );
    }
    return finish({ ...base, status: to, blocked_from: null, blocked_reason: null }, false);
  };

  return { transition, edges };
}

const machine = createMachine();

/** The one machine the engine uses. */
export const transition = machine.transition;
/** The transitions that leave a status. */
export const edgesFrom = machine.edges;

/**
 * Counts a failed run (spec 7.12: the first is retried, the second blocks the item). Returns the
 * new counter and whether the item must now be Blocked (the caller asks `transition` for it).
 */
export function afterRunFailure(state: ItemState): { run_failures: number; block: boolean } {
  const run_failures = state.run_failures + 1;
  return { run_failures, block: run_failures >= MAX_RUN_FAILURES };
}

export const isTerminal = (s: ItemStatus): boolean => s === 'Released' || s === 'Cancelled';
export { ITEM_STATUSES };
