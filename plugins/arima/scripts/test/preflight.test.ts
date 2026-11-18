import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newBudgetAlerts, budgetStatus } from '../src/budget.js';
import { runPreflightCli } from '../src/cli/preflight-cli.js';
import { readEvents } from '../src/events.js';
import { checkKillSwitch, setNotionSwitch, setPauseFile } from '../src/killswitch.js';
import { appendLedgerRow } from '../src/ledger.js';
import type { LedgerRow } from '../src/ledger.js';
import { Throttle } from '../src/lib/throttle.js';
import { PAUSE_TODO_TEXT, createNotionPort } from '../src/notion/port.js';
import type { NotionClientLike, NotionPort, TodoBlock } from '../src/notion/port.js';
import { PREFLIGHT_EXIT, runPreflight } from '../src/preflight.js';
import { acquireRunLock, lockStatus, releaseRunLock, runLockFile } from '../src/runlock.js';
import { project, tempDir } from './helpers.js';

const NOW = new Date(2026, 10, 17, 2, 0);
const TODAY = '2026-11-17';
const GOOD_ENV = { ARIMA_NOTION_TOKEN: 'x', ARIMA_GITHUB_TOKEN: 'y' };

class FakeNotion implements NotionPort {
  todos: TodoBlock[] = [{ id: 'b1', text: PAUSE_TODO_TEXT, checked: false }];
  fail = false;
  calls = 0;
  listTodoBlocks(): Promise<TodoBlock[]> {
    this.calls++;
    if (this.fail) return Promise.reject(new Error('ENOTFOUND api.notion.com'));
    return Promise.resolve(this.todos.map((t) => ({ ...t })));
  }
  setTodoChecked(id: string, checked: boolean): Promise<void> {
    const t = this.todos.find((x) => x.id === id);
    if (t) t.checked = checked;
    return Promise.resolve();
  }
  appendTodo(_page: string, text: string, checked: boolean): Promise<string> {
    this.todos.push({ id: `b${this.todos.length + 1}`, text, checked });
    return Promise.resolve(`b${this.todos.length}`);
  }
}

const row = (cost: number, date = TODAY, n = 1): LedgerRow => ({
  run_id: `r-${date.replace(/-/g, '')}-0200-${String(n).padStart(2, '0')}`,
  date,
  project: 'TAS',
  phase: 4,
  item: 'US-1',
  role: 'developer',
  attempt: 1,
  is_rework: false,
  subtype: 'success',
  num_turns: 1,
  duration_ms: 1,
  tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
  cost_usd: cost,
  budget_usd: 2,
  result: 'pass',
});

const pre = (
  dir: string,
  over: Parameters<typeof runPreflight>[0] extends infer T ? Partial<T> : never = {},
) => runPreflight({ projectDir: dir, env: GOOD_ENV, notion: new FakeNotion(), now: NOW, ...over });

describe('preflight: all conditions', () => {
  it('passes on a healthy project', async () => {
    const dir = project();
    const r = await pre(dir);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.checks.map((c) => c.check)).toEqual([
      'config',
      'kill_switch',
      'run_lock',
      'budget',
      'env',
    ]);
    expect(readEvents(dir)).toEqual([]);
  });

  it('config invalid -> exit 10 and a preflight.fail event', async () => {
    const dir = project({ team: [['count: 3', 'count: 9']] });
    const r = await pre(dir);
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.config);
    expect(readEvents(dir).map((e) => e.data)).toContainEqual(
      expect.objectContaining({ check: 'config' }),
    );
  });

  it('PAUSE file -> exit 12 and an event', async () => {
    const dir = project();
    setPauseFile(dir, true, 'holiday freeze');
    const r = await pre(dir);
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.killSwitch);
    expect(r.checks.find((c) => c.check === 'kill_switch')?.detail).toContain('holiday freeze');
    expect(readEvents(dir)[0]).toMatchObject({
      type: 'preflight.fail',
      data: { check: 'kill_switch' },
    });
  });

  it('Notion switch on -> exit 12', async () => {
    const dir = project();
    const n = new FakeNotion();
    n.todos[0]!.checked = true;
    const r = await pre(dir, { notion: n });
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.killSwitch);
  });

  it('Notion unreachable: the PAUSE file decides; absent file passes with a warning', async () => {
    const dir = project();
    const n = new FakeNotion();
    n.fail = true;
    const ok = await pre(dir, { notion: n });
    expect(ok.ok).toBe(true);
    expect(ok.checks.find((c) => c.check === 'kill_switch')?.warning).toMatch(/unreachable/);
    setPauseFile(dir, true);
    expect((await pre(dir, { notion: n })).exitCode).toBe(PREFLIGHT_EXIT.killSwitch);
  });

  it('kill switch is checked even when the config is invalid (the file needs no config)', async () => {
    const dir = project({ team: [['count: 3', 'count: 9']] });
    setPauseFile(dir, true);
    const r = await pre(dir);
    expect(r.checks.find((c) => c.check === 'kill_switch')?.ok).toBe(false);
  });

  it('another live run holds the lock -> exit 11', async () => {
    const dir = project();
    expect(acquireRunLock(dir, 'r-20261117-0100-01', 600_000)).toBe(true);
    const r = await pre(dir);
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.locked);
    expect(r.checks.find((c) => c.check === 'run_lock')?.detail).toContain('r-20261117-0100-01');
  });

  it('a stale lock (dead process) does not block', async () => {
    const dir = project();
    mkdirSync(path.dirname(runLockFile(dir)), { recursive: true });
    writeFileSync(
      runLockFile(dir),
      JSON.stringify({
        pid: 2_000_000_000,
        run_id: 'r-20261116-0200-01',
        host: hostname(),
        started_at: NOW.toISOString(),
      }),
    );
    const r = await pre(dir);
    expect(r.ok).toBe(true);
  });

  it('a lock older than max_run_minutes + slack is stale even from another host', () => {
    const dir = project();
    mkdirSync(path.dirname(runLockFile(dir)), { recursive: true });
    writeFileSync(
      runLockFile(dir),
      JSON.stringify({
        pid: 1,
        run_id: 'r-1',
        host: 'other-host',
        started_at: new Date(NOW.getTime() - 10 * 3600_000).toISOString(),
      }),
    );
    expect(lockStatus(dir, 270 * 60_000, NOW.getTime())).toMatchObject({
      held: false,
      stale: true,
    });
  });

  it('daily budget exhausted -> exit 13', async () => {
    const dir = project();
    await appendLedgerRow(dir, row(15));
    const r = await pre(dir);
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.budget);
    expect(r.checks.find((c) => c.check === 'budget')?.detail).toContain('daily');
  });

  it('project budget exhausted -> exit 13 even if today is quiet', async () => {
    const dir = project();
    for (let i = 0; i < 34; i++)
      await appendLedgerRow(
        dir,
        row(15, `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, i + 1),
      );
    const r = await pre(dir);
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.budget);
    expect(r.checks.find((c) => c.check === 'budget')?.detail).toContain('project');
  });

  it('missing environment variables -> exit 14, naming only the variable names', async () => {
    const dir = project();
    const r = await pre(dir, { env: { ARIMA_GITHUB_TOKEN: 'secret-value-123' } });
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.env);
    const detail = r.checks.find((c) => c.check === 'env')?.detail ?? '';
    expect(detail).toContain('ARIMA_NOTION_TOKEN');
    expect(detail).not.toContain('secret-value-123');
    expect(JSON.stringify(readEvents(dir))).not.toContain('secret-value-123');
  });

  it('reports the first failure in a fixed order when several fail', async () => {
    const dir = project();
    setPauseFile(dir, true);
    await appendLedgerRow(dir, row(15));
    const r = await pre(dir, { env: {} });
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.killSwitch);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.check)).toEqual([
      'kill_switch',
      'budget',
      'env',
    ]);
    expect(readEvents(dir).filter((e) => e.type === 'preflight.fail')).toHaveLength(3);
  });

  it('each failing condition has a distinct exit code', () => {
    const codes = Object.values(PREFLIGHT_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('run lock', () => {
  it('acquires once, refuses a second live acquirer, and releases only for its owner', () => {
    const dir = tempDir();
    expect(acquireRunLock(dir, 'r-A', 600_000)).toBe(true);
    expect(acquireRunLock(dir, 'r-B', 600_000)).toBe(false);
    expect(releaseRunLock(dir, 'r-B')).toBe(false);
    expect(existsSync(runLockFile(dir))).toBe(true);
    expect(releaseRunLock(dir, 'r-A')).toBe(true);
    expect(acquireRunLock(dir, 'r-B', 600_000)).toBe(true);
  });

  it('--acquire takes the lock after all checks pass, and a second preflight then fails', async () => {
    const dir = project();
    const first = await pre(dir, { acquireFor: 'r-20261117-0200-01' });
    expect(first).toMatchObject({ ok: true, acquired: true });
    expect((await pre(dir)).exitCode).toBe(PREFLIGHT_EXIT.locked);
  });

  it('does not take the lock when a check failed', async () => {
    const dir = project();
    setPauseFile(dir, true);
    const r = await pre(dir, { acquireFor: 'r-1' });
    expect(r.acquired).toBe(false);
    expect(existsSync(runLockFile(dir))).toBe(false);
  });
});

describe('budget', () => {
  const limits = { projectCap: 100, dailyCap: 10, alertThresholds: [0.5, 0.8, 1] };

  it('sums the project and the day separately', async () => {
    const dir = tempDir();
    await appendLedgerRow(dir, row(4, '2026-11-16', 1));
    await appendLedgerRow(dir, row(3, TODAY, 2));
    expect(budgetStatus(dir, limits, TODAY)).toMatchObject({
      projectSpent: 7,
      daySpent: 3,
      ok: true,
    });
  });

  it('raises each threshold alert once, daily ones once per day', () => {
    const status = {
      projectSpent: 60,
      projectCap: 100,
      daySpent: 9,
      dailyCap: 10,
      ok: true,
      exhausted: [],
    };
    const first = newBudgetAlerts(status, limits.alertThresholds, [], TODAY);
    expect(first.map((a) => `${a.scope}@${a.threshold}`).sort()).toEqual([
      'daily@0.5',
      'daily@0.8',
      'project@0.5',
    ]);
    const logged = first.map((a) => ({
      ts: 't',
      type: 'budget.alert' as const,
      actor: 'system',
      data: { scope: a.scope, threshold: a.threshold, date: TODAY },
    }));
    expect(newBudgetAlerts(status, limits.alertThresholds, logged, TODAY)).toEqual([]);
    expect(
      newBudgetAlerts(status, limits.alertThresholds, logged, '2026-11-18').map((a) => a.scope),
    ).toEqual(['daily', 'daily']);
  });

  it('preflight logs a budget.alert event once', async () => {
    const dir = project();
    await appendLedgerRow(dir, row(13));
    await pre(dir);
    await pre(dir);
    const alerts = readEvents(dir).filter((e) => e.type === 'budget.alert');
    expect(alerts.map((e) => (e.data as { threshold: number }).threshold)).toEqual([0.5, 0.8]);
  });
});

describe('kill switch helpers', () => {
  it('reads and toggles the Notion to-do without ever deleting', async () => {
    const n = new FakeNotion();
    await setNotionSwitch(n, 'root', true);
    expect((await checkKillSwitch(tempDir(), { port: n, rootPageId: 'root' })).on).toBe(true);
    await setNotionSwitch(n, 'root', false);
    expect(n.todos[0]?.checked).toBe(false);
  });

  it('creates the to-do on first use', async () => {
    const n = new FakeNotion();
    n.todos = [];
    await setNotionSwitch(n, 'root', true);
    expect(n.todos).toEqual([{ id: 'b1', text: PAUSE_TODO_TEXT, checked: true }]);
  });

  it('reports a missing switch without pausing', async () => {
    const n = new FakeNotion();
    n.todos = [];
    const s = await checkKillSwitch(tempDir(), { port: n, rootPageId: 'root' });
    expect(s).toMatchObject({ on: false, notion: 'missing' });
  });
});

describe('Notion port (mocked SDK client)', () => {
  const makeClient = (
    pages: { results: unknown[]; has_more: boolean; next_cursor: string | null }[],
  ) => {
    const calls: unknown[] = [];
    const client: NotionClientLike = {
      blocks: {
        children: {
          list: (args) => {
            calls.push(args);
            return Promise.resolve(pages[calls.length - 1] as (typeof pages)[number]);
          },
          append: (args) => {
            calls.push(args);
            return Promise.resolve({ results: [{ id: 'new-block' }] });
          },
        },
        update: (args) => {
          calls.push(args);
          return Promise.resolve({});
        },
      },
    };
    return { client, calls };
  };
  const fastThrottle = new Throttle(0);

  it('paginates and keeps only to-do blocks', async () => {
    const { client, calls } = makeClient([
      {
        results: [
          { id: 'a', type: 'paragraph' },
          {
            id: 'b',
            type: 'to_do',
            to_do: {
              rich_text: [{ plain_text: 'Pause ' }, { plain_text: 'ARIMA' }],
              checked: true,
            },
          },
        ],
        has_more: true,
        next_cursor: 'c2',
      },
      {
        results: [{ id: 'c', type: 'to_do', to_do: { rich_text: [], checked: false } }],
        has_more: false,
        next_cursor: null,
      },
    ]);
    const todos = await createNotionPort(client, fastThrottle).listTodoBlocks('root');
    expect(todos).toEqual([
      { id: 'b', text: 'Pause ARIMA', checked: true },
      { id: 'c', text: '', checked: false },
    ]);
    expect((calls[1] as { start_cursor: string }).start_cursor).toBe('c2');
  });

  it('updates and appends through the SDK, and exposes no delete', async () => {
    const { client, calls } = makeClient([]);
    const port = createNotionPort(client, fastThrottle);
    await port.setTodoChecked('b', true);
    expect(await port.appendTodo('root', 'Pause ARIMA', false)).toBe('new-block');
    expect(calls[0]).toEqual({ block_id: 'b', to_do: { checked: true } });
    expect(Object.keys(port).some((k) => /delete|archive|remove/i.test(k))).toBe(false);
  });
});

describe('Throttle', () => {
  it('spaces calls at least the interval apart', async () => {
    let t = 0;
    const waits: number[] = [];
    const throttle = new Throttle(
      334,
      () => t,
      (ms) => {
        waits.push(ms);
        t += ms;
        return Promise.resolve();
      },
    );
    for (let i = 0; i < 4; i++) await throttle.run(() => Promise.resolve());
    expect(waits).toEqual([334, 334, 334]);
  });
});

describe('arima-preflight CLI', () => {
  const cli = async (
    argv: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = GOOD_ENV,
    notion: NotionPort = new FakeNotion(),
  ) => {
    let out = '';
    let err = '';
    const code = await runPreflightCli(
      argv,
      { out: (s) => (out += s), err: (s) => (err += s), cwd },
      { env, notionFactory: () => notion },
    );
    return { code, out, err };
  };

  it('prints PASS lines and exits 0', async () => {
    const r = await cli(['check'], project());
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS kill_switch');
    expect(r.out).toContain('preflight ok');
  });

  it('exits with the failing check code', async () => {
    const dir = project();
    setPauseFile(dir, true);
    expect((await cli([], dir)).code).toBe(12);
    expect((await cli([], project(), {})).code).toBe(14);
  });

  it('--acquire then release frees the lock', async () => {
    const dir = project();
    expect((await cli(['--acquire', 'r-1'], dir)).code).toBe(0);
    expect((await cli([], dir)).code).toBe(11);
    await cli(['release', '--run-id', 'r-1'], dir);
    expect((await cli([], dir)).code).toBe(0);
  });

  it('supports --json and rejects bad usage', async () => {
    const r = await cli(['--json'], project());
    expect((JSON.parse(r.out) as { ok: boolean }).ok).toBe(true);
    expect((await cli(['--nope'], tempDir())).code).toBe(2);
    expect((await cli(['release'], tempDir())).code).toBe(2);
  });
});
