// WP-107: the ticket state machine, tested exhaustively against an independent copy of the spec
// table (03-contracts 9, spec 7.1). A mutated table must fail the same suite.
import { describe, expect, it } from 'vitest';
import { ITEM_STATUSES } from '../src/item.js';
import type { ItemStatus } from '../src/item.js';
import {
  ACTORS,
  MAX_FAILED_ATTEMPTS,
  TRANSITIONS,
  afterRunFailure,
  createMachine,
  edgesFrom,
  isTerminal,
  transition,
} from '../src/state-machine.js';
import type { Actor, Guard, ItemState, Transition } from '../src/state-machine.js';

// ---- the oracle: spec 7.1 written out row by row, sharing nothing with the implementation ----
interface Row {
  from: ItemStatus;
  to: ItemStatus;
  actors: Actor[];
  guards: Guard[];
}
const OPEN: ItemStatus[] = [
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'In QA',
  'PO Acceptance',
];
const AGENT_ACTORS: Actor[] = [
  'orchestrator',
  'ba',
  'ux',
  'architect',
  'tech-lead',
  'developer',
  'qa',
  'security',
  'devops',
  'engine',
];
const ORACLE: Row[] = [
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
  { from: 'In Review', to: 'In Progress', actors: ['tech-lead'], guards: ['changes_requested'] },
  {
    from: 'In Review',
    to: 'In QA',
    actors: ['tech-lead'],
    guards: ['review_approved', 'preview_deployed'],
  },
  { from: 'In QA', to: 'In Progress', actors: ['qa'], guards: ['test_failed', 'bug_linked'] },
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
  ...OPEN.map((from): Row => ({
    from,
    to: 'Blocked',
    actors: AGENT_ACTORS,
    guards: ['reason_recorded'],
  })),
  ...[...OPEN, 'Blocked' as const].map((from): Row => ({
    from,
    to: 'Cancelled',
    actors: ['po'],
    guards: ['reason_recorded'],
  })),
];
const REWORK = new Set(['In Review>In Progress', 'In QA>In Progress']);
const ALL_GUARDS: Guard[] = [...new Set(ORACLE.flatMap((r) => r.guards))].concat([
  'cause_resolved',
]);

const state = (status: ItemStatus, over: Partial<ItemState> = {}): ItemState => ({
  status,
  attempt: 1,
  run_failures: 0,
  blocked_from: status === 'Blocked' ? 'In Progress' : null,
  ...over,
});
const guardsOf = (names: Guard[], off: Guard[] = []): Partial<Record<Guard, boolean>> =>
  Object.fromEntries(names.filter((g) => !off.includes(g)).map((g) => [g, true]));
const facts = (names: Guard[], off: Guard[] = [], more: object = {}) => ({
  guards: guardsOf(names, off),
  budget_available: true,
  reason: 'because',
  ...more,
});

type Machine = ReturnType<typeof createMachine>;

/** Everything the spec says, as a list of violations; empty means the machine conforms. */
function violations(m: Machine): string[] {
  const out: string[] = [];
  const t = m.transition;
  // every (from, to, actor): legal exactly when the oracle says so, with all guards true
  for (const from of ITEM_STATUSES)
    for (const to of ITEM_STATUSES)
      for (const actor of ACTORS) {
        const isBlockedReturn = from === 'Blocked' && to === 'In Progress'; // blocked_from is In Progress here
        const row = isBlockedReturn
          ? actor === 'orchestrator'
            ? ({ from, to, actors: [actor], guards: [] } as Row)
            : undefined
          : ORACLE.find((r) => r.from === from && r.to === to && r.actors.includes(actor));
        const edgeExists = isBlockedReturn || ORACLE.some((r) => r.from === from && r.to === to);
        const s = from === 'Blocked' ? state(from, { blocked_from: 'In Progress' }) : state(from);
        const res = t(s, { to, actor, facts: facts(ALL_GUARDS) });
        if (row && !res.ok) out.push(`${from} -> ${to} by ${actor} should pass: ${res.message}`);
        if (!row && res.ok) out.push(`${from} -> ${to} by ${actor} should be refused`);
        const noEdgeCode = from === 'Blocked' && to !== 'Blocked' ? 'wrong_return' : 'no_such_edge';
        if (!row && !res.ok && res.code !== (edgeExists ? 'actor_not_allowed' : noEdgeCode))
          out.push(`${from} -> ${to} by ${actor}: wrong refusal ${res.code}`);
      }
  // Blocked returns only to where it came from (a separate edge: the oracle row is `previous`)
  for (const prev of OPEN)
    for (const to of ITEM_STATUSES) {
      const res = t(state('Blocked', { blocked_from: prev }), {
        to,
        actor: 'orchestrator',
        facts: facts(ALL_GUARDS),
      });
      const legal = to === prev;
      if (legal !== res.ok)
        out.push(`Blocked(from ${prev}) -> ${to} should ${legal ? 'pass' : 'be refused'}`);
    }
  // every guard of every edge, switched off alone, refuses with that guard named
  for (const r of ORACLE)
    for (const g of r.guards) {
      const s = r.from === 'Blocked' ? state(r.from) : state(r.from);
      const res = t(s, { to: r.to, actor: r.actors[0] as Actor, facts: facts(r.guards, [g]) });
      if (res.ok || res.code !== 'guard_failed' || !res.failed?.includes(g))
        out.push(`${r.from} -> ${r.to}: guard ${g} must refuse`);
    }
  // a missing fact is false
  for (const r of ORACLE) {
    const res = t(state(r.from), {
      to: r.to,
      actor: r.actors[0] as Actor,
      facts: { guards: {}, budget_available: true },
    });
    if (res.ok) out.push(`${r.from} -> ${r.to} passed with no facts`);
  }
  // attempt counting: only the two rework arrows increment
  for (const r of ORACLE) {
    const res = t(state(r.from, { attempt: 2 }), {
      to: r.to,
      actor: r.actors[0] as Actor,
      facts: facts(r.guards),
    });
    if (!res.ok) continue;
    const want = REWORK.has(`${r.from}>${r.to}`) ? 3 : 2;
    if (res.next.attempt !== want)
      out.push(`${r.from} -> ${r.to}: attempt ${res.next.attempt}, want ${want}`);
  }
  // the return from Blocked needs its guard and leaves the attempt counter alone
  {
    const blocked = state('Blocked', { blocked_from: 'In Review', attempt: 2 });
    const no = t(blocked, { to: 'In Review', actor: 'orchestrator', facts: facts([]) });
    if (no.ok || no.code !== 'guard_failed' || !no.failed?.includes('cause_resolved'))
      out.push('Blocked -> previous must need cause_resolved');
    const yes = t(blocked, {
      to: 'In Review',
      actor: 'orchestrator',
      facts: facts(['cause_resolved']),
    });
    if (!yes.ok || yes.next.attempt !== 2)
      out.push('Blocked -> previous must keep the attempt counter');
  }
  // the third failed attempt blocks and raises a question, from either rework arrow
  for (const [from, actor, g] of [
    ['In Review', 'tech-lead', 'changes_requested'],
    ['In QA', 'qa', 'test_failed'],
  ] as const) {
    const ok = t(state(from, { attempt: MAX_FAILED_ATTEMPTS - 1 }), {
      to: 'In Progress',
      actor,
      facts: facts([g, 'bug_linked']),
    });
    if (!ok.ok || ok.next.status !== 'In Progress' || ok.redirected)
      out.push(`${from}: the second failure must return to In Progress`);
    const third = t(state(from, { attempt: MAX_FAILED_ATTEMPTS }), {
      to: 'In Progress',
      actor,
      facts: facts([g, 'bug_linked']),
    });
    if (
      !third.ok ||
      third.next.status !== 'Blocked' ||
      !third.redirected ||
      third.next.blocked_from !== from ||
      third.question?.reason !== 'attempt_limit'
    )
      out.push(`${from}: the third failure must Block with a question`);
  }
  // hard stops and budget
  for (const r of ORACLE) {
    const hard = t(state(r.from), {
      to: r.to,
      actor: r.actors[0] as Actor,
      facts: facts(r.guards, [], { hard_stop: true }),
    });
    const holds = r.to === 'Blocked' || r.to === 'Cancelled';
    if (holds !== hard.ok)
      out.push(
        `${r.from} -> ${r.to}: a hard-stop matter should ${holds ? 'still be holdable' : 'be refused'}`,
      );
    const spends = ['In Progress', 'In Review', 'In QA'].includes(r.to);
    const poor = t(state(r.from), {
      to: r.to,
      actor: r.actors[0] as Actor,
      facts: facts(r.guards, [], { budget_available: false }),
    });
    if (spends === poor.ok)
      out.push(`${r.from} -> ${r.to}: without budget it should ${spends ? 'be refused' : 'pass'}`);
  }
  // terminal states have no way out
  for (const from of ['Released', 'Cancelled'] as const)
    for (const to of ITEM_STATUSES)
      for (const actor of ACTORS)
        if (t(state(from, { blocked_from: null }), { to, actor, facts: facts(ALL_GUARDS) }).ok)
          out.push(`${from} -> ${to} must not exist`);
  return out;
}

describe('the real machine conforms to the spec table', () => {
  it('every legal edge passes and every other (from, to, actor) is refused', () => {
    expect(violations(createMachine())).toEqual([]);
    expect(violations({ transition, edges: edgesFrom })).toEqual([]);
  });

  it('the exported table has one row per spec row (13)', () => {
    expect(TRANSITIONS).toHaveLength(13);
  });
});

describe('mutating the table fails a test', () => {
  const mutants: [string, Transition[]][] = [];
  TRANSITIONS.forEach((t, i) => {
    const drop = (arr: Transition[]): Transition[] => arr.filter((_, j) => j !== i);
    mutants.push([`drop row ${i} (${t.from} -> ${t.to})`, drop([...TRANSITIONS])]);
    mutants.push([
      `let any actor drive row ${i}`,
      TRANSITIONS.map((x, j) => (j === i ? { ...x, actors: ACTORS } : x)),
    ]);
    mutants.push([
      `add an actor to row ${i}`,
      TRANSITIONS.map((x, j) =>
        j === i
          ? { ...x, actors: [...x.actors, ACTORS.find((a) => !x.actors.includes(a)) as Actor] }
          : x,
      ),
    ]);
    t.guards.forEach((g, k) =>
      mutants.push([
        `drop guard ${g} of row ${i}`,
        TRANSITIONS.map((x, j) =>
          j === i ? { ...x, guards: x.guards.filter((_, n) => n !== k) } : x,
        ),
      ]),
    );
    mutants.push([
      `flip rework of row ${i}`,
      TRANSITIONS.map((x, j) => (j === i ? { ...x, rework: !x.rework } : x)),
    ]);
  });
  mutants.push([
    'add Done -> In Progress',
    [...TRANSITIONS, { from: 'Done', to: 'In Progress', actors: ['po'], guards: [] }],
  ]);
  mutants.push([
    'add Released -> Done',
    [...TRANSITIONS, { from: 'Released', to: 'Done', actors: ['engine'], guards: [] }],
  ]);
  mutants.push([
    'make Blocked return anywhere',
    TRANSITIONS.map((x) =>
      x.to === 'previous' ? ({ ...x, from: 'Blocked', to: 'In Progress' } as const) : x,
    ),
  ]);
  mutants.push([
    'let Done be cancelled',
    TRANSITIONS.map((x): Transition => (x.to === 'Cancelled' ? { ...x, from: 'open' } : x)).concat([
      { from: 'Done', to: 'Cancelled', actors: ['po'], guards: ['reason_recorded'] },
    ]),
  ]);

  it(`all ${mutants.length} mutants are caught`, () => {
    expect(mutants.length).toBeGreaterThan(50);
    const survivors = mutants
      .filter(([, table]) => violations(createMachine(table)).length === 0)
      .map(([name]) => name);
    expect(survivors).toEqual([]);
  });
});

describe('transition results', () => {
  it('a legal move returns the next state, the item.status event and the engine-made Status write', () => {
    const r = transition(state('Backlog'), {
      to: 'Ready',
      actor: 'ba',
      facts: facts(['dor_met', 'priority_set'], [], { reason: undefined }),
    });
    expect(r).toMatchObject({
      ok: true,
      redirected: false,
      next: { status: 'Ready', attempt: 1, run_failures: 0, blocked_from: null },
      event: {
        type: 'item.status',
        actor: 'ba',
        data: { from: 'Backlog', to: 'Ready', attempt: 1 },
      },
      notion: { property: 'Status', value: 'Ready', by: 'engine' },
    });
  });

  it('a refusal says why: no edge, wrong actor, failed guards named, hard stop, no budget, wrong return', () => {
    const f = (names: Guard[], more: object = {}) => facts(names, [], more);
    expect(transition(state('Backlog'), { to: 'Done', actor: 'ba', facts: f([]) })).toMatchObject({
      code: 'no_such_edge',
    });
    expect(
      transition(state('Backlog'), {
        to: 'Ready',
        actor: 'developer',
        facts: f(['dor_met', 'priority_set']),
      }),
    ).toMatchObject({ code: 'actor_not_allowed' });
    expect(
      transition(state('Backlog'), { to: 'Ready', actor: 'ba', facts: f(['dor_met']) }),
    ).toMatchObject({ code: 'guard_failed', failed: ['priority_set'] });
    expect(
      transition(state('Backlog'), {
        to: 'Ready',
        actor: 'ba',
        facts: f(['dor_met', 'priority_set'], { hard_stop: true }),
      }),
    ).toMatchObject({ code: 'hard_stop' });
    expect(
      transition(state('Ready'), {
        to: 'In Progress',
        actor: 'orchestrator',
        facts: f(['test_cases_exist', 'story_budget_available', 'wip_ok'], {
          budget_available: false,
        }),
      }),
    ).toMatchObject({ code: 'no_budget' });
    expect(
      transition(state('Blocked', { blocked_from: 'In QA' }), {
        to: 'Ready',
        actor: 'orchestrator',
        facts: f(['cause_resolved']),
      }),
    ).toMatchObject({ code: 'wrong_return' });
  });

  it('the checks run in the contract order: edge and actor, then guards, then hard stop, then budget', () => {
    const none = { guards: {}, hard_stop: true, budget_available: false };
    expect(
      transition(state('Ready'), { to: 'In Progress', actor: 'qa', facts: none }),
    ).toMatchObject({ code: 'actor_not_allowed' });
    expect(
      transition(state('Ready'), { to: 'In Progress', actor: 'orchestrator', facts: none }),
    ).toMatchObject({ code: 'guard_failed' });
    const g = guardsOf(['test_cases_exist', 'story_budget_available', 'wip_ok']);
    expect(
      transition(state('Ready'), {
        to: 'In Progress',
        actor: 'orchestrator',
        facts: { ...none, guards: g },
      }),
    ).toMatchObject({ code: 'hard_stop' });
    expect(
      transition(state('Ready'), {
        to: 'In Progress',
        actor: 'orchestrator',
        facts: { guards: g, budget_available: false },
      }),
    ).toMatchObject({ code: 'no_budget' });
  });

  it('a full life: Backlog to Released, then nothing', () => {
    let s = state('Backlog');
    const step = (to: ItemStatus, actor: Actor, g: Guard[]): void => {
      const r = transition(s, { to, actor, facts: facts(g) });
      if (!r.ok) throw new Error(r.message);
      s = r.next;
    };
    step('Ready', 'ba', ['dor_met', 'priority_set']);
    step('In Progress', 'orchestrator', ['test_cases_exist', 'story_budget_available', 'wip_ok']);
    step('In Review', 'developer', ['pr_open', 'ci_green', 'criteria_mapped']);
    step('In QA', 'tech-lead', ['review_approved', 'preview_deployed']);
    step('PO Acceptance', 'merge-script', [
      'all_tests_passed',
      'design_qa_ok',
      'human_pr_approved',
    ]);
    step('Done', 'orchestrator', ['qa_passed']);
    step('Released', 'engine', ['production_deploy_recorded']);
    expect(s).toMatchObject({ status: 'Released', attempt: 1 });
    expect(isTerminal(s.status)).toBe(true);
    expect(edgesFrom('Released')).toEqual([]);
    expect(edgesFrom('Cancelled').length).toBe(0);
  });
});

describe('attempts, the third failure and Blocked', () => {
  const review = (s: ItemState) =>
    transition(s, { to: 'In Progress', actor: 'tech-lead', facts: facts(['changes_requested']) });
  const qa = (s: ItemState) =>
    transition(s, { to: 'In Progress', actor: 'qa', facts: facts(['test_failed', 'bug_linked']) });

  it('review and QA failures share one counter; the third moves the item to Blocked with a question', () => {
    let s = state('In Review');
    const a = review(s);
    if (!a.ok) throw new Error(a.message);
    expect(a.next).toMatchObject({ status: 'In Progress', attempt: 2 });
    s = { ...a.next, status: 'In QA' }; // (via In Review -> In QA in real life)
    const b = qa(s);
    if (!b.ok) throw new Error(b.message);
    expect(b.next).toMatchObject({ status: 'In Progress', attempt: 3 });
    const c = review({ ...b.next, status: 'In Review' });
    if (!c.ok) throw new Error(c.message);
    expect(c).toMatchObject({
      redirected: true,
      next: { status: 'Blocked', blocked_from: 'In Review', attempt: 4 },
      question: { reason: 'attempt_limit' },
    });
    expect(c.event.data).toMatchObject({
      from: 'In Review',
      to: 'Blocked',
      requested: 'In Progress',
    });
    expect(c.notion.value).toBe('Blocked');
  });

  it('a veto at the milestone review sends the story back without counting as an attempt', () => {
    const r = transition(state('PO Acceptance', { attempt: 2 }), {
      to: 'In Progress',
      actor: 'po',
      facts: facts(['vetoed', 'bug_with_reason']),
    });
    expect(r).toMatchObject({ ok: true, next: { status: 'In Progress', attempt: 2 } });
  });

  it('Blocked remembers where it came from and returns there once the cause is resolved', () => {
    const b = transition(state('In QA', { attempt: 2 }), {
      to: 'Blocked',
      actor: 'developer',
      facts: facts(['reason_recorded'], [], { reason: 'missing credential' }),
    });
    if (!b.ok) throw new Error(b.message);
    expect(b.next).toMatchObject({
      status: 'Blocked',
      blocked_from: 'In QA',
      blocked_reason: 'missing credential',
      attempt: 2,
    });
    expect(b.question).toEqual({ reason: 'blocked', summary: 'missing credential' });
    const back = transition(b.next, {
      to: 'In QA',
      actor: 'orchestrator',
      facts: facts(['cause_resolved']),
    });
    expect(back).toMatchObject({
      ok: true,
      next: { status: 'In QA', blocked_from: null, blocked_reason: null, attempt: 2 },
    });
    // a blocked item cannot return into a state without budget
    expect(
      transition(b.next, {
        to: 'In QA',
        actor: 'orchestrator',
        facts: facts(['cause_resolved'], [], { budget_available: false }),
      }),
    ).toMatchObject({ code: 'no_budget' });
  });

  it('blocking needs a recorded reason; cancelling needs a reason and only the po can do it', () => {
    expect(
      transition(state('Ready'), { to: 'Blocked', actor: 'orchestrator', facts: { guards: {} } }),
    ).toMatchObject({ code: 'guard_failed', failed: ['reason_recorded'] });
    expect(
      transition(state('Ready'), {
        to: 'Cancelled',
        actor: 'orchestrator',
        facts: facts(['reason_recorded']),
      }),
    ).toMatchObject({ code: 'actor_not_allowed' });
    expect(
      transition(state('Blocked'), {
        to: 'Cancelled',
        actor: 'po',
        facts: facts(['reason_recorded']),
      }),
    ).toMatchObject({ ok: true, next: { status: 'Cancelled' } });
  });

  it('run failures: the first is counted, the second says to block; any status change resets them', () => {
    const one = afterRunFailure(state('In Progress'));
    expect(one).toEqual({ run_failures: 1, block: false });
    const two = afterRunFailure(state('In Progress', { run_failures: 1 }));
    expect(two).toEqual({ run_failures: 2, block: true });
    const moved = transition(state('In Progress', { run_failures: 1 }), {
      to: 'Blocked',
      actor: 'engine',
      facts: facts(['reason_recorded'], [], { reason: 'second run failure' }),
    });
    expect(moved).toMatchObject({ ok: true, next: { run_failures: 0 } });
  });
});
