// WP-160: interactive commands respect the run lock and the kill switch (spec 12.4, RD-F03-5, G-10).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCostCli } from '../src/cli/cost-cli.js';
import { runNotionCli } from '../src/cli/notion-cli.js';
import { runStateCli } from '../src/cli/state-cli.js';
import { appendEvent, readEvents } from '../src/events.js';
import {
  INTERACTIVE_EXIT,
  LOCK_WAIT_MS,
  guardInteractive,
  staleMsFor,
  waitForRunLock,
} from '../src/interactive.js';
import { appendLedgerRow } from '../src/ledger.js';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { enqueue, outboxDir } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { acquireRunLock, releaseRunLock, runLockFile } from '../src/runlock.js';
import { setPauseFile } from '../src/killswitch.js';
import { FakeNotion } from './fake-notion.js';
import { example, tempDir } from './helpers.js';

const HOLDER = 'r-20261119-2300-01';
const OTHER = 'r-20261119-2300-02';

/** A fake clock and sleep: waiting costs no real time, and a hook can run while "waiting". */
function clock(onSleep?: (n: number) => void) {
  let now = 1_000_000;
  let sleeps = 0;
  return {
    clock: () => now,
    sleep: (ms: number) => {
      now += ms;
      sleeps += 1;
      onSleep?.(sleeps);
      return Promise.resolve();
    },
    get sleeps() {
      return sleeps;
    },
  };
}
const hold = (dir: string, id = HOLDER): void => void acquireRunLock(dir, id, 3_600_000);

describe('waitForRunLock', () => {
  it('returns at once when no run holds the lock', async () => {
    const dir = tempDir();
    const c = clock();
    expect(await waitForRunLock({ projectDir: dir, ...c })).toEqual({ ok: true, waitedMs: 0 });
    expect(c.sleeps).toBe(0);
  });

  it('waits while a live run holds it and times out after 60 s, naming the holder', async () => {
    const dir = tempDir();
    hold(dir);
    const c = clock();
    const r = await waitForRunLock({ projectDir: dir, ...c });
    expect(r).toMatchObject({
      ok: false,
      waitedMs: LOCK_WAIT_MS,
      lock: { run_id: HOLDER, pid: process.pid },
    });
    expect(c.sleeps).toBe(60);
    expect(LOCK_WAIT_MS).toBe(60_000);
  });

  it('goes ahead as soon as the run releases the lock', async () => {
    const dir = tempDir();
    hold(dir);
    const c = clock((n) => {
      if (n === 5) releaseRunLock(dir, HOLDER);
    });
    expect(await waitForRunLock({ projectDir: dir, ...c })).toEqual({ ok: true, waitedMs: 5000 });
  });

  it('a stale lock (its process is gone, or it is too old) is not held', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(
      runLockFile(dir),
      JSON.stringify({
        pid: 2_147_483_000,
        run_id: HOLDER,
        host: (await import('node:os')).hostname(),
        started_at: new Date().toISOString(),
      }),
    );
    expect((await waitForRunLock({ projectDir: dir, ...clock() })).ok).toBe(true);
    writeFileSync(
      runLockFile(dir),
      JSON.stringify({
        pid: process.pid,
        run_id: HOLDER,
        host: (await import('node:os')).hostname(),
        started_at: '2020-01-01T00:00:00.000Z',
      }),
    );
    expect(
      (await waitForRunLock({ projectDir: dir, ...clock(), clock: () => Date.now() })).ok,
    ).toBe(true);
  });

  it('the run that holds the lock never waits on itself', async () => {
    const dir = tempDir();
    hold(dir);
    expect((await waitForRunLock({ projectDir: dir, holderRunId: HOLDER, ...clock() })).ok).toBe(
      true,
    );
    expect(
      (await waitForRunLock({ projectDir: dir, holderRunId: OTHER, ...clock(), maxWaitMs: 3000 }))
        .ok,
    ).toBe(false);
  });

  it('the staleness limit is max_run_minutes plus 30, from arima.yaml', () => {
    const dir = tempDir();
    expect(staleMsFor(dir)).toBe(270 * 60_000);
    writeFileSync(path.join(dir, 'arima.yaml'), 'schedule:\n  max_run_minutes: 60\n');
    expect(staleMsFor(dir)).toBe(90 * 60_000);
    writeFileSync(path.join(dir, 'arima.yaml'), ': not yaml :');
    expect(staleMsFor(dir)).toBe(270 * 60_000);
  });
});

describe('guardInteractive', () => {
  const run = async (dir: string, over: Partial<Parameters<typeof guardInteractive>[0]> = {}) => {
    const r = { err: '' };
    const code = await guardInteractive({
      projectDir: dir,
      command: 'cmd',
      err: (s) => (r.err += s),
      note: (s) => (r.err += s),
      ...clock(),
      ...over,
    });
    return { code, ...r };
  };
  it('exits 11 with a message that names the run, and tells the person it is waiting', async () => {
    const dir = tempDir();
    hold(dir);
    const r = await run(dir);
    expect(r.code).toBe(INTERACTIVE_EXIT.locked);
    expect(r.err).toContain('waiting up to 60 s');
    expect(r.err).toContain(`run ${HOLDER}`);
    expect(r.err).toContain('never removes a live lock');
  });
  it('exits 12 and records a hard stop when the kill switch is on', async () => {
    const dir = tempDir();
    const r = await run(dir, { isPaused: () => Promise.resolve(true) });
    expect(r.code).toBe(INTERACTIVE_EXIT.paused);
    expect(readEvents(dir).find((e) => e.type === 'hardstop.hit')).toMatchObject({
      data: { stop: 'kill_switch' },
    });
    expect((await run(dir, { isPaused: () => Promise.resolve(false) })).code).toBeUndefined();
    expect((await run(dir)).code).toBeUndefined();
  });
  it('the lock is checked before the kill switch', async () => {
    const dir = tempDir();
    hold(dir);
    expect((await run(dir, { isPaused: () => Promise.resolve(true) })).code).toBe(11);
  });
});

describe('arima-notion pull and push', () => {
  async function world() {
    const fake = new FakeNotion();
    const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
    await bootstrapTemplate(port, fake.rootId);
    const map = (await mapWorkspace(port, fake.rootId)).map!;
    const dir = tempDir('arima-lock-');
    mkdirSync(path.join(dir, '.arima'), { recursive: true });
    writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
    await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: HOLDER });
    return { fake, port, dir };
  }
  const go = async (w: Awaited<ReturnType<typeof world>>, argv: string[], extra: object = {}) => {
    const r = { out: '', err: '' };
    const code = await runNotionCli(
      argv,
      { out: (s) => (r.out += s), err: (s) => (r.err += s), cwd: w.dir },
      {
        portFactory: () => w.port,
        env: { ARIMA_NOTION_TOKEN: 'ntn_not_a_real_token' },
        now: new Date('2026-11-19T23:00:00Z'),
        lock: clock(),
        isPaused: () => Promise.resolve(false),
        ...extra,
      },
    );
    return { code, ...r };
  };
  const queue = (dir: string): void =>
    void enqueue(dir, {
      id: 'ob-0001',
      created_at: '2026-11-19T23:00:00.000Z',
      run_id: HOLDER,
      role: 'orchestrator',
      op: 'create',
      database: 'documents',
      properties: { Title: 'Plan', Type: 'PRD', Phase: 1 },
    });

  it('pull and push refuse (exit 11) while a run holds the lock, and work after it ends', async () => {
    const w = await world();
    hold(w.dir);
    queue(w.dir);
    for (const cmd of ['pull', 'push']) {
      const r = await go(w, [cmd]);
      expect(r.code, cmd).toBe(11);
      expect(r.err, cmd).toMatch(/a run holds the lock/);
    }
    expect(readdirSync(outboxDir(w.dir)).filter((f) => f.endsWith('.json'))).toEqual([
      'ob-0001.json',
    ]); // nothing was sent
    expect(w.fake.rowByTitle('Documents', 'Plan')).toBeUndefined();
    releaseRunLock(w.dir, HOLDER);
    expect((await go(w, ['pull'])).code).toBe(0);
    expect((await go(w, ['push'])).code).toBe(0);
    expect(w.fake.rowByTitle('Documents', 'Plan')).toBeDefined();
  });

  it('the run that holds the lock can pull and push through --as-run', async () => {
    const w = await world();
    hold(w.dir);
    queue(w.dir);
    expect((await go(w, ['pull', '--as-run', HOLDER])).code).toBe(0);
    expect((await go(w, ['push', '--as-run', HOLDER])).code).toBe(0);
    expect((await go(w, ['pull', '--as-run', OTHER])).code).toBe(11);
  });

  it('pull ignores the kill switch; push exits 12 while paused and keeps the entry queued', async () => {
    const w = await world();
    queue(w.dir);
    setPauseFile(w.dir, true, 'freeze');
    expect((await go(w, ['pull'], { isPaused: undefined })).code).toBe(0);
    const p = await go(w, ['push'], { isPaused: undefined });
    expect(p.code).toBe(12);
    expect(p.err).toMatch(/ARIMA is paused/);
    expect(readEvents(w.dir).some((e) => e.type === 'hardstop.hit')).toBe(true);
    expect(readdirSync(outboxDir(w.dir)).filter((f) => f.endsWith('.json'))).toEqual([
      'ob-0001.json',
    ]);
    setPauseFile(w.dir, false);
    expect((await go(w, ['push'], { isPaused: undefined })).code).toBe(0);
    expect(w.fake.rowByTitle('Documents', 'Plan')).toBeDefined();
  });

  it('bootstrap and map are not gated (they run before any run exists)', async () => {
    const w = await world();
    hold(w.dir);
    expect((await go(w, ['map', '--root', w.fake.rootId])).code).not.toBe(11);
  });
});

describe('arima-cost --sync and arima-state', () => {
  const costRun = async (dir: string, argv: string[]) => {
    const r = { out: '', err: '' };
    const code = await runCostCli(
      argv,
      { out: (s) => (r.out += s), err: (s) => (r.err += s), cwd: dir },
      { lock: clock() },
    );
    return { code, ...r };
  };
  const setup = async () => {
    const dir = tempDir('arima-lockcost-');
    writeFileSync(path.join(dir, 'arima.yaml'), example('arima.yaml'));
    writeFileSync(path.join(dir, 'team.yaml'), example('team.yaml'));
    await appendEvent(dir, { type: 'run.start', actor: 'orchestrator', run_id: HOLDER });
    await appendLedgerRow(dir, {
      run_id: HOLDER,
      date: '2026-11-19',
      project: 'TAS',
      phase: 4,
      item: 'US-001',
      role: 'developer',
      attempt: 1,
      is_rework: false,
      subtype: 'success',
      num_turns: 1,
      duration_ms: 1000,
      tokens: { input: 1, output: 1, cache_read: 1, cache_creation: 1 },
      cost_usd: 0.5,
      budget_usd: 1,
      result: 'pass',
    });
    return dir;
  };

  it('--sync waits for a live run (exit 11); the plain read-only report does not', async () => {
    const dir = await setup();
    hold(dir);
    expect((await costRun(dir, ['--sync', '--json'])).code).toBe(11);
    expect(readdirSync(path.join(dir, '.arima')).includes('outbox')).toBe(false);
    expect((await costRun(dir, [])).code).toBe(0);
    const own = await costRun(dir, ['--sync', '--json', '--run-id', HOLDER]);
    expect(own.code).toBe(0);
    releaseRunLock(dir, HOLDER);
    expect((await costRun(dir, ['--sync', '--json'])).code).toBe(0);
  });

  it('arima-state pull and push wait for a live run (exit 11); status does not', async () => {
    const dir = tempDir('arima-lockstate-');
    hold(dir);
    const run = async (argv: string[]) => {
      const r = { out: '', err: '' };
      const code = await runStateCli(
        argv,
        { out: (s) => (r.out += s), err: (s) => (r.err += s), cwd: dir },
        { lock: clock() },
      );
      return { code, ...r };
    };
    expect((await run(['pull'])).code).toBe(11);
    expect((await run(['push', '--run-id', OTHER])).code).toBe(11);
    expect((await run(['status'])).code).not.toBe(11);
    // the run that holds the lock saves its own state without waiting (it then fails for want of a repository, not the lock)
    expect((await run(['push', '--run-id', HOLDER])).code).not.toBe(11);
    expect(existsSync(runLockFile(dir))).toBe(true);
  });
});
