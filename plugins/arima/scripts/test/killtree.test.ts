// Judge #2: the old tree-kill test passed even with `taskkill /T` removed, because on Windows a
// Node grandchild dies with its Node parent anyway (libuv job object). These tests make the
// grandchild outlive a plain kill first (the control), so they fail if killTree stops killing the tree.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { killTree } from '../src/run-agent.js';
import { tempDir } from './helpers.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  for (let t = 0; t < ms; t += 100) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

/** Starts the stub in "hang with a grandchild" mode, the way runAgent starts claude. */
async function startTree(): Promise<{ parent: number; grandchild: number; cleanup: () => void }> {
  const pidFile = path.join(tempDir(), 'grandchild.pid');
  const child = spawn(process.execPath, [STUB], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, STUB_MODE: 'hang_tree', STUB_PIDFILE: pidFile },
  });
  expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '')).toBe(
    true,
  );
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  const parent = child.pid as number;
  const cleanup = (): void => {
    for (const p of [grandchild, parent]) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    try {
      process.kill(-parent, 'SIGKILL');
    } catch {
      /* gone, or Windows */
    }
  };
  return { parent, grandchild, cleanup };
}

describe('killTree', () => {
  it('CONTROL: killing only the parent leaves the grandchild running, so the test can fail', async () => {
    const t = await startTree();
    try {
      process.kill(t.parent, 'SIGKILL');
      expect(await waitFor(() => !alive(t.parent))).toBe(true);
      await sleep(500);
      expect(alive(t.grandchild)).toBe(true);
    } finally {
      t.cleanup();
    }
  }, 30_000);

  it('kills the parent AND the grandchild', async () => {
    const t = await startTree();
    try {
      expect(alive(t.parent)).toBe(true);
      expect(alive(t.grandchild)).toBe(true);
      killTree(t.parent);
      expect(await waitFor(() => !alive(t.parent))).toBe(true);
      expect(await waitFor(() => !alive(t.grandchild))).toBe(true);
    } finally {
      t.cleanup();
    }
  }, 30_000);

  it('does nothing and does not throw for a missing or already-dead pid', () => {
    expect(() => killTree(undefined)).not.toThrow();
    expect(() => killTree(2 ** 22 - 7)).not.toThrow();
  });
});
