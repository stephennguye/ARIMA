import { UNIT_KINDS } from './kinds.js';
import type { UnitKind } from './kinds.js';
import type { Role } from './ledger.js';
import type { Size } from './item.js';
import type { PlannedUnit } from './queue.js';

/**
 * The work units of the daily run: turn caps, tasks and output contracts per kind (F02 section 8,
 * RD-F02-4). `TURN_CAPS` is the ONE table of turn caps; agent cards quote it and keep no numbers of
 * their own. Values are estimates until the card measurements replace them.
 */

export type Caps = { S: number; M: number; L: number } | null;
const flat = (n: number): Caps => ({ S: n, M: n, L: n });

/** Max turns per kind and size. `null`: no model run (code only). Every kind of `03-contracts.md` 3.1 has an entry. */
export const TURN_CAPS: Record<UnitKind, Caps> = {
  develop: { S: 30, M: 50, L: 80 },
  skeleton: flat(80),
  hotfix: flat(50),
  fix: flat(50),
  'test-write': { S: 20, M: 30, L: 40 },
  qa: flat(40),
  regression: flat(40),
  'perf-test': flat(40),
  'a11y-test': flat(40),
  'e2e-skeleton': flat(40),
  review: { S: 20, M: 30, L: 40 },
  'adr-review': flat(25),
  conventions: flat(25),
  'rc-freeze': flat(25),
  'deprecation-check': flat(25),
  'debt-review': flat(25),
  'design-qa': flat(25),
  author: flat(40),
  'release-docs': flat(40),
  'env-plan': flat(40),
  runbook: flat(40),
  'uat-script': flat(40),
  'security-scan': flat(30),
  'scan-triage': flat(25),
  'verify-finding': flat(25),
  screen: flat(25),
  'deploy-staging': flat(25),
  'preview-diagnose': flat(25),
  triage: flat(30),
  meeting: flat(20),
  'gate-pack': flat(25),
  retro: flat(30),
  digest: null,
};

/** The turn cap of a unit, or undefined when the kind has no model run. */
export function turnCap(kind: UnitKind, size: Size | undefined): number | undefined {
  const c = TURN_CAPS[kind];
  return c === null ? undefined : c[size ?? 'M'];
}

/** Kinds whose work happens in a git worktree of its own. */
const WORKTREE_KINDS: ReadonlySet<UnitKind> = new Set([
  'develop',
  'skeleton',
  'hotfix',
  'fix',
  'test-write',
  'qa',
]);
export const needsWorktree = (kind: UnitKind, role: Role): boolean =>
  WORKTREE_KINDS.has(kind) && !(kind === 'fix' && role === 'devops');
/** QA sees only these paths (no product source, no developer notes). */
export const QA_SPARSE = ['tests/', 'api/', 'design/', 'package.json'] as const;

/** Kinds whose report carries a verdict that moves the story or is posted to the pull request. */
export const REVIEW_KINDS: ReadonlySet<UnitKind> = new Set([
  'review',
  'qa',
  'design-qa',
  'security-scan',
]);

const TASKS: Partial<Record<UnitKind, string>> = {
  develop:
    'Implement exactly this one item on the branch in your worktree, to the Definition of Done. First restate the acceptance criteria as AC-1..n; if one is ambiguous, untestable or contradicts the API spec, stop and ask (a question addressed to the ba or the architect) instead of guessing, and write no code. Otherwise write the code and its unit tests (tests first where there is logic), run the build, lint and tests, commit with Conventional Commits using the item id as scope, and map every acceptance criterion to code and a test in `criteria_map` with evidence. Never edit tests/e2e (QA owns it). Do not push and do not open a pull request: the host does that after you finish.',
  hotfix:
    'Fix this incident with the smallest safe change on the branch in your worktree, with a test that reproduces it. Commit with the item id as scope. The host pushes and opens the pull request.',
  fix: 'Repair the broken build on the branch in your worktree with the smallest safe change. Commit with a conventional message that carries a task or run id.',
  'test-write':
    'Write the test cases and end-to-end tests for this story from its acceptance criteria, in `tests/` of your worktree, before any development. Propose each test case as a record in `records` (database `test_cases`); the engine issues the ids.',
  qa: 'Test this story on its preview against every test case and acceptance criterion. Record each test case result, raise a finding with evidence for every failure, and propose each defect as a record in `records` (database `bugs`). Give a verdict: pass only if every test case passed.',
  review:
    'Review the pull request in the packet against the acceptance criteria, the conventions and the architecture. Report only findings you can support with a file and line. Give a verdict: approve, or changes_requested with the blocking findings.',
  'design-qa':
    "Compare the preview with the story's screens, state by state (empty, loading, error, success). Record each deviation as a finding. Give a verdict: pass only if every state matches or each deviation is accepted.",
  'env-plan':
    'Write docs/ops/env-matrix.md from its template: the local Compose projects (preview-<pr>, staging, production), ports, volumes, capacity limits, the backup and restore plan and the pipeline design (GitHub Actions: ci.yml and security-weekly.yml only). Hosting is the owner machine with Docker Compose; no cloud account or paid service. Cite the SAD and ADRs, and mark guesses as guesses.',
  'deploy-staging':
    'The host rebuilt staging after a merge; its result is in the packet. Verify it: run `arima-env status staging` and `arima-env smoke staging`, and report with evidence whether staging is healthy. If it is not, or the result says the smoke test failed, find the cause with `arima-env logs staging` and the Compose file and Dockerfile in the repository (the previous version was restored when there was one) and report it. Do not edit files and do not start or stop anything: propose the fix as a finding or a question.',
  author:
    'Write the one artifact named in the packet from its template, citing sources, and mark guesses as guesses. Propose Notion records through `records` and ask only critical questions.',
  triage:
    'Triage this incident: establish impact and cause from the evidence in the packet, and propose a mitigation. Do not take any action yourself.',
  'security-scan':
    'Run the scan named in the packet and report findings with severity, location and evidence. Give a verdict: fail on any critical or high finding.',
};

export function taskFor(
  u: Pick<PlannedUnit, 'kind' | 'role' | 'item' | 'why'>,
  extra = '',
): string {
  const base =
    TASKS[u.kind] ??
    `Do the ${u.kind} work for ${u.item}, as ${u.role}, following your role instructions.`;
  return `${base}\n\nWhy this unit exists today: ${u.why}.${extra ? `\n\n${extra}` : ''}`;
}

/** What the final message must end with, for the packet's `Output contract` section. */
export function outputContractFor(kind: UnitKind): string {
  const verdict = REVIEW_KINDS.has(kind) ? ' Include `verdict` (`result` and `reasons`).' : '';
  const criteria =
    kind === 'develop' || kind === 'qa'
      ? ' Include `criteria_map` (every criterion with `met`, `unmet` or `unclear` and evidence as `file:line` or a test case id; `met` needs evidence).'
      : '';
  return [
    'End your final message with exactly one fenced block whose info string is `arima-report`, containing JSON:',
    '`schema_version` 1, `run_id` (the id in the title of this packet), `role`, `item`, `status` (`done`, `blocked`, `failed` or `needs_input`; when any question has `blocking` true the status MUST be `needs_input` or `blocked`, never `done`),`summary` (at most 600 characters), and as needed `artifacts`, `findings`, `questions`, `decisions`, `assumptions`, `records`.' +
      criteria +
      verdict,
    'Each of these is a list of objects, never plain strings: `artifacts` {path, kind (code|test|doc|design|api|infra), artifact_id?}; `findings` {severity (blocker|major|minor|nit), location (file:line), claim, evidence, recommendation}; `questions` {addressed_to? (a role: ba, architect, ux, tech-lead, qa, security or devops, for a consult between roles; leave it out to ask the owner), question, options [{label, recommendation (true|false)}] (1 to 6), blocking (true|false), hard_stop? (one of G0-G4, prod_deploy, secrets_change, budget_exceeded, story_budget, notion_delete, prod_data_migration, new_paid_service, licence, critical_finding, kill_switch, missing_credential: set it when the matter is one of these, with blocking true and no default), default? (what happens if nobody answers: required when blocking is false)}; `decisions` {summary, options_considered [strings], chosen, reversible (true|false), rationale}; `assumptions` {text, basis}. Use exactly the keys listed for each object and no others (an unknown key makes the whole report invalid).',
    'Propose records without ids (use `NEW-1`, `NEW-2` ... to refer between them); the engine issues every id. Ask a question only for a hard-stop matter or a critical blocker; decide everything else and log it as a decision.',
  ].join('\n');
}

/** Every kind has a turn-cap entry (a kind with none is refused at planning). */
export const missingTurnCaps = (): UnitKind[] => UNIT_KINDS.filter((k) => !(k in TURN_CAPS));
