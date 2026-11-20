import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import { appendEvent } from '../events.js';
import { guardInteractive } from '../interactive.js';
import type { WaitOptions } from '../interactive.js';
import { checkKillSwitch } from '../killswitch.js';
import {
  REVIEW_WINDOW_HOURS,
  closeReview,
  milestoneStories,
  readReviews,
  reviewReady,
} from '../milestone-review.js';
import { readMirror } from '../notion/mirror.js';
import { issueRunId } from '../runid.js';
import type { Io } from './config-cli.js';

export const REVIEW_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  config: 10,
  locked: 11,
  killSwitch: 12,
} as const;

export const REVIEW_USAGE = `Usage: arima-review status [--project <dir>] [--json]
       arima-review close <MS-NN> [--run-id <id>] [--project <dir>]
A milestone review opens by itself when every story of the milestone is accepted (the daily run); each accepted story gets a Decisions row with a veto box. It closes by itself after ${REVIEW_WINDOW_HOURS} hours; "close" closes it now: the stories you did not veto become Done.
Exit codes: 0 ok, 1 failed (no open review for that milestone), 2 usage, 10 config invalid, 11 a run holds the lock, 12 kill switch is on`;

export interface ReviewCliDeps {
  now?: Date;
  lock?: Partial<WaitOptions>;
}

/** `arima-review`: shows the reviews and lets a human close one early. */
export async function runReviewCli(
  argv: string[],
  io: Io,
  deps: ReviewCliDeps = {},
): Promise<number> {
  let p: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    p = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        json: { type: 'boolean' },
        'run-id': { type: 'string' },
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${REVIEW_USAGE}\n`);
    return REVIEW_EXIT.usage;
  }
  const [command, target] = p.positionals;
  const rid = typeof p.values['run-id'] === 'string' ? p.values['run-id'] : undefined;
  if (rid !== undefined && !/^r-\d{8}-\d{4}-\d{2,}$/.test(rid)) {
    io.err(`--run-id is not a run id\n${REVIEW_USAGE}\n`);
    return REVIEW_EXIT.usage;
  }
  if (command !== 'status' && command !== 'close') {
    io.err(`${REVIEW_USAGE}\n`);
    return REVIEW_EXIT.usage;
  }
  if (command === 'close' && (target === undefined || !/^MS-\d{2,}$/.test(target))) {
    io.err(`close needs a milestone like MS-01\n${REVIEW_USAGE}\n`);
    return REVIEW_EXIT.usage;
  }
  const projectDir = path.resolve(
    io.cwd,
    typeof p.values['project'] === 'string' ? p.values['project'] : '.',
  );
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    return REVIEW_EXIT.config;
  }
  const now = deps.now ?? new Date();

  if (command === 'status') {
    const reviews = readReviews(projectDir);
    const lines = (readMirror(projectDir, 'milestones')?.rows ?? [])
      .filter((m) => /^MS-\d+$/.test(m.id))
      .map((m) => {
        const r = reviews[m.id];
        const stories = milestoneStories(projectDir, m.id).length;
        const state =
          r === undefined
            ? reviewReady(projectDir, m.id)
              ? 'ready to open'
              : 'collecting'
            : r.closed_at
              ? 'closed'
              : 'open';
        const closesIn =
          r && !r.closed_at
            ? Math.max(
                0,
                Math.round(
                  REVIEW_WINDOW_HOURS - (now.getTime() - Date.parse(r.opened_at)) / 3_600_000,
                ),
              )
            : undefined;
        return {
          milestone: m.id,
          status: String(m.properties['Status'] ?? ''),
          stories,
          review: state,
          ...(closesIn !== undefined ? { closes_in_hours: closesIn } : {}),
        };
      });
    io.out(
      p.values['json'] === true
        ? `${JSON.stringify(lines)}\n`
        : lines.length === 0
          ? 'no milestones\n'
          : `${lines.map((l) => `${l.milestone}\t${l.status}\t${l.stories} stories\treview ${l.review}${l.closes_in_hours !== undefined ? ` (closes by itself in ${l.closes_in_hours} h)` : ''}`).join('\n')}\n`,
    );
    return REVIEW_EXIT.ok;
  }

  if ((await checkKillSwitch(projectDir, null)).on) {
    io.err('refusing: the kill switch is on\n');
    return REVIEW_EXIT.killSwitch;
  }
  const stop = await guardInteractive({
    projectDir,
    command: 'arima-review close',
    holderRunId: rid,
    ...(deps.lock ?? {}),
    err: io.err,
    note: io.err,
  });
  if (stop !== undefined) return stop;
  const ms = target as string;
  const r = readReviews(projectDir)[ms];
  if (r === undefined || r.closed_at !== undefined) {
    io.err(`${ms} has no open review\n`);
    return REVIEW_EXIT.failed;
  }
  let runId = rid;
  if (runId === undefined) {
    runId = await issueRunId(projectDir, now);
    await appendEvent(projectDir, {
      type: 'run.start',
      actor: 'orchestrator',
      run_id: runId,
      data: { command: 'review' },
    });
  }
  const accepted = await closeReview({ projectDir, runId, now }, ms);
  io.out(
    `closed the review of ${ms}: ${accepted.length ? `${accepted.join(', ')} accepted (Done)` : 'nothing left to accept'} (run arima-notion push to apply)\n`,
  );
  return REVIEW_EXIT.ok;
}
