// WP-105: story budget and the run-cap rule (spec 13.5, 7.1; hard stop story_budget).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/cli/run-agent-cli.js';
import { readEvents } from '../src/events.js';
import { appendLedgerRow, buildLedgerRow } from '../src/ledger.js';
import type { Role } from '../src/ledger.js';
import {
  RUN_COST_FLOOR_USD,
  itemSpent,
  recordStoryBudgetHit,
  storyBudget,
  storyBudgetFromMirror,
  unitBudget,
} from '../src/story-budget.js';
import { DispatchRefused, runAgent, runUnit } from '../src/run-agent.js';
import type { AgentConfig, RunAgentOptions } from '../src/run-agent.js';
import { project, tempDir } from './helpers.js';

const STUB = path.join(import.meta.dirname, 'fixtures', 'stub-claude.mjs');
const CFG = { perStoryDefault: 2, bySize: { S: 1, M: 3, L: 6 }, perRunCap: 2 };

let runSeq = 0;

async function spend(
  dir: string,
  item: string,
  usd: number,
  n = 1,
  role: Role = 'developer',
): Promise<void> {
  for (let i = 0; i < n; i++)
    await appendLedgerRow(
      dir,
      buildLedgerRow(
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          total_cost_usd: usd,
          duration_ms: 1,
          num_turns: 1,
        },
        {
          run_id: `r-20261119-1000-${String(++runSeq).padStart(2, '0')}`,
          date: '2026-11-19',
          project: 'TAS',
          phase: 4,
          item,
          role,
          attempt: 1,
          is_rework: false,
          budget_usd: 2,
        },
      ),
    );
}

describe('storyBudget', () => {
  it('uses the Budget USD on the row, else the size default, else the project default', () => {
    expect(storyBudget(CFG, { budget: 4.5, size: 'S' })).toBe(4.5);
    expect(storyBudget(CFG, { size: 'S' })).toBe(1);
    expect(storyBudget(CFG, { size: 'M' })).toBe(3);
    expect(storyBudget(CFG, { size: 'L' })).toBe(6);
    expect(storyBudget(CFG, {})).toBe(2);
    expect(storyBudget(CFG, { size: 'XL' })).toBe(2);
    expect(storyBudget(CFG, { budget: 0, size: 'M' })).toBe(3);
    expect(storyBudget({ perStoryDefault: 2 }, { size: 'L' })).toBe(2);
  });

  it('reads Budget USD and Complexity from the stories mirror', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.arima', 'mirror'), { recursive: true });
    writeFileSync(
      path.join(dir, '.arima', 'mirror', 'stories.json'),
      JSON.stringify({
        database: 'stories',
        rows: [
          {
            page_id: 'p1',
            last_edited_time: 't',
            id: 'US-001',
            properties: { 'Budget USD': 5, Complexity: 'S' },
          },
          { page_id: 'p2', last_edited_time: 't', id: 'US-002', properties: { Complexity: 'L' } },
          { page_id: 'p3', last_edited_time: 't', id: 'US-003', properties: {} },
        ],
      }),
    );
    expect(storyBudgetFromMirror(dir, 'US-001', CFG)).toBe(5);
    expect(storyBudgetFromMirror(dir, 'US-002', CFG)).toBe(6);
    expect(storyBudgetFromMirror(dir, 'US-003', CFG)).toBe(2);
    expect(storyBudgetFromMirror(dir, 'US-404', CFG)).toBe(2);
    expect(storyBudgetFromMirror(tempDir(), 'US-001', CFG)).toBe(2);
  });
});

describe('unitBudget: cap = min(per_run_cap, remaining story budget)', () => {
  it('a fresh story gets the per-run cap when the story budget is larger', async () => {
    const dir = tempDir();
    expect(unitBudget(dir, 'US-001', 6, 2)).toMatchObject({
      ok: true,
      budgetUsd: 2,
      spent: 0,
      remaining: 6,
    });
  });

  it('the cap shrinks to what is left, counting every run of the item (rework included)', async () => {
    const dir = tempDir();
    await spend(dir, 'US-001', 0.7, 2);
    await spend(dir, 'US-002', 5); // another item does not count
    expect(itemSpent(dir, 'US-001')).toBe(1.4);
    expect(unitBudget(dir, 'US-001', 3, 2)).toMatchObject({
      ok: true,
      budgetUsd: 1.6,
      remaining: 1.6,
    });
  });

  it('a story with less than the cost floor left, or nothing, gets no run', async () => {
    const dir = tempDir();
    await spend(dir, 'US-001', 0.85);
    const near = unitBudget(dir, 'US-001', 1, 2);
    expect(near).toMatchObject({ ok: false, reason: 'story_budget', remaining: 0.15 });
    expect(RUN_COST_FLOOR_USD).toBe(0.25);
    await spend(dir, 'US-001', 0.5);
    expect(unitBudget(dir, 'US-001', 1, 2)).toMatchObject({ ok: false, remaining: 0 });
    // exactly the floor is enough
    const d2 = tempDir();
    await spend(d2, 'US-009', 0.75);
    expect(unitBudget(d2, 'US-009', 1, 2)).toMatchObject({ ok: true, budgetUsd: 0.25 });
  });
});

describe('the hard stop story_budget blocks dispatch with hardstop.hit', () => {
  const config = (): AgentConfig => ({
    projectKey: 'TAS',
    perRunCap: 2,
    maxRunMinutes: 1,
    notionTokenEnv: 'ARIMA_NOTION_TOKEN',
    projectCap: 100,
    dailyCap: 20,
  });
  const opts = (dir: string, over: Partial<RunAgentOptions> = {}): RunAgentOptions => {
    const prompt = path.join(dir, 'prompt.md');
    writeFileSync(prompt, 'Do it.');
    return {
      projectDir: dir,
      role: 'developer',
      item: 'US-112',
      budgetUsd: 1,
      maxTurns: 5,
      promptFile: prompt,
      phase: 4,
      config: config(),
      killSwitch: { notion: null },
      claudeBin: STUB,
      env: { ...process.env },
      extraEnv: { STUB_MODE: 'success' },
      now: new Date(2026, 10, 19, 10, 0),
      ...over,
    };
  };

  it('refuses to start a run when the story budget is used up, records hardstop.hit, writes no ledger row', async () => {
    const dir = tempDir();
    await spend(dir, 'US-112', 1);
    const before = readEvents(dir).length;
    let err: unknown;
    await runAgent(opts(dir, { storyBudgetUsd: 1 })).catch((e: unknown) => (err = e));
    expect(err).toBeInstanceOf(DispatchRefused);
    expect((err as DispatchRefused).exitCode).toBe(13);
    const hit = readEvents(dir).slice(before);
    expect(hit.map((e) => e.type)).toEqual(['hardstop.hit']);
    expect(hit[0]).toMatchObject({
      item: 'US-112',
      data: { stop: 'story_budget', spent: 1, budget: 1, remaining: 0 },
    });
    expect(itemSpent(dir, 'US-112')).toBe(1); // nothing was spent
  });

  it('refuses a run whose cap is more than what is left of the story budget', async () => {
    const dir = tempDir();
    await spend(dir, 'US-112', 0.5);
    await expect(runAgent(opts(dir, { storyBudgetUsd: 1, budgetUsd: 1 }))).rejects.toThrow(
      /more than the 0.5 est. USD left/,
    );
    expect(readEvents(dir).filter((e) => e.type === 'hardstop.hit')).toHaveLength(1);
  });

  it('starts a run whose cap fits, and other items are unaffected', async () => {
    const dir = tempDir();
    await spend(dir, 'US-999', 5);
    const o = await runAgent(opts(dir, { storyBudgetUsd: 1, budgetUsd: 1 }));
    expect(o.result).toBe('pass');
    // without a story budget nothing changes (old behaviour)
    expect((await runAgent(opts(dir))).result).toBe('pass');
  });

  it('an item of "none" has no story budget', async () => {
    const dir = tempDir();
    expect((await runAgent(opts(dir, { item: 'none', storyBudgetUsd: 1 }))).result).toBe('pass');
  });

  it('runUnit does not retry into a spent story: blocked with story_budget, no exception', async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, 'seq.json'),
      JSON.stringify([{ message: 'no report', cost: 0.8 }]),
    );
    const u = await runUnit({
      ...opts(dir, {
        kind: 'develop',
        storyBudgetUsd: 1,
        budgetUsd: 1,
        extraEnv: {
          STUB_MODE: 'sequence',
          STUB_SEQ_FILE: path.join(dir, 'seq.json'),
          STUB_SEQ_COUNTER: path.join(dir, 'n'),
        },
      }),
      kind: 'develop',
    });
    expect(u.blocked).toBe(true);
    expect(u.reason).toBe('story_budget');
    expect(u.runs).toHaveLength(1);
  });

  it('recordStoryBudgetHit words the stop with cost and the floor', async () => {
    const dir = tempDir();
    const msg = await recordStoryBudgetHit(
      dir,
      'US-1',
      { ok: false, reason: 'story_budget', spent: 3, remaining: 0, storyBudget: 3 },
      'developer',
    );
    expect(msg).toMatch(/spent 3 of 3 est\. USD.*at least 0\.25/);
    expect(readEvents(dir)[0]).toMatchObject({
      type: 'hardstop.hit',
      data: { stop: 'story_budget', role: 'developer' },
    });
  });
});

describe('arima-run-agent --story-budget', () => {
  it('exits 13 when the story budget is used up, and rejects a bad value with exit 2', async () => {
    const w = project();
    const dir = typeof w === 'string' ? w : (w as { dir: string }).dir;
    await spend(dir, 'US-112', 2);
    writeFileSync(path.join(dir, 'p.md'), 'x');
    const run = async (extra: string[]): Promise<{ code: number; err: string }> => {
      let err = '';
      const code = await runAgentCli(
        [
          '--role',
          'developer',
          '--item',
          'US-112',
          '--budget',
          '1',
          '--max-turns',
          '5',
          '--prompt-file',
          'p.md',
          '--project',
          dir,
          ...extra,
        ],
        { out: () => undefined, err: (s) => (err += s), cwd: dir },
        { env: { ...process.env } },
      );
      return { code, err };
    };
    expect((await run(['--story-budget', '2'])).code).toBe(13);
    expect((await run(['--story-budget', '0'])).code).toBe(2);
    expect((await run(['--story-budget', 'abc'])).err).toMatch(
      /--story-budget must be a positive number/,
    );
  });
});
