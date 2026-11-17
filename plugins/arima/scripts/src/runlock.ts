import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

export interface RunLock {
  pid: number;
  run_id: string;
  host: string;
  started_at: string;
}

export interface LockStatus {
  held: boolean;
  /** A lock file exists but its owner is gone or it is older than the staleness limit. */
  stale: boolean;
  lock?: RunLock;
}

export function runLockFile(projectDir: string): string {
  return path.join(projectDir, '.arima', 'run.lock');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** Inspects .arima/run.lock. A lock is stale if its process is gone (same host) or it is too old. */
export function lockStatus(projectDir: string, staleAfterMs: number, now = Date.now()): LockStatus {
  const file = runLockFile(projectDir);
  if (!existsSync(file)) return { held: false, stale: false };
  let lock: RunLock;
  try {
    lock = JSON.parse(readFileSync(file, 'utf8')) as RunLock;
  } catch {
    return { held: false, stale: true };
  }
  const age = now - Date.parse(lock.started_at);
  const sameHost = lock.host === hostname();
  const dead = sameHost && !alive(lock.pid);
  if (dead || !(age < staleAfterMs)) return { held: false, stale: true, lock };
  return { held: true, stale: false, lock };
}

/** Takes the run lock atomically. Returns false if another live run holds it. */
export function acquireRunLock(projectDir: string, runId: string, staleAfterMs: number): boolean {
  const file = runLockFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const body: RunLock = {
    pid: process.pid,
    run_id: runId,
    host: hostname(),
    started_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${JSON.stringify(body)}\n`, { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      const status = lockStatus(projectDir, staleAfterMs);
      if (status.held) return false;
      rmSync(file, { force: true }); // stale: break it and retry once
    }
  }
  return false;
}

/** Releases the lock only if `runId` owns it, so one run cannot free another's lock. */
export function releaseRunLock(projectDir: string, runId: string): boolean {
  const file = runLockFile(projectDir);
  if (!existsSync(file)) return false;
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as RunLock;
    if (lock.run_id !== runId) return false;
  } catch {
    /* unreadable lock: treat as ours to clear */
  }
  rmSync(file, { force: true });
  return true;
}
