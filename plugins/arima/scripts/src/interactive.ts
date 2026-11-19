import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import { appendEvent } from './events.js';
import { lockStatus } from './runlock.js';
import type { RunLock } from './runlock.js';

/**
 * Interactive commands and the daily run (spec 12.4; RD-F03-5; WP-160): a human may run any command
 * at any time, but a command that reads or writes shared state waits for a live run to finish
 * instead of running beside it. It waits up to 60 seconds for `.arima/run.lock`, then exits 11. A
 * command that sends changes out (`arima-notion push`) also refuses while the kill switch is on
 * (exit 12); a read-only command (`pull`, `status`) stays allowed while paused, so the project can
 * always be looked at. The dispatcher and its own child processes name their run (`--as-run`,
 * `--run-id`): the lock they find is their own, so they never wait on themselves.
 */

export const INTERACTIVE_EXIT = { locked: 11, paused: 12 } as const;
export const LOCK_WAIT_MS = 60_000;
export const LOCK_POLL_MS = 1_000;

/** `schedule.max_run_minutes + 30`, as preflight: the age after which a lock is stale. Falls back to a safe default without a config. */
export function staleMsFor(projectDir: string): number {
  const file = path.join(projectDir, 'arima.yaml');
  let minutes = 240;
  if (existsSync(file)) {
    try {
      const m = (parse(readFileSync(file, 'utf8')) as { schedule?: { max_run_minutes?: number } })
        .schedule?.max_run_minutes;
      if (typeof m === 'number' && m > 0) minutes = m;
    } catch {
      /* an invalid config is reported by the command itself */
    }
  }
  return (minutes + 30) * 60_000;
}

export interface WaitOptions {
  projectDir: string;
  maxWaitMs?: number;
  pollMs?: number;
  /** The run that is calling: a lock held by this run is its own. */
  holderRunId?: string | undefined;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export type WaitResult =
  { ok: true; waitedMs: number } | { ok: false; waitedMs: number; lock: RunLock | undefined };

/** Waits until no live run holds the lock, or `maxWaitMs` has passed. A stale lock is not held. */
export async function waitForRunLock(o: WaitOptions): Promise<WaitResult> {
  const maxWait = o.maxWaitMs ?? LOCK_WAIT_MS;
  const poll = o.pollMs ?? LOCK_POLL_MS;
  const sleep = o.sleep ?? ((ms: number) => delay(ms));
  const clock = o.clock ?? Date.now;
  const start = clock();
  const stale = staleMsFor(o.projectDir);
  for (;;) {
    const s = lockStatus(o.projectDir, stale, clock());
    if (!s.held || (o.holderRunId !== undefined && s.lock?.run_id === o.holderRunId))
      return { ok: true, waitedMs: clock() - start };
    const waited = clock() - start;
    if (waited >= maxWait) return { ok: false, waitedMs: waited, lock: s.lock };
    await sleep(Math.min(poll, maxWait - waited));
  }
}

export interface GuardOptions extends Omit<WaitOptions, 'projectDir'> {
  projectDir: string;
  /** What the command is called, for the message. */
  command: string;
  /** For commands that send changes out: true when the kill switch is on. */
  isPaused?: () => Promise<boolean>;
  err: (s: string) => void;
  /** Tells the person it is waiting (once, on the first wait). */
  note?: (s: string) => void;
}

/**
 * The gate every interactive command passes: returns an exit code to stop with (11 or 12), or
 * undefined to go on. Records `hardstop.hit` when the kill switch stops a command.
 */
export async function guardInteractive(o: GuardOptions): Promise<number | undefined> {
  const first = await waitForRunLock({ ...o, maxWaitMs: 0 });
  if (!first.ok)
    o.note?.(
      `${o.command}: a run holds the lock (run ${first.lock?.run_id ?? '?'}); waiting up to ${Math.round((o.maxWaitMs ?? LOCK_WAIT_MS) / 1000)} s for it to finish\n`,
    );
  const r = first.ok ? first : await waitForRunLock(o);
  if (!r.ok) {
    o.err(
      `${o.command}: a run still holds .arima/run.lock after ${Math.round(r.waitedMs / 1000)} s (run ${r.lock?.run_id ?? '?'}, pid ${r.lock?.pid ?? '?'}). Try again when it has finished; ARIMA never removes a live lock.\n`,
    );
    return INTERACTIVE_EXIT.locked;
  }
  if (o.isPaused !== undefined && (await o.isPaused())) {
    await appendEvent(o.projectDir, {
      type: 'hardstop.hit',
      actor: 'system',
      data: { stop: 'kill_switch', message: `${o.command} refused: the kill switch is on` },
    });
    o.err(
      `${o.command}: ARIMA is paused (kill switch on), so nothing is sent out. Resume with /arima:pause --resume; queued changes stay in the outbox and go out after that.\n`,
    );
    return INTERACTIVE_EXIT.paused;
  }
  return undefined;
}
