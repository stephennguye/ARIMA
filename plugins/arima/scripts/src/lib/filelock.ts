import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock file older than this is assumed to belong to a crashed process and is broken. */
  staleMs?: number;
  retryMs?: number;
}

const RETRYABLE = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function code(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

/**
 * Runs `fn` while holding an exclusive lock file (created with O_EXCL, so it is atomic on every
 * OS). Safe across processes. EPERM/EACCES are retried because Windows reports a file that is
 * pending deletion that way.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  { timeoutMs = 15_000, staleMs = 30_000, retryMs = 5 }: LockOptions = {},
): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      const c = code(e);
      if (c === undefined || !RETRYABLE.has(c)) throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath);
      } catch {
        /* lock vanished or is being removed: just retry */
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for lock ${lockPath}`, {
          cause: e,
        });
      }
      await sleep(retryMs + Math.floor(Math.random() * retryMs * 2));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already removed */
    }
  }
}
