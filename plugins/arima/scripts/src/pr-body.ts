import { findAttribution } from './attribution.js';
import { findSecrets } from './lib/secrets.js';

/**
 * The pull request body (spec 10.2 "PR template sections"; WP-113): linked items, acceptance
 * criteria mapping (criterion, code, test), screenshots for UI, risk and rollback, and the DoD
 * checklist. `renderPrBody` writes it from the developer's validated report; `validatePrBody`
 * is the "DoD check before ready": every section is there, every criterion of the report appears
 * with evidence, a UI story has a screenshot, and no AI attribution or secret is in it.
 */

export const PR_SECTIONS = [
  'Linked items',
  'Acceptance criteria mapping',
  'Screenshots',
  'Risk and rollback',
  'Definition of Done',
] as const;

/** The DoD checklist of the template (the same list as the DoR/DoD page, `renderDorDod`). */
export const DOD_ITEMS = [
  'CI is green',
  'Every acceptance criterion is mapped to code and a test',
  'Review: the tech-lead reviewed it; a human approves the pull request',
  'Design QA passed (UI stories)',
  'No secret and no change to CI, hooks or infrastructure',
] as const;

export interface CriterionRow {
  criterion: string;
  status: 'met' | 'unmet' | 'unclear';
  /** `file:line` and test case ids. */
  evidence: string[];
}

export interface PrBodyInput {
  /** The story, bug or other item ids this PR delivers. */
  items: string[];
  summary?: string;
  criteria: CriterionRow[];
  ui: boolean;
  /** Screenshot links or paths for a UI story. */
  screenshots?: string[];
  risk: string;
  rollback: string;
  /** Which DoD items hold now (index in `DOD_ITEMS`); the rest are left unticked. */
  dodDone?: number[];
}

/** Renders the body. */
export function renderPrBody(i: PrBodyInput): string {
  const rows = i.criteria.map(
    (c) => `| ${c.criterion} | ${c.status} | ${c.evidence.join(', ') || '-'} |`,
  );
  const shots = i.ui
    ? (i.screenshots ?? [])
        .map((s) => `![${s.split('/').pop() ?? 'screenshot'}](${s})`)
        .join('\n') || '_UI story: add screenshots of every state._'
    : 'n/a (no UI)';
  const dod = DOD_ITEMS.map((t, n) => `- [${i.dodDone?.includes(n) ? 'x' : ' '}] ${t}`);
  return [
    '## Linked items',
    '',
    ...i.items.map((x) => `- ${x}`),
    ...(i.summary ? ['', i.summary] : []),
    '',
    '## Acceptance criteria mapping',
    '',
    '| Criterion | Status | Code and tests |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '## Screenshots',
    '',
    shots,
    '',
    '## Risk and rollback',
    '',
    `Risk: ${i.risk}`,
    '',
    `Rollback: ${i.rollback}`,
    '',
    '## Definition of Done',
    '',
    ...dod,
    '',
  ].join('\n');
}

export interface PrBodyCheck {
  ok: boolean;
  problems: string[];
}

const ITEM_ID = /\b(US|BUG|INC|CR)-\d+\b/;

function section(body: string, name: string): string | undefined {
  const m = new RegExp(`^## ${name}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(body);
  return m?.[1];
}

/**
 * The DoD check. `criteria` are the criterion ids of the developer's `criteria_map`; each must be
 * on a line of the mapping that also cites evidence (`file:line` or a test case id). `ready` also
 * requires every DoD box to be ticked (the check before a PR is declared ready for review).
 */
export function validatePrBody(
  body: string,
  o: { criteria?: string[]; ui?: boolean; ready?: boolean } = {},
): PrBodyCheck {
  const problems: string[] = [];
  const sections = new Map(PR_SECTIONS.map((s) => [s, section(body, s)] as const));
  for (const [name, text] of sections) {
    if (text === undefined) problems.push(`missing section "## ${name}"`);
    else if (text.trim() === '') problems.push(`section "${name}" is empty`);
  }
  const linked = sections.get('Linked items');
  if (linked !== undefined && !ITEM_ID.test(linked))
    problems.push('"Linked items" names no item id (US, BUG, INC or CR)');

  const mapping = sections.get('Acceptance criteria mapping');
  if (mapping !== undefined) {
    const lines = mapping.split('\n');
    for (const c of o.criteria ?? []) {
      const line = lines.find((l) =>
        new RegExp(
          `(^|[^A-Za-z0-9-])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`,
        ).test(l),
      );
      if (line === undefined)
        problems.push(`criterion ${c} is not in the acceptance criteria mapping`);
      else if (!/[\w./-]+:\d+|\bTC-\d+/.test(line))
        problems.push(`criterion ${c} cites no evidence (file:line or a test case id)`);
    }
  }
  const shots = sections.get('Screenshots');
  if (
    o.ui === true &&
    shots !== undefined &&
    !/!\[[^\]]*\]\([^)]+\)|https?:\/\/\S+\.(png|jpe?g|gif|webp)/i.test(shots)
  )
    problems.push('a UI story needs screenshots (an image link) in "Screenshots"');

  const dod = sections.get('Definition of Done');
  if (dod !== undefined) {
    const boxes = dod.split('\n').filter((l) => /^- \[[ xX]\] /.test(l));
    if (boxes.length === 0) problems.push('"Definition of Done" has no checklist');
    if (o.ready === true && boxes.some((l) => /^- \[ \]/.test(l)))
      problems.push(
        `not ready: unticked Definition of Done items: ${boxes
          .filter((l) => /^- \[ \]/.test(l))
          .map((l) => l.slice(6))
          .join('; ')}`,
      );
  }

  const attr = findAttribution(body);
  if (attr.length > 0) problems.push(`the body contains ${attr.join(' and ')} (D-48)`);
  const leaked = findSecrets(body);
  if (leaked.length > 0)
    problems.push(`the body looks like it contains a secret (${leaked.join(', ')})`);
  return { ok: problems.length === 0, problems };
}
