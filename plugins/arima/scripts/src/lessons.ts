import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from './events.js';
import { writeFileAtomic } from './lib/atomic-file.js';
import { findSecrets } from './lib/secrets.js';
import { registerEngineEntry } from './notion/allocations.js';
import { readMirror } from './notion/mirror.js';
import { enqueue } from './notion/outbox.js';
import { isRole } from './roles.js';

/**
 * The learning loop (spec 7.11, RD-F06-12, WP-217). An approved project lesson (Lessons row, Scope
 * `project`, Status `Approved`) is validated and written as a project override in `.arima/overrides/`;
 * the packet builder shows the overrides of a role in its Conditions. A lesson may add a practice; it may
 * never loosen a hard stop, a guard, an approval or an agent's must-nots, so a validator refuses those, and
 * it runs again when an override is READ (the orchestrator can write that folder directly).
 */

export const MAX_LESSON_CHARS = 500;
export const MAX_OVERRIDES_PER_ROLE = 10;

/** Words that make a lesson a rule change instead of a practice. Matched on the lower-cased text. */
const FORBIDDEN: [RegExp, string][] = [
  [
    /hard[ -]?stop|kill[ -]?switch|budget (cap|limit)|paid service|production deploy/,
    'touches a hard stop',
  ],
  [
    /\bguard\b|\bhook\b|permission|allow[- ]?list|deny rule|--no-verify|bypass|disable|turn off/,
    'touches a guard or a permission',
  ],
  [
    /\bapprov|\bveto|\bgate\b|merge|push to|force[- ]?push/,
    'touches an approval, a gate or merging',
  ],
  [
    /must not|never do|ignore (all|any|the|previous|prior|earlier)|disregard|forget|override (the|your|all)/,
    "rewrites an agent's must-nots or instructions",
  ],
  [/secret|token|credential|password|api[ -]?key|\.env\b/, 'mentions a secret or a credential'],
  [
    /skip (the )?(test|review|qa|gate|check|scan)|without (a )?(test|review|qa)|no (test|review) needed/,
    'weakens a check',
  ],
  [/delete|drop table|rm -rf|truncate/, 'proposes a destructive action'],
];

export function validateLesson(text: string): string[] {
  const problems: string[] = [];
  const t = text.trim();
  if (t.length < 10) problems.push('the lesson is empty or too short to act on');
  if (t.length > MAX_LESSON_CHARS)
    problems.push(`the lesson is longer than ${MAX_LESSON_CHARS} characters`);
  if (
    [...t].some((c) => {
      const n = c.charCodeAt(0);
      return n < 9 || n === 11 || n === 12 || (n >= 14 && n <= 31);
    })
  )
    problems.push('the lesson contains control characters');
  if (/```|<\/?[a-z]+[^>]*>/i.test(t)) problems.push('the lesson contains code fences or markup');
  const lc = t.toLowerCase();
  for (const [re, why] of FORBIDDEN) if (re.test(lc)) problems.push(why);
  if (findSecrets(t).length > 0) problems.push('the lesson looks like it contains a secret');
  return problems;
}

export interface Override {
  id: string;
  role: string;
  text: string;
}

const dirOf = (projectDir: string): string => path.join(projectDir, '.arima', 'overrides');

const render = (o: Override): string =>
  `lesson: ${o.id}\nrole: ${o.role}\nscope: project\n\n${o.text.trim()}\n`;

/** Reads the overrides of a role (and those for every role), validating each again; an invalid file is skipped and reported. */
export function readOverrides(
  projectDir: string,
  role: string,
): { overrides: Override[]; skipped: { file: string; problems: string[] }[] } {
  const dir = dirOf(projectDir);
  const overrides: Override[] = [];
  const skipped: { file: string; problems: string[] }[] = [];
  if (!existsSync(dir)) return { overrides, skipped };
  for (const f of readdirSync(dir)
    .filter((n) => /^LES-\d+\.md$/.test(n))
    .sort()) {
    const text = readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const m = /^lesson: (LES-\d+)\nrole: (\S+)\nscope: project\n\n([\s\S]*)$/.exec(text);
    if (m === null) {
      skipped.push({ file: f, problems: ['not in the override format'] });
      continue;
    }
    const [, id, r, body] = m as unknown as [string, string, string, string];
    const problems = validateLesson(body);
    if (r !== 'all' && !isRole(r)) problems.push(`unknown role ${r}`);
    if (problems.length > 0) {
      skipped.push({ file: f, problems });
      continue;
    }
    if (r === role || r === 'all') overrides.push({ id, role: r, text: body.trim() });
  }
  return { overrides: overrides.slice(0, MAX_OVERRIDES_PER_ROLE), skipped };
}

/** The lines the packet builder adds to a role's Conditions. */
export const overrideConditions = (projectDir: string, role: string): string[] =>
  readOverrides(projectDir, role).overrides.map(
    (o) => `Project lesson ${o.id} (approved): ${o.text.replace(/\s+/g, ' ')}`,
  );

export interface ApplyResult {
  applied: string[];
  refused: { id: string; problems: string[] }[];
}

/**
 * Writes an override for every approved project lesson that has none, queues `Applied` (an engine Status
 * write) and records `lesson.applied`. A lesson the validator refuses is queued as `Rejected` with the
 * reasons in the event log, so it is not retried every day.
 */
export async function applyApprovedLessons(o: {
  projectDir: string;
  runId: string;
  now?: Date;
}): Promise<ApplyResult> {
  const now = o.now ?? new Date();
  const res: ApplyResult = { applied: [], refused: [] };
  let n = 0;
  for (const r of readMirror(o.projectDir, 'lessons')?.rows ?? []) {
    if (r.properties['Status'] !== 'Approved' || r.properties['Scope'] !== 'project') continue;
    if (!/^LES-\d+$/.test(r.id)) continue;
    const text = String(r.properties['Change'] ?? '');
    const role = String(r.properties['Proposed by'] ?? '');
    const problems = validateLesson(text);
    if (!isRole(role)) problems.push(`"Proposed by" must name a role, not "${role}"`);
    n += 1;
    const status = async (to: 'Applied' | 'Rejected'): Promise<void> => {
      const id = `st-${o.runId}-${r.id}-${to.toLowerCase()}`;
      await registerEngineEntry(o.projectDir, id);
      enqueue(o.projectDir, {
        id,
        created_at: new Date(now.getTime() + n).toISOString(),
        run_id: o.runId,
        role: 'orchestrator',
        op: 'update',
        database: 'lessons',
        item_id: r.id,
        properties: { Status: to },
      });
    };
    if (problems.length > 0) {
      res.refused.push({ id: r.id, problems });
      await appendEvent(o.projectDir, {
        type: 'notion.refused',
        actor: 'orchestrator',
        run_id: o.runId,
        data: { lesson: r.id, reason: problems.join('; ') },
      });
      await status('Rejected');
      continue;
    }
    mkdirSync(dirOf(o.projectDir), { recursive: true });
    writeFileAtomic(path.join(dirOf(o.projectDir), `${r.id}.md`), render({ id: r.id, role, text }));
    res.applied.push(r.id);
    await appendEvent(o.projectDir, {
      type: 'lesson.applied',
      actor: 'orchestrator',
      run_id: o.runId,
      data: { lesson: r.id, role },
    });
    await status('Applied');
  }
  return res;
}
