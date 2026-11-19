import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from './events.js';
import { isHardStop } from './hardstops.js';
import { moveItem, mirrorStatus } from './item-status.js';
import { readItem } from './item.js';
import type { Role } from './ledger.js';
import { writeFileAtomic } from './lib/atomic-file.js';
import { withFileLock } from './lib/filelock.js';
import { describeError, getValidator } from './lib/schema.js';
import { allocateId, registerEngineEntry } from './notion/allocations.js';
import { findRow, readMirror } from './notion/mirror.js';
import { enqueue } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';
import type { AgentReport } from './report.js';

/**
 * The question and decision protocol (spec 7.5, 12.1; F04 5.3; 09 section 1; WP-141).
 *
 * Agents work with each other without asking permission; the owner is asked only about a critical
 * blocker. A question an agent raises is therefore either a consult (`addressed_to` a role: that
 * role answers it, the owner never sees it), a blocking question for the owner (the story is
 * Blocked until it is answered), or, under `assume_and_log`, a non-blocking one: the agent goes
 * on with its recommendation and the engine writes a DEC record the owner can veto from the
 * digest. A hard-stop matter is never assumed: it is forced blocking and its default is removed,
 * whatever the agent or the policy says.
 */

export type QuestionPolicy = 'assume_and_log' | 'block_story';
export const MAX_QUESTIONS_PER_DIGEST = 10;

export interface QuestionState {
  raised_by: Role;
  run_id: string;
  item: string;
  topic?: string;
  question: string;
  route: 'owner' | 'consult';
  consult_role?: Role;
  blocking: boolean;
  hard_stop?: string;
  default?: string;
  expires?: string;
  status: 'open' | 'answered' | 'expired';
  created_at: string;
  answer?: string;
  answered_by?: string;
  escalated?: boolean;
  decision?: string;
}

interface Store {
  schema_version: 1;
  questions: Record<string, QuestionState>;
}

export const questionsFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'questions.json');

export function readQuestions(projectDir: string): Record<string, QuestionState> {
  const f = questionsFile(projectDir);
  if (!existsSync(f)) return {};
  const data: unknown = JSON.parse(readFileSync(f, 'utf8'));
  const v = getValidator('questions-state');
  if (!v(data)) throw new Error(`Corrupt ${f}: ${(v.errors ?? []).map(describeError).join('; ')}`);
  return (data as Store).questions;
}

async function updateQuestions(
  projectDir: string,
  change: (q: Record<string, QuestionState>) => void,
): Promise<void> {
  const f = questionsFile(projectDir);
  mkdirSync(path.dirname(f), { recursive: true });
  await withFileLock(`${f}.lock`, () => {
    const questions = readQuestions(projectDir);
    change(questions);
    const store: Store = { schema_version: 1, questions };
    const v = getValidator('questions-state');
    if (!v(store))
      throw new Error(`Invalid question state: ${(v.errors ?? []).map(describeError).join('; ')}`);
    writeFileAtomic(f, `${JSON.stringify(store, null, 2)}\n`);
  });
}

type RawQuestion = {
  addressed_to?: Role;
  hard_stop?: string;
  question: string;
  options: { label: string; recommendation: boolean }[];
  blocking: boolean;
  default?: string;
  expires?: string;
  item?: string;
  topic?: string;
};

export interface RaiseInput {
  projectDir: string;
  runId: string;
  role: Role;
  /** The item of the unit; a question may name another. */
  item: string;
  questions: readonly RawQuestion[] | NonNullable<AgentReport['questions']>;
  policy: QuestionPolicy;
  /** Set by an engine detector (budget, missing credential, licence, paid service, critical finding, gate or release approval): every question of this call is then a hard-stop matter. */
  engineHardStop?: string;
  /** `NEW-n` placeholders of the same report, as issued by `enqueueReportRecords`; a question may mention them. */
  placeholders?: Record<string, string>;
  now?: Date;
}

export interface Raised {
  id: string;
  route: 'owner' | 'consult';
  blocking: boolean;
  hardStop?: string;
  /** The DEC written for an assumed (non-blocking) question. */
  decision?: string;
  /** True when the story was moved to Blocked by this question. */
  blockedItem: boolean;
}

const recommended = (q: RawQuestion): string =>
  q.options.find((o) => o.recommendation)?.label ?? q.options[0]?.label ?? '';
const isStory = (id: string): boolean => /^US-\d+$/.test(id);

function questionRow(
  id: string,
  role: Role,
  q: RawQuestion,
  blocking: boolean,
  hardStop: string | undefined,
  def: string | undefined,
  item: string,
): Record<string, unknown> {
  const prefix = `${hardStop ? `[hard stop: ${hardStop}] ` : ''}`;
  return {
    ID: id,
    'Asked by': role,
    Question: `${prefix}${q.question}`,
    Options: q.options.map((o) => o.label).join('; '),
    Recommendation: recommended(q),
    Blocking: blocking,
    ...(def !== undefined ? { Default: def } : {}),
    ...(q.expires ? { Expires: q.expires } : {}),
    ...(item !== 'none' ? { Item: item } : {}),
    Status: 'Open',
  };
}

async function engineEntry(
  projectDir: string,
  runId: string,
  e: Omit<OutboxEntry, 'id' | 'role' | 'run_id'> & { tag: string },
): Promise<string> {
  const { tag, ...rest } = e;
  const id = `st-${runId}-${tag}`;
  await registerEngineEntry(projectDir, id);
  enqueue(projectDir, { ...rest, id, run_id: runId, role: 'orchestrator' });
  return id;
}

/**
 * Raises the questions of a validated report. Consults are recorded and routed to the addressed
 * role. Owner questions get a `Q` id and a Questions row; blocking ones also move the story to
 * Blocked (through the state machine); non-blocking ones under `assume_and_log` get a DEC row with
 * a veto box. Emits `question.raised` and `decision.made`.
 */
export async function raiseQuestions(i: RaiseInput): Promise<Raised[]> {
  const now = i.now ?? new Date();
  const out: Raised[] = [];
  let n = 0;
  const fill = (t: string): string => t.replace(/\bNEW-\d+\b/g, (m) => i.placeholders?.[m] ?? m);
  for (const raw of i.questions as readonly RawQuestion[]) {
    n += 1;
    const q: RawQuestion = {
      ...raw,
      question: fill(raw.question),
      ...(raw.item ? { item: fill(raw.item) } : {}),
    };
    const item = q.item ?? i.item;
    const id = await allocateId(i.projectDir, 'Q', i.runId);
    const hardStop = q.hard_stop ?? i.engineHardStop;
    if (hardStop !== undefined && !isHardStop(hardStop))
      throw new Error(`"${hardStop}" is not a hard-stop id`);

    if (q.addressed_to !== undefined) {
      // A consult between agents: answered by that role, never shown to the owner.
      await updateQuestions(i.projectDir, (s) => {
        s[id] = {
          raised_by: i.role,
          run_id: i.runId,
          item,
          ...(q.topic ? { topic: q.topic } : {}),
          question: q.question,
          route: 'consult',
          consult_role: q.addressed_to as Role,
          blocking: false,
          status: 'open',
          created_at: now.toISOString(),
          ...(hardStop ? { hard_stop: hardStop } : {}),
        };
      });
      await appendEvent(i.projectDir, {
        type: 'question.raised',
        actor: i.role,
        run_id: i.runId,
        ...(item !== 'none' ? { item } : {}),
        data: { question: id, route: 'consult', to: q.addressed_to },
      });
      out.push({
        id,
        route: 'consult',
        blocking: false,
        ...(hardStop ? { hardStop } : {}),
        blockedItem: false,
      });
      continue;
    }

    // The owner. Hard-stop matters are forced blocking and lose their default (never assumed).
    const blocking = hardStop !== undefined || i.policy === 'block_story' || q.blocking;
    const def = hardStop !== undefined ? undefined : (q.default ?? recommended(q));
    await updateQuestions(i.projectDir, (s) => {
      s[id] = {
        raised_by: i.role,
        run_id: i.runId,
        item,
        ...(q.topic ? { topic: q.topic } : {}),
        question: q.question,
        route: 'owner',
        blocking,
        ...(hardStop ? { hard_stop: hardStop } : {}),
        ...(def !== undefined ? { default: def } : {}),
        ...(q.expires ? { expires: q.expires } : {}),
        status: 'open',
        created_at: now.toISOString(),
      };
    });
    await engineEntry(i.projectDir, i.runId, {
      tag: `${id}-1`,
      created_at: new Date(now.getTime() + n).toISOString(),
      op: 'create',
      database: 'questions',
      properties: questionRow(id, i.role, q, blocking, hardStop, def, item),
    });
    await appendEvent(i.projectDir, {
      type: 'question.raised',
      actor: i.role,
      run_id: i.runId,
      ...(item !== 'none' ? { item } : {}),
      data: {
        question: id,
        route: 'owner',
        blocking,
        ...(hardStop ? { hard_stop: hardStop } : {}),
      },
    });

    const r: Raised = {
      id,
      route: 'owner',
      blocking,
      ...(hardStop ? { hardStop } : {}),
      blockedItem: false,
    };
    if (blocking) {
      if (isStory(item)) {
        const moved = await moveItem({
          projectDir: i.projectDir,
          item,
          to: 'Blocked',
          actor: 'engine',
          runId: i.runId,
          now,
          facts: {
            guards: { reason_recorded: true },
            reason: `${id}: ${q.question}`.slice(0, 900),
          },
        });
        r.blockedItem = moved.ok;
      }
    } else {
      const dec = await allocateId(i.projectDir, 'DEC', i.runId);
      await engineEntry(i.projectDir, i.runId, {
        tag: `${id}-dec`,
        created_at: new Date(now.getTime() + n).toISOString(),
        op: 'create',
        database: 'decisions',
        properties: {
          ID: dec,
          Summary: `Assumed "${def}" for ${id}: ${q.question}`.slice(0, 300),
          'Made by': i.role,
          'Options considered': q.options.map((o) => o.label).join('; '),
          Chosen: def ?? '',
          Reversible: true,
          Date: now.toISOString().slice(0, 10),
          ...(item !== 'none' ? { Item: item } : {}),
        },
      });
      await updateQuestions(i.projectDir, (s) => void ((s[id] as QuestionState).decision = dec));
      await appendEvent(i.projectDir, {
        type: 'decision.made',
        actor: i.role,
        run_id: i.runId,
        ...(item !== 'none' ? { item } : {}),
        data: { decision: dec, question: id, chosen: def, assumed: true },
      });
      r.decision = dec;
    }
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Consults

/** Open consults waiting for a role (the dispatcher plans a unit for it, ahead of the owner). */
export function pendingConsults(
  projectDir: string,
  role?: Role,
): { id: string; q: QuestionState }[] {
  return Object.entries(readQuestions(projectDir))
    .filter(
      ([, q]) =>
        q.route === 'consult' &&
        q.status === 'open' &&
        (role === undefined || q.consult_role === role),
    )
    .map(([id, q]) => ({ id, q }));
}

/** The addressed role answers a consult; the asker sees the answer in its next packet. */
export async function answerConsult(
  projectDir: string,
  id: string,
  by: Role,
  answer: string,
): Promise<void> {
  const q = readQuestions(projectDir)[id];
  if (q === undefined || q.route !== 'consult') throw new Error(`${id} is not a consult`);
  if (q.consult_role !== by) throw new Error(`${id} is addressed to ${q.consult_role}, not ${by}`);
  if (q.status !== 'open') throw new Error(`${id} is already ${q.status}`);
  await updateQuestions(projectDir, (s) => {
    const x = s[id] as QuestionState;
    x.status = 'answered';
    x.answer = answer.slice(0, 2000);
    x.answered_by = by;
  });
  await appendEvent(projectDir, {
    type: 'question.answered',
    actor: by,
    ...(q.item !== 'none' ? { item: q.item } : {}),
    data: { question: id, route: 'consult' },
  });
}

// ---------------------------------------------------------------------------------------------
// Answers from the owner (read from the Notion mirror) and unblocking

async function unblockIfClear(
  projectDir: string,
  runId: string,
  q: QuestionState,
  id: string,
  now: Date,
  budgetAvailable: boolean,
): Promise<boolean> {
  if (!q.blocking || !isStory(q.item) || mirrorStatus(projectDir, q.item) !== 'Blocked')
    return false;
  const store = readQuestions(projectDir);
  const stillOpen = Object.entries(store).some(
    ([k, x]) =>
      k !== id && x.item === q.item && x.route === 'owner' && x.blocking && x.status === 'open',
  );
  if (stillOpen) return false;
  const c = readItem(projectDir, q.item);
  if (c.blocked_from === null || c.blocked_from === undefined) return false;
  const moved = await moveItem({
    projectDir,
    item: q.item,
    to: c.blocked_from,
    actor: 'orchestrator',
    runId,
    now,
    facts: { guards: { cause_resolved: true }, budget_available: budgetAvailable },
  });
  return moved.ok;
}

/**
 * Applies the owner's answers: a Questions row whose `Answer` is filled (a human-only field) marks
 * the question answered, sets the row's Status, emits `question.answered`, and moves the story back
 * from Blocked when no other blocking question of it is open. Idempotent.
 */
export async function applyAnswers(o: {
  projectDir: string;
  runId: string;
  now?: Date;
  budgetAvailable?: (item: string) => boolean;
}): Promise<{ answered: string[]; unblocked: string[] }> {
  const now = o.now ?? new Date();
  const mirror = readMirror(o.projectDir, 'questions');
  const res = { answered: [] as string[], unblocked: [] as string[] };
  if (mirror === undefined) return res;
  for (const [id, q] of Object.entries(readQuestions(o.projectDir))) {
    if (q.route !== 'owner' || q.status !== 'open') continue;
    const row = findRow(mirror, id);
    const answer = row?.properties['Answer'];
    if (typeof answer !== 'string' || answer.trim() === '') continue;
    const by = row?.properties['Answered by'];
    await updateQuestions(o.projectDir, (s) => {
      const x = s[id] as QuestionState;
      x.status = 'answered';
      x.answer = answer.slice(0, 2000);
      if (by !== undefined && by !== null)
        x.answered_by = String(Array.isArray(by) ? by.join(', ') : by);
    });
    await appendEvent(o.projectDir, {
      type: 'question.answered',
      actor: 'human',
      run_id: o.runId,
      ...(q.item !== 'none' ? { item: q.item } : {}),
      data: { question: id, route: 'owner' },
    });
    await engineEntry(o.projectDir, o.runId, {
      tag: `${id}-answered`,
      created_at: now.toISOString(),
      op: 'update',
      database: 'questions',
      item_id: id,
      properties: { Status: 'Answered' },
    });
    res.answered.push(id);
    if (
      await unblockIfClear(o.projectDir, o.runId, q, id, now, o.budgetAvailable?.(q.item) ?? true)
    )
      res.unblocked.push(q.item);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Expiry (RD-F04-6)

export interface Expiry {
  /** Blocking, not a hard stop: the default was taken and a DEC with a veto box written. */
  tookDefault: { id: string; decision: string; unblocked: boolean }[];
  /** Hard-stop matters: they stay blocked and are escalated once. */
  escalated: string[];
  /** Non-blocking ones past their date: kept as assumptions, flagged in the digest. */
  flagged: string[];
}

export async function expireQuestions(o: {
  projectDir: string;
  runId: string;
  now?: Date;
  budgetAvailable?: (item: string) => boolean;
}): Promise<Expiry> {
  const now = o.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const res: Expiry = { tookDefault: [], escalated: [], flagged: [] };
  for (const [id, q] of Object.entries(readQuestions(o.projectDir))) {
    if (q.route !== 'owner' || q.status !== 'open' || q.expires === undefined || q.expires >= today)
      continue;
    if (q.hard_stop !== undefined) {
      if (q.escalated === true) continue;
      await updateQuestions(o.projectDir, (s) => void ((s[id] as QuestionState).escalated = true));
      await appendEvent(o.projectDir, {
        type: 'hardstop.hit',
        actor: 'system',
        run_id: o.runId,
        ...(q.item !== 'none' ? { item: q.item } : {}),
        data: {
          stop: q.hard_stop,
          question: id,
          escalated: true,
          message: `${id} is past its date and is a hard-stop matter; it stays blocked until you answer`,
        },
      });
      res.escalated.push(id);
    } else if (q.blocking) {
      const dec = await allocateId(o.projectDir, 'DEC', o.runId);
      await engineEntry(o.projectDir, o.runId, {
        tag: `${id}-exp`,
        created_at: now.toISOString(),
        op: 'create',
        database: 'decisions',
        properties: {
          ID: dec,
          Summary: `${id} expired unanswered; took the default "${q.default ?? ''}"`.slice(0, 300),
          'Made by': q.raised_by,
          'Options considered': q.default ?? '',
          Chosen: q.default ?? '',
          Reversible: true,
          Date: today,
          ...(q.item !== 'none' ? { Item: q.item } : {}),
        },
      });
      await updateQuestions(o.projectDir, (s) => {
        const x = s[id] as QuestionState;
        x.status = 'expired';
        x.decision = dec;
      });
      await engineEntry(o.projectDir, o.runId, {
        tag: `${id}-expired`,
        created_at: now.toISOString(),
        op: 'update',
        database: 'questions',
        item_id: id,
        properties: { Status: 'Expired' },
      });
      await appendEvent(o.projectDir, {
        type: 'decision.made',
        actor: 'system',
        run_id: o.runId,
        ...(q.item !== 'none' ? { item: q.item } : {}),
        data: { decision: dec, question: id, chosen: q.default, assumed: true, expired: true },
      });
      const unblocked = await unblockIfClear(
        o.projectDir,
        o.runId,
        { ...q, status: 'expired' },
        id,
        now,
        o.budgetAvailable?.(q.item) ?? true,
      );
      res.tookDefault.push({ id, decision: dec, unblocked });
    } else res.flagged.push(id);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// The digest's view (spec 12.1): at most 10 questions, highest impact first, and the decisions to veto

export interface DigestQuestion {
  id: string;
  question: string;
  item: string;
  topic: string;
  blocking: boolean;
  hardStop?: string;
  default?: string;
  expires?: string;
  expired: boolean;
}

/**
 * Open questions for the owner, grouped by topic, highest impact first: blocking before
 * non-blocking, then hard-stop matters, then the oldest. Consults never reach the owner. At most
 * `max` are returned; the rest are only counted.
 */
export function digestQuestions(
  projectDir: string,
  o: { max?: number; now?: Date } = {},
): { shown: DigestQuestion[]; more: number; byTopic: Map<string, DigestQuestion[]> } {
  const max = o.max ?? MAX_QUESTIONS_PER_DIGEST;
  const today = (o.now ?? new Date()).toISOString().slice(0, 10);
  const open = Object.entries(readQuestions(projectDir))
    .filter(([, q]) => q.route === 'owner' && q.status === 'open')
    .sort(
      ([ia, a], [ib, b]) =>
        Number(b.blocking) - Number(a.blocking) ||
        Number(b.hard_stop !== undefined) - Number(a.hard_stop !== undefined) ||
        a.created_at.localeCompare(b.created_at) ||
        ia.localeCompare(ib),
    );
  const all: DigestQuestion[] = open.map(([id, q]) => ({
    id,
    question: q.question,
    item: q.item,
    topic: q.topic ?? q.item,
    blocking: q.blocking,
    ...(q.hard_stop ? { hardStop: q.hard_stop } : {}),
    ...(q.default !== undefined ? { default: q.default } : {}),
    ...(q.expires ? { expires: q.expires } : {}),
    expired: q.expires !== undefined && q.expires < today,
  }));
  const shown = all.slice(0, max);
  const byTopic = new Map<string, DigestQuestion[]>();
  for (const d of shown) byTopic.set(d.topic, [...(byTopic.get(d.topic) ?? []), d]);
  return { shown, more: Math.max(0, all.length - shown.length), byTopic };
}

/** DEC records made on the owner's behalf that have no veto yet: the digest shows each with a veto box. */
export function decisionsToVeto(
  projectDir: string,
  o: { sinceDate?: string } = {},
): { id: string; summary: string; chosen: string; item?: string; date: string }[] {
  const m = readMirror(projectDir, 'decisions');
  return (m?.rows ?? [])
    .filter(
      (r) =>
        r.properties['Veto'] !== true &&
        (o.sinceDate === undefined || String(r.properties['Date'] ?? '') >= o.sinceDate),
    )
    .map((r) => ({
      id: r.id,
      summary: String(r.properties['Summary'] ?? ''),
      chosen: String(r.properties['Chosen'] ?? ''),
      ...(r.properties['Item'] ? { item: String(r.properties['Item']) } : {}),
      date: String(r.properties['Date'] ?? ''),
    }));
}
