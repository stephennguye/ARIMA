import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import { appendEvent } from '../events.js';
import { guardInteractive } from '../interactive.js';
import type { WaitOptions } from '../interactive.js';
import { applyApprovedLessons, readOverrides } from '../lessons.js';
import { issueRunId } from '../runid.js';
import { isRole } from '../roles.js';
import type { Io } from './config-cli.js';

export const LESSONS_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  config: 10,
  locked: 11,
  refused: 62,
} as const;

export const LESSONS_USAGE = `Usage: arima-lessons apply [--run-id <id>] [--project <dir>]
       arima-lessons show <role> [--project <dir>]
"apply" turns every approved project lesson (Lessons row: Scope project, Status Approved) into an override in .arima/overrides/ and queues Status Applied; a lesson that touches a hard stop, a guard, an approval, a must-not or a secret is refused and queued as Rejected. "show" prints what a role's packets will carry.
Exit codes: 0 ok, 1 failed, 2 usage, 10 config invalid, 11 a run holds the lock, 62 at least one lesson was refused`;

export interface LessonsCliDeps {
  now?: Date;
  lock?: Partial<WaitOptions>;
}

export async function runLessonsCli(
  argv: string[],
  io: Io,
  deps: LessonsCliDeps = {},
): Promise<number> {
  let p: { values: Record<string, string | undefined>; positionals: string[] };
  try {
    p = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { project: { type: 'string' }, 'run-id': { type: 'string' } },
    }) as typeof p;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${LESSONS_USAGE}\n`);
    return LESSONS_EXIT.usage;
  }
  const [command, role] = p.positionals;
  if (
    (command !== 'apply' && command !== 'show') ||
    (command === 'show' && (role === undefined || !(isRole(role) || role === 'all')))
  ) {
    io.err(`${LESSONS_USAGE}\n`);
    return LESSONS_EXIT.usage;
  }
  const rid = p.values['run-id'];
  if (rid !== undefined && !/^r-\d{8}-\d{4}-\d{2,}$/.test(rid)) {
    io.err(`--run-id is not a run id\n${LESSONS_USAGE}\n`);
    return LESSONS_EXIT.usage;
  }
  const projectDir = path.resolve(io.cwd, p.values['project'] ?? '.');
  const cfg = validateProject(projectDir);
  if (!cfg.ok) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    return LESSONS_EXIT.config;
  }
  if (command === 'show') {
    const { overrides, skipped } = readOverrides(projectDir, role as string);
    io.out(
      overrides.length
        ? `${overrides.map((o) => `${o.id} (${o.role}): ${o.text}`).join('\n')}\n`
        : 'no overrides\n',
    );
    for (const s of skipped) io.err(`skipped ${s.file}: ${s.problems.join('; ')}\n`);
    return LESSONS_EXIT.ok;
  }
  const stop = await guardInteractive({
    projectDir,
    command: 'arima-lessons apply',
    holderRunId: rid,
    ...(deps.lock ?? {}),
    err: io.err,
    note: io.err,
  });
  if (stop !== undefined) return stop;
  const now = deps.now ?? new Date();
  let runId = rid;
  if (runId === undefined) {
    runId = await issueRunId(projectDir, now);
    await appendEvent(projectDir, {
      type: 'run.start',
      actor: 'orchestrator',
      run_id: runId,
      data: { command: 'lessons' },
    });
  }
  const r = await applyApprovedLessons({ projectDir, runId, now });
  io.out(
    `applied ${r.applied.length}${r.applied.length ? ` (${r.applied.join(', ')})` : ''}; refused ${r.refused.length} (run arima-notion push to apply the Status changes)\n`,
  );
  for (const x of r.refused) io.err(`${x.id} refused: ${x.problems.join('; ')}\n`);
  return r.refused.length > 0 ? LESSONS_EXIT.refused : LESSONS_EXIT.ok;
}
