import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkApprover } from './approver.js';
import type { Decider } from './approver.js';
import type { TeamConfig } from './config.js';
import { appendEvent } from './events.js';
import { reconcileStatuses, mirrorStatus, moveItem } from './item-status.js';
import type { Adopted } from './item-status.js';
import { writeFileAtomic } from './lib/atomic-file.js';
import { withFileLock } from './lib/filelock.js';
import { describeError, getValidator } from './lib/schema.js';
import { allocateId, registerEngineEntry } from './notion/allocations.js';
import { readMirror } from './notion/mirror.js';
import type { MirrorRow } from './notion/mirror.js';
import { enqueue } from './notion/outbox.js';
import type { GateId, Profile } from './profiles.js';
import { applyAnswers, raiseQuestions } from './questions.js';

/**
 * The inbox (spec 7.2 step 3, 12.2; F03 5.5; WP-140): after a `pull`, applies what a human did in
 * Notion, through the engine and never through an agent's outbox. Handled here: gate decisions
 * (checked by `checkApprover`), answers to questions (unblocking stories), vetoes of decisions
 * (a BUG with the reason, and the story reopened when it is waiting in PO Acceptance), and
 * `Status` edits of stories (adopted, the human wins). Priority edits need no action: the queue
 * reads `Priority` from the mirror. Idempotent: a cursor remembers what was already applied.
 * Not yet handled (their packages own them): release approvals and change-request decisions.
 */

const GATE_DECISIONS = ['Approved', 'Approved with conditions', 'Rejected'];

type Cursor = {
  schema_version: 1;
  processed: Partial<Record<'gates' | 'decisions', Record<string, string>>>;
};

export const cursorFile = (projectDir: string): string =>
  path.join(projectDir, '.arima', 'state', 'inbox-cursor.json');

export function readCursor(projectDir: string): Cursor {
  const f = cursorFile(projectDir);
  if (!existsSync(f)) return { schema_version: 1, processed: {} };
  const data: unknown = JSON.parse(readFileSync(f, 'utf8'));
  const v = getValidator('inbox-cursor');
  if (!v(data)) throw new Error(`Corrupt ${f}: ${(v.errors ?? []).map(describeError).join('; ')}`);
  return data as Cursor;
}

async function markProcessed(
  projectDir: string,
  db: 'gates' | 'decisions',
  key: string,
  hash: string,
): Promise<void> {
  const f = cursorFile(projectDir);
  mkdirSync(path.dirname(f), { recursive: true });
  await withFileLock(`${f}.lock`, () => {
    const c = readCursor(projectDir);
    c.processed[db] = { ...(c.processed[db] ?? {}), [key]: hash };
    writeFileAtomic(f, `${JSON.stringify(c, null, 2)}\n`);
  });
}

const hash = (...parts: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const deciders = (v: unknown): Decider[] =>
  Array.isArray(v) ? v.filter((x): x is Decider => typeof x === 'object' && x !== null) : [];

export interface InboxInput {
  projectDir: string;
  /** An engine run with a `run.start` event (the entries it queues are bound to it). */
  runId: string;
  team: Pick<TeamConfig, 'people' | 'roles'>;
  profile: Pick<Profile, 'gates'>;
  now?: Date;
  /** Whether a story may return to a spending state (the dispatcher checks the budget). */
  budgetAvailable?: (item: string) => boolean;
}

export interface InboxResult {
  gates: { gate: string; status: string; ok: boolean }[];
  answered: string[];
  unblocked: string[];
  vetoes: { decision: string; bug?: string; reopened: boolean }[];
  statusEdits: Adopted[];
}

async function applyGates(i: InboxInput, res: InboxResult): Promise<void> {
  const rows = readMirror(i.projectDir, 'gates')?.rows ?? [];
  for (const row of rows) {
    const status = text(row.properties['Status']);
    if (!GATE_DECISIONS.includes(status)) continue;
    const by = deciders(row.properties['Decided by']);
    const h = hash(
      status,
      by.map((d) => d.id ?? d.name),
    );
    if (readCursor(i.projectDir).processed.gates?.[row.id] === h) continue;
    const gate = row.id as GateId;
    const check = checkApprover({ gate, decidedBy: by, team: i.team, profile: i.profile });
    if (check.ok) {
      await appendEvent(i.projectDir, {
        type: 'gate.decided',
        actor: 'human',
        run_id: i.runId,
        data: {
          gate,
          status,
          decided_by: by.map((d) => d.name ?? d.id),
          approver_check: { method: check.method, ok: true },
        },
      });
    } else {
      // Not a listed approver: ignored, recorded, and one question is raised (RD-F03-7). Nothing is reverted in Notion.
      await appendEvent(i.projectDir, {
        type: 'notion.refused',
        actor: 'system',
        run_id: i.runId,
        data: {
          reason: `gate ${gate} was set to ${status} by someone who is not a listed approver`,
          gate,
          approvers: check.approvers,
        },
      });
      await raiseQuestions({
        projectDir: i.projectDir,
        runId: i.runId,
        role: 'orchestrator',
        item: 'none',
        policy: 'assume_and_log',
        engineHardStop: gate,
        ...(i.now ? { now: i.now } : {}),
        questions: [
          {
            question: `${gate} was marked ${status} in Notion by someone who is not a listed approver (${check.approvers.join(', ') || 'none listed'}). Please confirm the decision yourself.`,
            options: [{ label: 'I decide it myself in Notion', recommendation: true }],
            blocking: true,
            topic: gate,
          },
        ],
      });
    }
    await markProcessed(i.projectDir, 'gates', row.id, h);
    res.gates.push({ gate, status, ok: check.ok });
  }
}

async function applyVetoes(i: InboxInput, res: InboxResult): Promise<void> {
  const rows: MirrorRow[] = readMirror(i.projectDir, 'decisions')?.rows ?? [];
  const now = i.now ?? new Date();
  let n = 0;
  for (const row of rows) {
    if (row.properties['Veto'] !== true) continue;
    const reason = text(row.properties['Veto reason']).trim();
    const h = hash(true, reason);
    if (readCursor(i.projectDir).processed.decisions?.[row.id] === h) continue;
    const item = text(row.properties['Item']);
    const story = /^US-\d+$/.test(item);
    await appendEvent(i.projectDir, {
      type: 'decision.vetoed',
      actor: 'human',
      run_id: i.runId,
      ...(item ? { item } : {}),
      data: { decision: row.id, reason },
    });
    const v: InboxResult['vetoes'][number] = { decision: row.id, reopened: false };
    if (story) {
      n += 1;
      const bug = await allocateId(i.projectDir, 'BUG', i.runId);
      const id = `st-${i.runId}-${row.id}-bug`;
      await registerEngineEntry(i.projectDir, id);
      enqueue(i.projectDir, {
        id,
        created_at: new Date(now.getTime() + n).toISOString(),
        run_id: i.runId,
        role: 'orchestrator',
        op: 'create',
        database: 'bugs',
        properties: {
          ID: bug,
          Title: `Vetoed: ${text(row.properties['Summary'])}`.slice(0, 200),
          Severity: 'S3',
          Status: 'Open',
          'Found by': 'orchestrator',
          Steps: `Decision ${row.id} was made on the owner's behalf for ${item}.`,
          Expected: 'The owner agrees with the decision.',
          Actual: `Vetoed${reason ? `: ${reason}` : ' (no reason given)'}`,
          Story: [item],
        },
      });
      v.bug = bug;
      // At the milestone review the story waits in PO Acceptance: the veto sends it back (spec 7.1).
      if (mirrorStatus(i.projectDir, item) === 'PO Acceptance') {
        const moved = await moveItem({
          projectDir: i.projectDir,
          item,
          to: 'In Progress',
          actor: 'po',
          runId: i.runId,
          now,
          facts: {
            guards: { vetoed: true, bug_with_reason: true },
            budget_available: i.budgetAvailable?.(item) ?? true,
            reason: reason || `vetoed ${row.id}`,
          },
        });
        v.reopened = moved.ok;
      }
    }
    await markProcessed(i.projectDir, 'decisions', row.id, h);
    res.vetoes.push(v);
  }
}

/** Applies every human input found in the mirror. Run it after `arima-notion pull`. */
export async function applyHumanInputs(i: InboxInput): Promise<InboxResult> {
  const res: InboxResult = { gates: [], answered: [], unblocked: [], vetoes: [], statusEdits: [] };
  await applyGates(i, res);
  const a = await applyAnswers({
    projectDir: i.projectDir,
    runId: i.runId,
    ...(i.now ? { now: i.now } : {}),
    ...(i.budgetAvailable ? { budgetAvailable: i.budgetAvailable } : {}),
  });
  res.answered = a.answered;
  res.unblocked = a.unblocked;
  await applyVetoes(i, res);
  res.statusEdits = await reconcileStatuses(i.projectDir);
  return res;
}
