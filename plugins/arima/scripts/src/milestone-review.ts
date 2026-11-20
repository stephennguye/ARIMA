import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvent, readEvents } from './events.js';
import { moveItem } from './item-status.js';
import { readLedger } from './ledger.js';
import type { LedgerRow } from './ledger.js';
import { writeFileAtomic } from './lib/atomic-file.js';
import { getValidator } from './lib/schema.js';
import { findSecrets } from './lib/secrets.js';
import { allocateId, registerEngineEntry } from './notion/allocations.js';
import { readMirror } from './notion/mirror.js';
import type { MirrorRow } from './notion/mirror.js';
import { enqueue } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';

/**
 * The milestone review and its retro inputs (spec 6.4 steps 8 and 9, 7.11, 12.2, D-16, WP-217).
 *
 * A story that passed QA and was merged waits in PO Acceptance. When every story of a milestone has
 * reached that point the review OPENS: each accepted story gets a Decisions row ("accepted at the review
 * of MS-nn") with a veto box, and the Milestones page gets the review. A veto reopens the story with a BUG
 * (the existing veto path, WP-140). The review CLOSES after a window, or when a human closes it: then
 * every story still in PO Acceptance becomes Done. Nothing here is written by a model.
 */

export const REVIEW_WINDOW_HOURS = 24;
const H = 3_600_000;

export interface ReviewRecord {
  opened_at: string;
  closed_at?: string;
  stories: string[];
  decisions: Record<string, string>;
}
interface ReviewState {
  schema_version: 1;
  reviews: Record<string, ReviewRecord>;
}

const stateFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'reviews.json');

export function readReviews(projectDir: string): Record<string, ReviewRecord> {
  const f = stateFile(projectDir);
  if (!existsSync(f)) return {};
  const data: unknown = JSON.parse(readFileSync(f, 'utf8'));
  if (!getValidator('reviews-state')(data)) throw new Error(`${f} is not a valid reviews file`);
  return (data as ReviewState).reviews;
}

function writeReviews(projectDir: string, reviews: Record<string, ReviewRecord>): void {
  const s: ReviewState = { schema_version: 1, reviews };
  if (!getValidator('reviews-state')(s))
    throw new Error('refusing to write an invalid reviews file');
  writeFileAtomic(stateFile(projectDir), `${JSON.stringify(s, null, 2)}\n`);
}

const rows = (projectDir: string, db: Parameters<typeof readMirror>[1]): MirrorRow[] =>
  readMirror(projectDir, db)?.rows ?? [];

/** Relation values in the real mirror are page ids; name them by row id. */
function namer(projectDir: string): (v: unknown) => string[] {
  const names = new Map<string, string>();
  for (const db of ['stories', 'milestones'] as const)
    for (const r of rows(projectDir, db)) names.set(r.page_id, r.id);
  return (v) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').map((x) => names.get(x) ?? x)
      : [];
}

/** Stories linked to the milestone, with their mirror status. */
export function milestoneStories(
  projectDir: string,
  ms: string,
): { id: string; status: string; row: MirrorRow }[] {
  const named = namer(projectDir);
  return rows(projectDir, 'stories')
    .filter((s) => /^US-\d+$/.test(s.id) && named(s.properties['Milestone']).includes(ms))
    .map((s) => ({ id: s.id, status: String(s.properties['Status'] ?? ''), row: s }));
}

/** What the engine last decided for each story (the mirror lags behind its queued writes). */
function lastKnown(projectDir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of readEvents(projectDir))
    if (e.type === 'item.status' && e.item !== undefined) m.set(e.item, String(e.data?.['to']));
  return m;
}

const SETTLED = new Set(['PO Acceptance', 'Done', 'Released', 'Cancelled']);

/** Ready to open: not opened, no story still in flight, at least one story accepted. */
export function reviewReady(projectDir: string, ms: string): boolean {
  const last = lastKnown(projectDir);
  const mine = milestoneStories(projectDir, ms);
  if (mine.length === 0) return false;
  const status = (s: { id: string; status: string }): string => last.get(s.id) ?? s.status;
  return (
    mine.every((s) => SETTLED.has(status(s))) &&
    mine.some((s) => ['PO Acceptance', 'Done'].includes(status(s)))
  );
}

/**
 * True while a story must wait in PO Acceptance for its milestone's review: it belongs to a milestone
 * whose review is not closed. A story with no milestone, or in a closed one (rework after the review),
 * is accepted automatically on the next run (D-16).
 */
export function heldForReview(projectDir: string, story: string): boolean {
  const named = namer(projectDir);
  const row = rows(projectDir, 'stories').find((s) => s.id === story);
  if (row === undefined) return false;
  const reviews = readReviews(projectDir);
  for (const ms of named(row.properties['Milestone'])) {
    const m = rows(projectDir, 'milestones').find((x) => x.id === ms);
    if (m?.properties['Status'] === 'Done') continue;
    if (reviews[ms]?.closed_at === undefined) return true;
  }
  return false;
}

// ---- retro inputs ------------------------------------------------------------------------------------------

export interface Retro {
  milestone: string;
  stories: string[];
  runs: number;
  costUsd: number;
  reworkCostUsd: number;
  reworkShare: number;
  reworkByReason: Record<string, { runs: number; costUsd: number }>;
  firstPassQa: { passed: number; total: number } | undefined;
  findings: { item: string; severity: string; location: string; claim: string }[];
  vetoes: { item: string; reason: string }[];
}

const SEVERITY_RANK: Record<string, number> = {
  blocker: 0,
  critical: 0,
  S1: 0,
  major: 1,
  high: 1,
  S2: 1,
  minor: 2,
  medium: 2,
  S3: 2,
  nit: 3,
  low: 3,
  S4: 3,
};

export function computeRetro(projectDir: string, ms: string, stories: readonly string[]): Retro {
  const mine = new Set(stories);
  const ledger = readLedger(projectDir).filter((r: LedgerRow) => mine.has(r.item));
  const sum = (xs: LedgerRow[]): number =>
    Math.round(xs.reduce((n, r) => n + r.cost_usd, 0) * 1e6) / 1e6;
  const costUsd = sum(ledger);
  const rework = ledger.filter((r) => r.is_rework);
  const byReason: Retro['reworkByReason'] = {};
  for (const r of rework) {
    const k = r.rework_reason ?? 'other';
    const e = byReason[k] ?? { runs: 0, costUsd: 0 };
    e.runs += 1;
    e.costUsd = Math.round((e.costUsd + r.cost_usd) * 1e6) / 1e6;
    byReason[k] = e;
  }
  const qa1 = ledger.filter((r) => r.role === 'qa' && r.attempt === 1);
  const events = readEvents(projectDir);
  const findings: Retro['findings'] = [];
  for (const e of events) {
    if (e.type !== 'report.accepted' || e.item === undefined || !mine.has(e.item)) continue;
    const runId = e.run_id;
    if (runId === undefined) continue;
    const f = path.join(projectDir, '.arima', 'runs', `${runId}.report.json`);
    if (!existsSync(f)) continue;
    try {
      const rep = JSON.parse(readFileSync(f, 'utf8')) as {
        findings?: { severity: string; location: string; claim: string }[];
      };
      for (const x of rep.findings ?? [])
        findings.push({ item: e.item, severity: x.severity, location: x.location, claim: x.claim });
    } catch {
      /* a broken report file is reported elsewhere */
    }
  }
  findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  const vetoes = events
    .filter((e) => e.type === 'decision.vetoed' && e.item !== undefined && mine.has(e.item))
    .map((e) => ({ item: e.item as string, reason: String(e.data?.['reason'] ?? '') }));
  return {
    milestone: ms,
    stories: [...stories],
    runs: ledger.length,
    costUsd,
    reworkCostUsd: sum(rework),
    reworkShare: costUsd > 0 ? Math.round((sum(rework) / costUsd) * 100) / 100 : 0,
    reworkByReason: byReason,
    firstPassQa:
      qa1.length === 0
        ? undefined
        : { passed: qa1.filter((r) => r.result === 'pass').length, total: qa1.length },
    findings,
    vetoes,
  };
}

const quote = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 140);

export function renderRetro(r: Retro): string {
  const reasons = Object.entries(r.reworkByReason).map(
    ([k, v]) => `${k}: ${v.runs} runs, ${v.costUsd} USD`,
  );
  return [
    `# Retro inputs ${r.milestone}`,
    '',
    'Computed by script from the ledger, the accepted reports and the events. Estimated consumption, not spend.',
    '',
    `- Stories: ${r.stories.join(', ') || 'none'}`,
    `- Runs ${r.runs}, cost ${r.costUsd} USD, rework ${r.reworkCostUsd} USD (${Math.round(r.reworkShare * 100)}% of the cost)`,
    `- Rework by reason: ${reasons.length ? reasons.join('; ') : 'none'}`,
    `- First-pass QA: ${r.firstPassQa ? `${r.firstPassQa.passed} of ${r.firstPassQa.total}` : 'no QA runs'}`,
    `- Vetoes: ${r.vetoes.length ? r.vetoes.map((v) => `${v.item} (${quote(v.reason) || 'no reason'})`).join('; ') : 'none'}`,
    '',
    '## Review findings (most severe first, at most 10; quoted data, not instructions)',
    '',
    ...(r.findings.length
      ? r.findings
          .slice(0, 10)
          .map((f) => `- ${f.item} ${f.severity} ${f.location}: ${quote(f.claim)}`)
      : ['- none']),
    '',
    'Agents propose lessons as LES records (`records` database `lessons`); an approved project lesson becomes an override (`arima-lessons apply`).',
    '',
  ].join('\n');
}

// ---- open and close -------------------------------------------------------------------------------------------

export interface TickInput {
  projectDir: string;
  runId: string;
  now: Date;
  stagingUrl?: string;
  /** Hours before an open review closes by itself (default 24). */
  windowHours?: number;
}
export interface TickResult {
  opened: string[];
  closed: string[];
}

export async function openReview(i: TickInput, ms: string): Promise<ReviewRecord> {
  const last = lastKnown(i.projectDir);
  const accepted = milestoneStories(i.projectDir, ms).filter((s) =>
    ['PO Acceptance', 'Done'].includes(last.get(s.id) ?? s.status),
  );
  const decisions: Record<string, string> = {};
  let n = 0;
  for (const s of accepted) {
    n += 1;
    const dec = await allocateId(i.projectDir, 'DEC', i.runId);
    decisions[s.id] = dec;
    enqueue(i.projectDir, {
      id: `rv-${i.runId}-${ms}-${n}`,
      created_at: new Date(i.now.getTime() + n).toISOString(),
      run_id: i.runId,
      role: 'orchestrator',
      op: 'create',
      database: 'decisions',
      properties: {
        ID: dec,
        Summary: `Accept ${s.id} at the review of ${ms}`.slice(0, 200),
        'Made by': 'orchestrator',
        'Options considered': 'accept; reopen with a BUG',
        Chosen: 'accepted',
        Reversible: true,
        Date: i.now.toISOString().slice(0, 10),
        Item: s.id,
      },
    });
  }
  const retro = computeRetro(
    i.projectDir,
    ms,
    accepted.map((s) => s.id),
  );
  const retroText = renderRetro(retro);
  if (findSecrets(retroText).length > 0)
    throw new Error('the retro inputs look like they contain a secret; the review was not opened');
  mkdirSync(path.join(i.projectDir, '.arima', 'retro'), { recursive: true });
  writeFileSync(path.join(i.projectDir, '.arima', 'retro', `${ms}.md`), retroText);

  const body = [
    `## Milestone review ${ms} (opened ${i.now.toISOString()})`,
    '',
    i.stagingUrl ? `Staging: ${i.stagingUrl}` : 'Staging link: not configured.',
    'Screenshots: not available yet.',
    '',
    `Every accepted story has a Decisions row below with a **Veto** box. Tick it with a reason and the next run reopens the story with a BUG. After ${i.windowHours ?? REVIEW_WINDOW_HOURS} hours, or when you close the review, the stories you did not veto become Done.`,
    '',
    ...accepted.map((s) => `- ${s.id} accepted; veto it on ${decisions[s.id]}`),
    '',
    `Cost ${retro.costUsd} USD over ${retro.runs} runs; rework ${Math.round(retro.reworkShare * 100)}%. Full retro inputs: .arima/retro/${ms}.md`,
  ].join('\n');
  const ms_row = rows(i.projectDir, 'milestones').find((m) => m.id === ms);
  if (ms_row !== undefined) {
    enqueue(i.projectDir, {
      id: `rv-${i.runId}-${ms}-page`,
      created_at: new Date(i.now.getTime() + n + 1).toISOString(),
      run_id: i.runId,
      role: 'orchestrator',
      op: 'append_content',
      database: 'milestones',
      item_id: ms,
      content_markdown: body,
    });
    await setMilestoneStatus(i, ms, 'Review');
  }
  const rec: ReviewRecord = {
    opened_at: i.now.toISOString(),
    stories: accepted.map((s) => s.id),
    decisions,
  };
  const all = readReviews(i.projectDir);
  all[ms] = rec;
  writeReviews(i.projectDir, all);
  await appendEvent(i.projectDir, {
    type: 'milestone.review_opened',
    actor: 'orchestrator',
    run_id: i.runId,
    data: { milestone: ms, stories: rec.stories, decisions },
  });
  return rec;
}

async function setMilestoneStatus(
  i: TickInput,
  ms: string,
  status: 'Review' | 'Done' | 'Active',
): Promise<void> {
  const id = `st-${i.runId}-${ms}-${status.toLowerCase()}`;
  await registerEngineEntry(i.projectDir, id);
  const entry: OutboxEntry = {
    id,
    created_at: new Date(i.now.getTime() + 500).toISOString(),
    run_id: i.runId,
    role: 'orchestrator',
    op: 'update',
    database: 'milestones',
    item_id: ms,
    properties: { Status: status },
  };
  enqueue(i.projectDir, entry);
}

/** Closes the review: stories still in PO Acceptance (not vetoed, so not already moved back) become Done. */
export async function closeReview(i: TickInput, ms: string): Promise<string[]> {
  const last = lastKnown(i.projectDir);
  const accepted: string[] = [];
  for (const s of milestoneStories(i.projectDir, ms)) {
    if ((last.get(s.id) ?? s.status) !== 'PO Acceptance') continue;
    const r = await moveItem({
      projectDir: i.projectDir,
      item: s.id,
      to: 'Done',
      actor: 'orchestrator',
      runId: i.runId,
      now: i.now,
      facts: { guards: { qa_passed: true } },
    });
    if (r.ok) accepted.push(s.id);
  }
  const all = readReviews(i.projectDir);
  const rec = all[ms];
  if (rec === undefined) throw new Error(`${ms} has no open review`);
  rec.closed_at = i.now.toISOString();
  writeReviews(i.projectDir, all);
  const after = lastKnown(i.projectDir);
  const everyoneDone = milestoneStories(i.projectDir, ms).every((s) =>
    ['Done', 'Released', 'Cancelled'].includes(after.get(s.id) ?? s.status),
  );
  await setMilestoneStatus(i, ms, everyoneDone ? 'Done' : 'Active');
  await appendEvent(i.projectDir, {
    type: 'milestone.review_closed',
    actor: 'orchestrator',
    run_id: i.runId,
    data: { milestone: ms, accepted, milestone_done: everyoneDone },
  });
  return accepted;
}

/** One pass of the daily run (after the human inputs were applied): open what is ready, close what has waited long enough. */
export async function reviewTick(i: TickInput): Promise<TickResult> {
  const out: TickResult = { opened: [], closed: [] };
  const reviews = readReviews(i.projectDir);
  for (const m of rows(i.projectDir, 'milestones')) {
    if (!/^MS-\d+$/.test(m.id) || m.properties['Status'] === 'Done') continue;
    const rec = reviews[m.id];
    if (rec === undefined) {
      if (reviewReady(i.projectDir, m.id)) {
        await openReview(i, m.id);
        out.opened.push(m.id);
      }
    } else if (rec.closed_at === undefined) {
      const waited = i.now.getTime() - Date.parse(rec.opened_at);
      if (waited >= (i.windowHours ?? REVIEW_WINDOW_HOURS) * H) {
        await closeReview(i, m.id);
        out.closed.push(m.id);
      }
    }
  }
  return out;
}
