import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './lib/atomic-file.js';
import { withFileLock } from './lib/filelock.js';
import { describeError, getValidator } from './lib/schema.js';
import { itemSpent } from './story-budget.js';
import type { Profile } from './profiles.js';

/** Item types of the Stories database (spec 8.2). */
export const ITEM_TYPES = ['Story', 'Bug fix', 'Tech task', 'Spike'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Ticket states (spec 7.1). */
export const ITEM_STATUSES = [
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'In QA',
  'PO Acceptance',
  'Done',
  'Released',
  'Blocked',
  'Cancelled',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const SIZES = ['S', 'M', 'L'] as const;
export type Size = (typeof SIZES)[number];
/** Milestone points per size (D-27). */
export const SIZE_POINTS: Record<Size, number> = { S: 1, M: 2, L: 4 };

/** The counters the engine holds for an item (03-contracts 9a). */
export interface ItemRecord {
  schema_version: 1;
  id: string;
  attempt: number;
  run_failures: number;
  blocked_from?: Exclude<ItemStatus, 'Done' | 'Released' | 'Blocked' | 'Cancelled'> | null;
  blocked_reason?: string | null;
  cost_usd_total: number;
}

export const itemFile = (projectDir: string, id: string): string =>
  path.join(projectDir, '.arima', 'items', `${id}.json`);

export const newItem = (id: string): ItemRecord => ({
  schema_version: 1,
  id,
  attempt: 1,
  run_failures: 0,
  cost_usd_total: 0,
});

/** Reads an item's counters; an item the engine has not touched yet has the initial ones. */
export function readItem(projectDir: string, id: string): ItemRecord {
  const file = itemFile(projectDir, id);
  if (!existsSync(file)) return newItem(id);
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const validate = getValidator('item');
  if (!validate(data))
    throw new Error(`Corrupt ${file}: ${(validate.errors ?? []).map(describeError).join('; ')}`);
  const item = data as ItemRecord;
  if (item.id !== id) throw new Error(`Corrupt ${file}: it holds item ${item.id}`);
  return item;
}

/**
 * Updates an item's counters under a lock. **Only the ticket state machine (WP-107) calls this**:
 * `attempt`, `run_failures` and `blocked_*` are never writable by an agent (the guard blocks
 * `.arima/` for file tools). `cost_usd_total` is always re-derived from the ledger.
 */
export async function updateItem(
  projectDir: string,
  id: string,
  change: (current: ItemRecord) => ItemRecord,
): Promise<ItemRecord> {
  const file = itemFile(projectDir, id);
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const next = change(readItem(projectDir, id));
    next.cost_usd_total = itemSpent(projectDir, id);
    const validate = getValidator('item');
    if (!validate(next))
      throw new Error(
        `Invalid item ${id}: ${(validate.errors ?? []).map(describeError).join('; ')}`,
      );
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

// ---------------------------------------------------------------------------------------------
// Definition of Ready (spec 7.1 Backlog -> Ready, 8.2)

/** The elements a DoR can fail on; each failure names one. */
export type DoRElement =
  | 'acceptance_criteria'
  | 'criteria_format'
  | 'linked_req'
  | 'complexity'
  | 'screens'
  | 'dependencies'
  | 'api_coverage';

export interface DoRInput {
  id: string;
  type: ItemType;
  complexity?: string | undefined;
  /** The `Acceptance criteria` text of the story. */
  acceptance_criteria?: string | undefined;
  /** REQ ids the story is linked to. */
  linked_reqs: string[];
  /** The `## Screens` section of the story body; see `storyScreens`. */
  screens?: string | undefined;
  /** Items this one depends on that are not Done or Released yet. */
  open_dependencies: string[];
  /** Whether `api/openapi.yaml` covers the endpoints the item needs (true when it needs none). */
  api_covered?: boolean | undefined;
}

export interface DoRProblem {
  element: DoRElement;
  detail: string;
}

export interface DoRResult {
  ready: boolean;
  problems: DoRProblem[];
}

export const SCREEN_STATES = ['empty', 'loading', 'error', 'success'] as const;

const NA = /^\s*(n\/a|none|no ui|not applicable)\b/i;

/**
 * What the `## Screens` section of a story says about its UI: `no_ui` when it is explicitly "n/a"
 * or "none", `ui` when it has content (it must link `design/screens/<id>/`), and `unknown` when it
 * is empty or only the template comment, which is never enough to call a story ready.
 */
export function storyScreens(section: string | undefined): 'ui' | 'no_ui' | 'unknown' {
  const text = (section ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (text === '') return 'unknown';
  return NA.test(text) ? 'no_ui' : 'ui';
}

/** The text of the `## Screens` H2 of a story body, or undefined. */
export function screensSection(body: string): string | undefined {
  const m = /^## Screens[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  return m?.[1];
}

/** Splits an `Acceptance criteria` text into criteria: a new one starts at a numbered or bulleted line, or at "Given". */
export function splitCriteria(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const marker = /^(?:\d+[.)]|[-*])\s+/.exec(line);
    const startsNew = marker !== null || /^given\b/i.test(line) || out.length === 0;
    const clean = marker ? line.slice(marker[0].length) : line;
    if (startsNew) out.push(clean);
    else out[out.length - 1] += ` ${clean}`;
  }
  return out;
}

const GWT = /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;

/**
 * The Definition of Ready, checked for every element and with the element named (spec 7.1):
 * testable acceptance criteria, a linked REQ, screens for UI stories, a size, no open dependency,
 * and an API spec that covers it. Types differ (spec 8.2): a bug fix needs repro-and-expect
 * criteria but no REQ; a tech task needs criteria and a size only; a spike needs the questions it
 * answers and a size (its criteria are not Given/When/Then). Profile aware: where the profile's
 * RTM covers all requirements (regulated), every item but a spike must link a REQ. Screens are
 * checked from `design/screens/<id>/` (decision D3 of the ba card).
 */
export function checkDoR(projectDir: string, input: DoRInput, profile: Profile): DoRResult {
  const problems: DoRProblem[] = [];
  const add = (element: DoRElement, detail: string): number => problems.push({ element, detail });
  const t = input.type;

  // acceptance criteria
  const text = (input.acceptance_criteria ?? '').trim();
  const criteria = text === '' ? [] : splitCriteria(text);
  if (criteria.length === 0) {
    add(
      'acceptance_criteria',
      t === 'Spike' ? 'a spike needs the question(s) it answers' : 'no acceptance criteria',
    );
  } else if (t === 'Story' || t === 'Bug fix') {
    criteria.forEach((c, i) => {
      if (!GWT.test(c))
        add('criteria_format', `criterion ${i + 1} is not Given/When/Then: "${c.slice(0, 60)}"`);
    });
  }

  // linked requirement
  const reqs = input.linked_reqs.filter((r) => /^REQ-\d+$/.test(r));
  const needsReq =
    t === 'Story' || (t !== 'Spike' && profile.rules.rtm_coverage_at_g3 === 'all_requirements');
  if (needsReq && reqs.length === 0)
    add(
      'linked_req',
      `${t} ${input.id} links no REQ${t === 'Story' ? '' : ' (this profile traces every item to a requirement)'}`,
    );

  // size
  if (!(SIZES as readonly string[]).includes(input.complexity ?? ''))
    add(
      'complexity',
      `complexity is "${input.complexity ?? ''}"; it must be S, M or L (larger work is split)`,
    );

  // screens (UI stories and bug fixes that touch a UI)
  if (t === 'Story' || t === 'Bug fix') {
    const kind = storyScreens(input.screens);
    if (kind === 'unknown' && t === 'Story')
      add(
        'screens',
        'the Screens section is empty: write "n/a" for a story with no UI, or link design/screens/' +
          input.id +
          '/',
      );
    if (kind === 'ui') {
      const dir = path.join(projectDir, 'design', 'screens', input.id);
      for (const state of SCREEN_STATES)
        if (!existsSync(path.join(dir, `${state}.html`)))
          add(
            'screens',
            `missing design/screens/${input.id}/${state}.html (all four states are required)`,
          );
      if (!existsSync(path.join(dir, 'a11y.md')))
        add('screens', `missing design/screens/${input.id}/a11y.md`);
    }
  }

  // dependencies
  if (input.open_dependencies.length > 0)
    add('dependencies', `open dependencies: ${input.open_dependencies.join(', ')}`);

  // API coverage
  if (t === 'Story' || t === 'Bug fix') {
    if (input.api_covered !== true)
      add(
        'api_coverage',
        input.api_covered === false
          ? 'api/openapi.yaml does not cover what this item needs'
          : 'API coverage has not been checked',
      );
  }

  return { ready: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------------------------
// The DoR / DoD page (spec 6.2 step 3: "DoR and DoD from the profile")

const reviewers = (p: Profile): string =>
  p.rules.code_review.reviewers === 1
    ? 'one reviewer (the tech-lead)'
    : `${p.rules.code_review.reviewers} reviewers (the tech-lead and a second ${p.rules.code_review.mode} review)`;

/**
 * The text of the DoR/DoD page for a profile. The two H2 headings are the required sections of
 * the `dor-dod` template (`Definition of Ready`, `Definition of Done`); everything under them is
 * derived from the same rules `checkDoR` and the state machine enforce, so the page cannot say
 * something the code does not do.
 */
export function renderDorDod(profile: Profile): string {
  const allReqs = profile.rules.rtm_coverage_at_g3 === 'all_requirements';
  const rtm =
    profile.rules.rtm_coverage_at_g3 === 'none'
      ? 'No traceability coverage rule applies at G3 for this profile.'
      : profile.rules.rtm_coverage_at_g3 === 'must_requirements'
        ? 'Every Must requirement is covered by a story and a passing test case at G3.'
        : 'Every requirement is covered by a story and a passing test case at G3.';
  const lines = [
    '# DoR / DoD',
    '',
    `<!-- arima-template: dor-dod; generated from profile ${profile.name} by arima (spec 6.2 step 3). Owner: orchestrator. Master location: Notion page. -->`,
    '',
    '## Definition of Ready',
    '',
    `A story moves from Backlog to Ready only when the engine finds every element below true (profile: ${profile.name}). The ba states which elements hold; the engine decides.`,
    '',
    '### Story',
    '- Acceptance criteria are present and each one is Given / When / Then.',
    '- At least one linked REQ.',
    '- Screens: for a UI story, `design/screens/<id>/` holds empty, loading, error and success states and `a11y.md`; a story with no UI says "n/a" in its Screens section.',
    '- Complexity is S, M or L (anything larger is split).',
    '- No open dependency.',
    '- The API spec (`api/openapi.yaml`) covers what the story needs.',
    '',
    '### Bug fix',
    '- Acceptance criteria say how to reproduce the bug and what is expected, each Given / When / Then.',
    allReqs
      ? '- At least one linked REQ (this profile traces every item).'
      : '- A linked REQ is not required.',
    '- Complexity is S, M or L; no open dependency; the API spec covers it.',
    '',
    '### Tech task',
    '- Acceptance criteria are present (a plain done-when list is enough).',
    allReqs
      ? '- At least one linked REQ (this profile traces every item).'
      : '- A linked REQ is not required.',
    '- Complexity is S, M or L; no open dependency.',
    '',
    '### Spike',
    '- The question(s) the spike answers are written as its acceptance criteria.',
    '- Complexity is S, M or L; no open dependency.',
    '',
    '## Definition of Done',
    '',
    'A story is Done when all of these hold:',
    '',
    '- A pull request is open and CI is green.',
    '- Every acceptance criterion is mapped to code and to a test case, with evidence.',
    `- Code review: ${reviewers(profile)}${profile.rules.code_review.human_pr_approval ? '; the human approves the pull request' : ''}.`,
    '- Every test case written for the story passed in QA; design QA passed for a UI story.',
    '- No secret in the change; no change to CI, hooks or infrastructure unless the story is a devops story.',
    `- Security sign-off at G3: ${profile.rules.security_signoff_g3.replaceAll('_', ' ')}.`,
    `- ${rtm}`,
    '',
  ];
  return lines.join('\n');
}
