import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateProject } from '../config.js';
import { DigestSecretError, buildDigest, publishDigest } from '../digest.js';
import { appendEvent } from '../events.js';
import { guardInteractive } from '../interactive.js';
import type { WaitOptions } from '../interactive.js';
import { issueRunId } from '../runid.js';
import type { Io } from './config-cli.js';

export const DIGEST_EXIT = { ok: 0, failed: 1, usage: 2, config: 10, locked: 11 } as const;

export const DIGEST_USAGE = `Usage: arima-digest [--date YYYY-MM-DD] [--no-push] [--json] [--run-id <id>] [--project <dir>]
Builds the daily digest (spec 12.1): a local copy in .arima/digests/ and, unless --no-push, a queued Notion row (run arima-notion push to apply).
It is on demand until Gate U: the page says when it was built. Every number is computed here; amounts are estimated consumption on the seat.
Exit codes: 0 ok, 1 not published (the page looks like it holds a secret), 2 usage (bad or future date), 10 config invalid, 11 a run holds the lock`;

export interface DigestCliDeps {
  now?: Date;
  lock?: Partial<WaitOptions>;
}

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** `arima-digest`: an interactive command, so it waits for a live run (spec 12.4). */
export async function runDigestCli(
  argv: string[],
  io: Io,
  deps: DigestCliDeps = {},
): Promise<number> {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        date: { type: 'string' },
        'no-push': { type: 'boolean' },
        json: { type: 'boolean' },
        'run-id': { type: 'string' },
        project: { type: 'string' },
      },
    }).values;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${DIGEST_USAGE}\n`);
    return DIGEST_EXIT.usage;
  }
  const now = deps.now ?? new Date();
  const date = typeof v['date'] === 'string' ? v['date'] : undefined;
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
    io.err(`--date must be YYYY-MM-DD\n${DIGEST_USAGE}\n`);
    return DIGEST_EXIT.usage;
  }
  if (date !== undefined && date > localDate(now)) {
    io.err(`--date ${date} is in the future\n${DIGEST_USAGE}\n`);
    return DIGEST_EXIT.usage;
  }
  const rid = typeof v['run-id'] === 'string' ? v['run-id'] : undefined;
  if (rid !== undefined && !/^r-\d{8}-\d{4}-\d{2,}$/.test(rid)) {
    io.err(`--run-id is not a run id\n${DIGEST_USAGE}\n`);
    return DIGEST_EXIT.usage;
  }
  const projectDir = path.resolve(io.cwd, typeof v['project'] === 'string' ? v['project'] : '.');
  const cfg = validateProject(projectDir);
  if (!cfg.ok || cfg.arima === undefined) {
    for (const e of cfg.errors) io.err(`${path.basename(e.file)}:${e.line}: ${e.message}\n`);
    return DIGEST_EXIT.config;
  }
  const push = v['no-push'] !== true;
  if (push) {
    const stop = await guardInteractive({
      projectDir,
      command: 'arima-digest',
      holderRunId: rid,
      ...(deps.lock ?? {}),
      err: io.err,
      note: io.err,
    });
    if (stop !== undefined) return stop;
  }
  try {
    const model = buildDigest(projectDir, now, date !== undefined ? { date } : {});
    let runId = rid;
    if (push && runId === undefined) {
      runId = await issueRunId(projectDir, now);
      await appendEvent(projectDir, {
        type: 'run.start',
        actor: 'orchestrator',
        run_id: runId,
        data: { command: 'digest' },
      });
    }
    const pub = await publishDigest({
      projectDir,
      runId: runId ?? 'r-00000000-0000-00',
      model,
      push,
      now,
    });
    if (v['json'] === true)
      io.out(
        `${JSON.stringify({ date: model.date, health: model.health, file: pub.file, queued: pub.queued, sections: model.sections })}\n`,
      );
    else {
      io.out(`${model.headline}\n`);
      for (const w of model.warnings) io.out(`note: ${w}\n`);
      io.out(
        `digest ${model.date} written to ${path.relative(projectDir, pub.file)}${pub.queued ? (pub.created ? '; queued the Notion row (run arima-notion push to apply)' : '; queued an update of the Notion row') : ''}\n`,
      );
    }
    return DIGEST_EXIT.ok;
  } catch (e) {
    if (e instanceof DigestSecretError) {
      io.err(`${e.message}\n`);
      return DIGEST_EXIT.failed;
    }
    throw e;
  }
}
