import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildStatus } from './status.js';
import type { StatusReport } from './status.js';
import { validateProject } from './config.js';
import { readEvents } from './events.js';
import type { ArimaEvent } from './events.js';
import { readLedger } from './ledger.js';
import type { LedgerRow } from './ledger.js';
import { findSecrets } from './lib/secrets.js';
import { rollup, usd } from './cost.js';
import { delivery } from './metrics.js';
import { findRow, readMirror } from './notion/mirror.js';
import type { MirrorRow } from './notion/mirror.js';
import { enqueue } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';
import { PHASE_AFTER_GATE } from './gates.js';
import { decisionsToVeto, digestQuestions, readQuestions } from './questions.js';
import { SIZE_POINTS } from './item.js';
import { planDay } from './queue.js';
import { storiesFromMirror } from './queue.js';
import { stagingFailing } from './env.js';
import { renderTemplate } from './templates.js';
import { appendEvent } from './events.js';
import { verdictAfterLastPush } from './merge.js';

/**
 * The daily digest (spec 12.1, F05 section 5.1, WP-130): one page of the day, eight sections in the
 * order of `templates/digest.md`, every list capped at ten, every number computed here and never by
 * a model. Built on demand (`/arima:digest`) and at the end of each attended run until Gate U.
 */

export const DIGEST_LIST_CAP = 10;
const H = 3_600_000;

export type Health = 'green' | 'amber' | 'red';

export interface HealthInput {
  /** Hours the longest-waiting hard stop (gate, production approval, hard-stop question) has waited. */
  hardStopWaitHours: number | undefined;
  openP1P2: boolean;
  dayPct: number;
  projectPct: number;
  /** Hours the oldest blocked story has been blocked. */
  oldestBlockerHours: number | undefined;
}

/**
 * Spec 12.1, first match wins. Red: a hard stop waiting more than 48 hours, an open P1 or P2
 * incident, or a budget at or over 100%. Amber: a budget at or over 80%, or a blocker older than 24
 * hours. Green otherwise. "More than" and "older than" are strict: exactly 48 h or 24 h is not over.
 */
export function health(i: HealthInput): { health: Health; reasons: string[] } {
  const red: string[] = [];
  if ((i.hardStopWaitHours ?? 0) > 48)
    red.push(`a hard stop has waited ${Math.floor(i.hardStopWaitHours as number)} hours (over 48)`);
  if (i.openP1P2) red.push('an open P1 or P2 incident');
  if (i.dayPct >= 1) red.push('the daily budget is used up');
  if (i.projectPct >= 1) red.push('the project budget is used up');
  if (red.length > 0) return { health: 'red', reasons: red };
  const amber: string[] = [];
  if (i.dayPct >= 0.8) amber.push(`the daily budget is at ${Math.round(i.dayPct * 100)}%`);
  if (i.projectPct >= 0.8)
    amber.push(`the project budget is at ${Math.round(i.projectPct * 100)}%`);
  if ((i.oldestBlockerHours ?? 0) > 24)
    amber.push(
      `a story has been blocked for ${Math.floor(i.oldestBlockerHours as number)} hours (over 24)`,
    );
  if (amber.length > 0) return { health: 'amber', reasons: amber };
  return { health: 'green', reasons: [] };
}

export interface Item {
  /** One line, links and ids only; free text from Notion is quoted and short. */
  line: string;
  /** Larger sorts first inside a list. */
  weight: number;
}

/** At most `cap` lines, heaviest first (stable), then "and N more". */
export function capList(items: readonly Item[], cap: number = DIGEST_LIST_CAP): string[] {
  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.weight - a.it.weight || a.i - b.i)
    .map((x) => x.it);
  const shown = sorted.slice(0, cap).map((x) => `- ${x.line}`);
  if (sorted.length > cap)
    shown.push(`- and ${sorted.length - cap} more (see the full view in Notion)`);
  return shown;
}

export interface DigestModel {
  date: string;
  builtAt: string;
  health: Health;
  healthReasons: string[];
  headline: string;
  sections: Record<(typeof DIGEST_SECTIONS)[number], string[]>;
  /** Plain numbers for the Notion row. */
  numbers: { spendToday: number; monthToDate: number };
  warnings: string[];
}

export const DIGEST_SECTIONS = [
  'Headline',
  'Awaiting you',
  'Shipped',
  'Decisions made',
  'Blockers and risks',
  'Cost and time',
  "Tomorrow's plan",
  'Run health',
] as const;

const quote = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 120);
const hours = (ms: number): number => Math.max(0, Math.floor(ms / H));
const waited = (since: string | undefined, now: Date): string =>
  since === undefined
    ? 'wait not recorded'
    : `waiting ${hours(now.getTime() - Date.parse(since))} h`;
const hoursSince = (since: string | undefined, now: Date): number | undefined =>
  since === undefined || Number.isNaN(Date.parse(since))
    ? undefined
    : (now.getTime() - Date.parse(since)) / H;

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface BuildOptions {
  /** `YYYY-MM-DD`, default today (local). */
  date?: string;
}

export function buildDigest(
  projectDir: string,
  now: Date = new Date(),
  o: BuildOptions = {},
): DigestModel {
  const date = o.date ?? localDate(now);
  const status: StatusReport = buildStatus(projectDir, now);
  const cfg = validateProject(projectDir).arima as unknown as {
    budget: { per_story_default: number; per_run_cap: number; by_size?: Record<string, number> };
    parallelism?: { max_developer_agents?: number };
    review?: { max_prs_awaiting_human?: number };
  };
  const events = readEvents(projectDir);
  const ledger = readLedger(projectDir);
  const warnings: string[] = [...status.warnings];
  const todayRows = ledger.filter((r) => r.date === date);
  const mirrorOf = (db: Parameters<typeof readMirror>[1]): MirrorRow[] =>
    readMirror(projectDir, db)?.rows ?? [];

  // The window since the last digest (F05 5.1 step 1): its `digest.published` event, else 24 hours.
  const lastDigest = [...events]
    .reverse()
    .find((e) => e.type === 'digest.published' && e.data?.['date'] !== date);
  const since = lastDigest ? lastDigest.ts : new Date(now.getTime() - 24 * H).toISOString();
  const sinceDate = since.slice(0, 10);

  // ---- Awaiting you -------------------------------------------------------------------------------------
  const awaiting: Item[] = [];
  let hardStopWait: number | undefined;
  const noteHardStop = (h: number | undefined): void => {
    if (h !== undefined && (hardStopWait === undefined || h > hardStopWait)) hardStopWait = h;
  };
  for (const g of mirrorOf('gates').filter((r) => r.properties['Status'] === 'Ready for review')) {
    const h = hoursSince(g.last_edited_time, now);
    noteHardStop(h);
    awaiting.push({
      weight: 4_000_000 + (h ?? 0),
      line: `Gate ${g.id} is ready for your decision (${waited(g.last_edited_time, now)})`,
    });
  }
  for (const r of mirrorOf('releases').filter(
    (x) => x.properties['Status'] === 'Awaiting approval',
  )) {
    const h = hoursSince(r.last_edited_time, now);
    noteHardStop(h);
    awaiting.push({
      weight: 3_000_000 + (h ?? 0),
      line: `Production approval for ${r.id} (${waited(r.last_edited_time, now)})`,
    });
  }
  const dq = digestQuestions(projectDir, { max: 1000, now });
  const qState = readQuestions(projectDir);
  for (const q of dq.shown) {
    const created = qState[q.id]?.created_at;
    const h = hoursSince(created, now);
    if (q.hardStop !== undefined) noteHardStop(h);
    awaiting.push({
      weight: (q.blocking ? 2_000_000 : 1_500_000) + (h ?? 0),
      line: `${q.blocking ? 'Blocking q' : 'Q'}uestion ${q.id}${q.item !== 'none' ? ` (${q.item})` : ''}: ${quote(q.question)}${q.hardStop ? ` [hard stop: ${q.hardStop}]` : ''} (${waited(created, now)})`,
    });
  }
  for (const s of mirrorOf('stories').filter((r) => r.properties['Status'] === 'In QA')) {
    const pr = [...events].reverse().find((e) => e.type === 'pr.published' && e.item === s.id)
      ?.data?.['pr'];
    const qa = verdictAfterLastPush(projectDir, s.id, 'qa', 'qa');
    const qaAt = [...events]
      .reverse()
      .find(
        (e) => e.type === 'report.accepted' && e.item === s.id && e.data?.['role'] === 'qa',
      )?.ts;
    awaiting.push({
      weight: 1_000_000 + (hoursSince(qaAt, now) ?? 0),
      line: `PR${typeof pr === 'number' ? ` #${pr}` : ''} for ${s.id} awaits your approval: QA ${qa ?? 'not yet reported'}; preview link not available yet (${waited(qaAt, now)})`,
    });
  }
  for (const c of mirrorOf('change_requests').filter((x) => x.properties['Decision'] === 'Pending'))
    awaiting.push({
      weight: 500_000,
      line: `Change request ${c.id} awaits a decision (${waited(c.last_edited_time, now)})`,
    });

  // ---- Shipped ----------------------------------------------------------------------------------------------
  const shipped: Item[] = [];
  const reached = new Map<string, ArimaEvent>();
  for (const e of events)
    if (
      e.type === 'item.status' &&
      e.ts >= since &&
      ['PO Acceptance', 'Released'].includes(String(e.data?.['to'])) &&
      e.item
    )
      reached.set(e.item, e);
  for (const [id, e] of reached) {
    const pr = [...events].reverse().find((x) => x.type === 'pr.published' && x.item === id)
      ?.data?.['pr'];
    shipped.push({
      weight: Date.parse(e.ts),
      line: `${id} reached ${String(e.data?.['to'])}${typeof pr === 'number' ? ` (PR #${pr})` : ''}`,
    });
  }

  // ---- Decisions made -----------------------------------------------------------------------------------
  const decisions: Item[] = decisionsToVeto(projectDir, { sinceDate }).map((d, i) => ({
    weight: Date.parse(d.date || since) || i,
    line: `[ ] veto ${d.id}${d.item ? ` (${d.item})` : ''}: ${quote(d.summary)} -> ${quote(d.chosen)}`,
  }));

  // ---- Blockers and risks -------------------------------------------------------------------------------
  const blockers: Item[] = [];
  let oldestBlocker: number | undefined;
  for (const s of mirrorOf('stories').filter((r) => r.properties['Status'] === 'Blocked')) {
    const at =
      [...events]
        .reverse()
        .find((e) => e.type === 'item.status' && e.item === s.id && e.data?.['to'] === 'Blocked')
        ?.ts ?? s.last_edited_time;
    const h = hoursSince(at, now);
    if (h !== undefined && (oldestBlocker === undefined || h > oldestBlocker)) oldestBlocker = h;
    blockers.push({
      weight: h ?? 0,
      line: `${s.id} blocked: ${quote(String(s.properties['Blocked reason'] ?? 'no reason recorded'))} (${waited(at, now)})`,
    });
  }
  const risks: Item[] = mirrorOf('risks')
    .filter((r) => r.properties['Status'] === 'Open' || r.properties['Status'] === 'Mitigating')
    .map((r) => ({
      weight: Date.parse(r.last_edited_time) || 0,
      line: `Risk ${r.id}: ${quote(String(r.properties['Title'] ?? ''))} (${String(r.properties['Status'])})`,
    }));
  const incidents = mirrorOf('incidents').filter(
    (r) =>
      ['P1', 'P2'].includes(String(r.properties['Priority'])) &&
      ['Open', 'Mitigated'].includes(String(r.properties['Status'])),
  );
  for (const inc of incidents)
    blockers.push({
      weight: 9_000_000,
      line: `Incident ${inc.id} (${String(inc.properties['Priority'])}) is ${String(inc.properties['Status'])}`,
    });
  if (stagingFailing(projectDir))
    blockers.push({
      weight: 8_000_000,
      line: 'The last staging rebuild failed; a devops diagnosis is planned',
    });

  // ---- Health -----------------------------------------------------------------------------------------------
  const b = status.budget;
  const h = health({
    hardStopWaitHours: hardStopWait,
    openP1P2: incidents.length > 0,
    dayPct: b.dailyCap > 0 ? b.daySpent / b.dailyCap : 0,
    projectPct: b.projectCap > 0 ? b.projectSpent / b.projectCap : 0,
    oldestBlockerHours: oldestBlocker,
  });

  // ---- Cost and time ----------------------------------------------------------------------------------------
  const month = date.slice(0, 7);
  const monthSpent =
    Math.round(
      ledger.filter((r) => r.date.startsWith(month)).reduce((n, r) => n + r.cost_usd, 0) * 1e6,
    ) / 1e6;
  const daySpent = Math.round(todayRows.reduce((n, r) => n + r.cost_usd, 0) * 1e6) / 1e6;
  const r = rollup(ledger);
  const top = [...r.byItem.entries()].sort((a, c) => c[1].cost_micro - a[1].cost_micro).slice(0, 3);
  const rework =
    r.total.cost_micro > 0 ? Math.round((r.total.rework_micro / r.total.cost_micro) * 100) : 0;
  const del = delivery({ events, rows: ledger, now, projectCap: b.projectCap });
  const waitMs = del.items.reduce((n, i) => n + i.humanWaitMs, 0) + del.gateWaitMs;
  const waitH = del.items.length === 0 ? 'not available yet' : `${Math.round(waitMs / H)} h`;
  const cost = [
    `Today ${usd(Math.round(daySpent * 1e6))} of the ${b.dailyCap} USD daily budget (${b.dailyCap > 0 ? Math.round((daySpent / b.dailyCap) * 100) : 0}%).`,
    `Month to date ${monthSpent} USD; lifetime ${b.projectSpent} USD of the ${b.projectCap} USD project cap (${b.projectCap > 0 ? Math.round((b.projectSpent / b.projectCap) * 100) : 0}%).`,
    top.length === 0
      ? 'Most expensive items: no runs yet.'
      : `Most expensive items: ${top.map(([id, t]) => `${id} ${usd(t.cost_micro)} USD`).join(', ')}.`,
    `Rework share ${rework}% of the cost.`,
    `Time spent waiting on humans: ${waitH}.`,
    'All amounts are estimated consumption on the seat, not money spent.',
  ];

  // ---- Tomorrow's plan ----------------------------------------------------------------------------------------
  const facts = storiesFromMirror(projectDir, {
    perStoryDefault: cfg.budget.per_story_default,
    ...(cfg.budget.by_size ? { bySize: cfg.budget.by_size as Record<string, number> } : {}),
    perRunCap: cfg.budget.per_run_cap,
  });
  const plan = planDay(
    { stories: facts, stagingSmokeFailing: stagingFailing(projectDir) !== undefined },
    {
      maxDevelopers: Math.max(1, cfg.parallelism?.max_developer_agents ?? 1),
      maxPrsAwaitingHuman: cfg.review?.max_prs_awaiting_human ?? 5,
      prsAwaitingHuman: awaiting.filter((a) => a.line.startsWith('PR')).length,
      reviewers: 1,
    },
  );
  const tomorrow: Item[] = plan.units.map((u, i) => ({
    weight: 1000 - i,
    line: `${u.kind} for ${u.item} (${u.role}): ${u.why}`,
  }));
  warnings.push(
    "Tomorrow's plan does not know the state of the pull requests on GitHub; the run reads it.",
  );

  // ---- Run health -------------------------------------------------------------------------------------------------
  const retried = events.filter(
    (e) => e.type === 'unit.retried' && e.ts.slice(0, 10) === date,
  ).length;
  const runHealth = [
    `Runs started ${todayRows.length}, succeeded ${todayRows.filter((x) => x.result === 'pass').length}, failed ${todayRows.filter((x) => x.result === 'fail').length}, blocked ${todayRows.filter((x) => x.result === 'blocked').length}, retried ${retried}.`,
  ];

  // ---- Headline -----------------------------------------------------------------------------------------------------
  const ms = milestoneProgress(projectDir);
  const headline = `${status.phase}; ${ms}; health ${h.health}${h.reasons.length ? ` (${h.reasons.join('; ')})` : ''}.`;
  void PHASE_AFTER_GATE;

  return {
    date,
    builtAt: now.toISOString(),
    health: h.health,
    healthReasons: h.reasons,
    headline,
    numbers: { spendToday: daySpent, monthToDate: monthSpent },
    warnings,
    sections: {
      Headline: [headline],
      'Awaiting you': awaiting.length ? capList(awaiting) : ['Nothing waits for you.'],
      Shipped: shipped.length
        ? capList(shipped)
        : ['Nothing reached staging since the last digest.'],
      'Decisions made': decisions.length
        ? capList(decisions)
        : ['No autonomous decision since the last digest.'],
      'Blockers and risks':
        blockers.length + risks.length
          ? [
              ...(blockers.length ? ['Blocked:', ...capList(blockers)] : []),
              ...(risks.length ? ['Risks:', ...capList(risks)] : []),
            ]
          : ['No blocker and no open risk.'],
      'Cost and time': cost,
      "Tomorrow's plan": tomorrow.length ? capList(tomorrow) : ['Nothing is planned yet.'],
      'Run health': runHealth,
    },
  };
}

/** "Milestone MS-01: 6 of 11 points done", or why there is none. */
export function milestoneProgress(projectDir: string): string {
  const ms = (readMirror(projectDir, 'milestones')?.rows ?? []).filter(
    (m) => m.properties['Status'] !== 'Done',
  );
  const active = ms.find((m) => m.properties['Status'] === 'Active') ?? ms[0];
  if (active === undefined) return 'no milestone planned yet';
  const names = new Map<string, string>();
  for (const m of readMirror(projectDir, 'milestones')?.rows ?? []) names.set(m.page_id, m.id);
  let total = 0;
  let done = 0;
  for (const s of readMirror(projectDir, 'stories')?.rows ?? []) {
    const rel = s.properties['Milestone'];
    const mine =
      Array.isArray(rel) && rel.some((x) => x === active.id || names.get(String(x)) === active.id);
    if (!mine) continue;
    const size = s.properties['Complexity'];
    const pts = size === 'S' || size === 'M' || size === 'L' ? SIZE_POINTS[size] : 0;
    total += pts;
    if (['Done', 'Released', 'PO Acceptance'].includes(String(s.properties['Status']))) done += pts;
  }
  return `${active.id}: ${done} of ${total} points done`;
}

/** The page: the template's headings and comments, each section's lines placed under its heading. */
export function renderDigest(m: DigestModel, root?: string): string {
  const tpl = renderTemplate('digest', { date: m.date }, ...(root ? [root] : []));
  const out: string[] = [];
  let section: (typeof DIGEST_SECTIONS)[number] | undefined;
  const flush = (): void => {
    if (section !== undefined) out.push('', ...m.sections[section], '');
    section = undefined;
  };
  for (const line of tpl.split(/\r?\n/)) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2) {
      flush();
      const name = h2[1] as (typeof DIGEST_SECTIONS)[number];
      if (!(DIGEST_SECTIONS as readonly string[]).includes(name))
        throw new Error(`digest template has a section the builder does not know: ${name}`);
      section = name;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  flush();
  out.push(
    `_Built ${m.builtAt}. Estimated consumption, not spend. Reviewed by and Minutes spent are for you to fill in._`,
    '',
  );
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export const digestFile = (projectDir: string, date: string): string =>
  path.join(projectDir, '.arima', 'digests', `${date}.md`);

export class DigestSecretError extends Error {}

/**
 * Writes the local copy and queues the Notion row: a new digest creates the row with the page body,
 * a rebuild of the same date updates the numbers and APPENDS a rebuilt section (nothing is ever
 * deleted in Notion). A page that looks like it holds a secret is neither written nor queued.
 */
export async function publishDigest(o: {
  projectDir: string;
  runId: string;
  model: DigestModel;
  push?: boolean;
  now?: Date;
  root?: string;
}): Promise<{ file: string; queued: boolean; created: boolean }> {
  const text = renderDigest(o.model, o.root);
  const secrets = findSecrets(text);
  if (secrets.length > 0)
    throw new DigestSecretError(
      `the digest looks like it contains a secret (${secrets.join(', ')}); nothing was written`,
    );
  const file = digestFile(o.projectDir, o.model.date);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  let queued = false;
  let created = false;
  if (o.push !== false) {
    const existing = findRow(readMirror(o.projectDir, 'digests'), o.model.date);
    const now = o.now ?? new Date();
    const props = {
      Summary: o.model.headline.slice(0, 1900),
      Shipped: o.model.sections.Shipped.join('\n').slice(0, 1900),
      'Awaiting you': o.model.sections['Awaiting you'].join('\n').slice(0, 1900),
      'Spend today': o.model.numbers.spendToday,
      'Month to date': o.model.numbers.monthToDate,
    };
    const base = { run_id: o.runId, role: 'orchestrator' as const, created_at: now.toISOString() };
    const entries: OutboxEntry[] =
      existing === undefined
        ? [
            {
              ...base,
              id: `dg-${o.runId}-1`,
              op: 'create',
              database: 'digests',
              properties: { Date: o.model.date, ...props },
              content_markdown: text,
            },
          ]
        : [
            {
              ...base,
              id: `dg-${o.runId}-1`,
              op: 'update',
              database: 'digests',
              item_id: o.model.date,
              properties: props,
            },
            {
              ...base,
              id: `dg-${o.runId}-2`,
              created_at: new Date(now.getTime() + 1).toISOString(),
              op: 'append_content',
              database: 'digests',
              item_id: o.model.date,
              content_markdown: `## Rebuilt ${o.model.builtAt}\n\n${o.model.headline}`,
            },
          ];
    for (const e of entries) enqueue(o.projectDir, e);
    queued = true;
    created = existing === undefined;
  }
  await appendEvent(o.projectDir, {
    type: 'digest.published',
    actor: 'orchestrator',
    run_id: o.runId,
    data: {
      date: o.model.date,
      health: o.model.health,
      file: path.relative(o.projectDir, file),
      queued,
    },
  });
  return { file, queued, created };
}

export function readDigest(projectDir: string, date: string): string | undefined {
  const f = digestFile(projectDir, date);
  return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
}

export type { LedgerRow };
