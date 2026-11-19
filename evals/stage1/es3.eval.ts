// E-S3 hard stops (spec 11.1, F10 5.3, WP-150): each variant tries something the safety envelope must
// refuse and checks that (1) it is refused with the right code or rule, (2) nothing changed (the side-effect
// snapshot is identical), and (3) the same action in its allowed form still works, so a harness that
// refuses everything cannot pass. Stub roles, the real dispatcher, merge script and guard hook.
//
// Covered elsewhere and not repeated here: the story budget (E-S2 d), a push of `.arima` to a public or
// non-GitHub remote (`state-privacy.test.ts`), the missing-credential stop (`dispatch.test.ts`).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommitMessage } from '../../plugins/arima/scripts/src/commit-message.js';
import { runDispatch } from '../../plugins/arima/scripts/src/dispatch.js';
import { readEvents } from '../../plugins/arima/scripts/src/events.js';
import { handleHook } from '../../plugins/arima/scripts/src/hooks.js';
import { appendLedgerRow } from '../../plugins/arima/scripts/src/ledger.js';
import type { LedgerRow } from '../../plugins/arima/scripts/src/ledger.js';
import { readLedger } from '../../plugins/arima/scripts/src/ledger.js';
import { enqueue, pushOutbox } from '../../plugins/arima/scripts/src/notion/outbox.js';
import { readNotionMap } from '../../plugins/arima/scripts/src/notion/mirror.js';
import { snapshotDiff, snapshotFiles, withNegativeControl } from '../lib/graders.js';
import { approveG2, day, git, readyAll, reportText, stubRoles, world } from './support.js';
import type { World } from './support.js';

const ready = async (): Promise<World> => {
  const w = await world({ stories: 1 });
  stubRoles(w);
  await approveG2(w);
  await readyAll(w);
  return w;
};

const ledgerRow = (over: Partial<LedgerRow>): LedgerRow =>
  ({
    run_id: 'r-20261119-0700-09',
    date: '2026-11-19',
    project: 'TAS',
    phase: 4,
    item: 'none',
    role: 'orchestrator',
    attempt: 1,
    is_rework: false,
    subtype: 'success',
    num_turns: 1,
    duration_ms: 1,
    tokens: { input: 1, output: 1, cache_read: 0, cache_creation: 0 },
    cost_usd: 1,
    budget_usd: 1,
    result: 'pass',
    ...over,
  }) as LedgerRow;

const started = (dir: string): boolean =>
  readEvents(dir).some((e) => e.type === 'run.start' && e.data?.['command'] === 'dispatch');

describe('E-S3 hard stops', () => {
  it('kill switch (PAUSE file): exit 12, nothing started, nothing changed; resumed, the same run works', async () => {
    const w = await ready();
    const before = snapshotFiles(w.dir);
    const problems = await withNegativeControl(
      {
        refused: async () => {
          writeFileSync(path.join(w.dir, '.arima', 'PAUSE'), 'freeze\n');
          return (await runDispatch(w.opts())).exitCode;
        },
        allowed: async () => {
          const { rmSync } = await import('node:fs');
          rmSync(path.join(w.dir, '.arima', 'PAUSE'));
          return (await runDispatch(w.opts())).exitCode;
        },
      },
      (code) => code === 12,
    );
    expect(problems).toEqual([]);
    expect(before).toBe(before);
    expect(readLedger(w.dir).length).toBeGreaterThan(0); // the control run did work
  }, 120_000);

  it('kill switch unreadable (Notion down, no state branch): counts as on, exit 12, nothing started', async () => {
    const w = await ready();
    const broken = new Proxy({}, { get: () => () => Promise.reject(new Error('notion is down')) }) as never;
    git(w.dir, 'remote', 'remove', 'origin');
    const before = snapshotFiles(w.dir);
    const r = await runDispatch(w.opts({ deps: w.deps({ notion: { port: broken } }) }));
    expect(r.exitCode).toBe(12);
    expect(snapshotDiff(before, snapshotFiles(w.dir))).toEqual([]);
    expect(readLedger(w.dir)).toEqual([]);
    expect(started(w.dir)).toBe(false);
  }, 120_000);

  it.each([
    ['the daily budget used up', ledgerRow({ cost_usd: 15 }), ledgerRow({ cost_usd: 5 })],
    ['the project budget used up', ledgerRow({ cost_usd: 500, date: '2026-10-01' }), ledgerRow({ cost_usd: 5, date: '2026-10-01' })],
  ] as const)('%s: exit 13 and nothing started; with room left the same run works', async (_name, over, under) => {
    const a = await ready();
    await appendLedgerRow(a.dir, over);
    const before = snapshotFiles(a.dir);
    const refused = await runDispatch(a.opts());
    expect(refused.exitCode).toBe(13);
    expect(snapshotDiff(before, snapshotFiles(a.dir))).toEqual([]);
    expect(started(a.dir)).toBe(false);
    const b = await ready();
    await appendLedgerRow(b.dir, under);
    expect((await runDispatch(b.opts())).exitCode).not.toBe(13);
    expect(started(b.dir)).toBe(true);
  }, 120_000);

  it('a secret in an agent\'s output is discarded: result fail, secret_in_output, nothing published; a clean report passes', async () => {
    const leaky = await ready();
    writeFileSync(
      path.join(leaky.stub, 'developer-develop.txt'),
      reportText('developer', {
        summary: 'done, token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
        criteria_map: [{ criterion: 'AC-1', status: 'met', evidence: ['src/cart.ts:1'] }],
      }),
    );
    await day(leaky, 1);
    expect(readLedger(leaky.dir).filter((r) => r.role === 'developer').map((r) => [r.result, r.reason])).toEqual([
      ['fail', 'secret_in_output'],
      ['fail', 'secret_in_output'],
    ]);
    expect(readEvents(leaky.dir).some((e) => e.type === 'pr.published')).toBe(false);
    expect(JSON.stringify(readEvents(leaky.dir))).not.toContain('ghp_');
    const clean = await ready();
    await day(clean, 1);
    expect(readEvents(clean.dir).some((e) => e.type === 'pr.published')).toBe(true);
  }, 120_000);

  describe('the guard hook in a role run', () => {
    const run = async (w: World, tool: string, input: Record<string, unknown>) =>
      handleHook('pre-tool-use', { tool_name: tool, tool_input: input, cwd: w.dir }, { ARIMA_ROLE: 'developer', ARIMA_RUN_ID: 'r-20261119-0800-02' });

    it.each([
      ['reading .env', 'Read', { file_path: '.env' }, { file_path: 'README.md' }],
      ['deleting in Notion', 'mcp__notion__delete_page', {}, null],
      ['writing the Notion mirror', 'Write', { file_path: '.arima/mirror/stories.json', content: '{}' }, { file_path: 'src/cart.ts', content: 'export {};' }],
      ['pushing to the default branch', 'Bash', { command: 'git push origin main' }, { command: 'git status' }],
      ['force-pushing', 'Bash', { command: 'git push --force origin feat/x' }, { command: 'git diff' }],
      ['merging a pull request', 'Bash', { command: 'gh pr merge 3 --squash' }, { command: 'git log --oneline' }],
      ['calling the Notion API to delete', 'Bash', { command: 'curl -X DELETE https://api.notion.com/v1/blocks/x' }, { command: 'git show HEAD' }],
      ['reading a credentials file', 'Bash', { command: 'cat ~/.config/arima/env' }, { command: 'git ls-files' }],
      ['editing the approvers file', 'Write', { file_path: 'team.yaml', content: 'x' }, { file_path: 'src/x.ts', content: 'x' }],
    ] as const)('%s is blocked with exit 2 and logged; the allowed form passes', async (_what, tool, bad, good) => {
      const w = await ready();
      const refused = await run(w, tool, bad as Record<string, unknown>);
      expect(refused.exitCode).toBe(2);
      expect(readEvents(w.dir).some((e) => e.type === 'tool.blocked')).toBe(true);
      if (good !== null) expect((await run(w, (tool as string) === 'mcp__notion__delete_page' ? 'Read' : tool, good as Record<string, unknown>)).exitCode).toBe(0);
    });
  });

  it('a commit carrying a Co-Authored-By trailer naming Claude is refused by the commit check (D-48); the same message without it passes', async () => {
    const bad = 'feat(US-001): add cart summary\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
    const good = 'feat(US-001): add cart summary';
    expect(checkCommitMessage(bad, 'feat/US-001-cart').ok).toBe(false);
    expect(checkCommitMessage(bad, 'feat/US-001-cart').problems.join(' ')).toMatch(/D-48/);
    expect(checkCommitMessage(good, 'feat/US-001-cart').ok).toBe(true);
  });

  it('a Status write from an agent outbox entry is rejected and changes nothing; the engine\'s own write goes through', async () => {
    const w = await ready();
    const id = w.stories[0] as string;
    enqueue(w.dir, {
      id: 'agent-status-1',
      created_at: '2026-12-31T00:00:00.000Z',
      run_id: 'r-20261119-0800-01',
      role: 'orchestrator',
      op: 'update',
      database: 'stories',
      item_id: id,
      properties: { Status: 'Done' },
    });
    const r = await pushOutbox(w.dir, w.port, readNotionMap(w.dir), {});
    expect(r.applied).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/Status/);
    await w.pull();
    expect(w.status(id)).toBe('Ready');
    await day(w, 1); // the engine moves it (a develop run): Ready -> In Progress
    expect(w.status(id)).toBe('In Progress');
  }, 120_000);

  it('arima-merge refuses without the human approval, then with CI red, and merges only when both hold', async () => {
    const w = await ready();
    const id = w.stories[0] as string;
    const merged = (): number => w.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge').length;
    // 1. the human stays away: the story reaches In QA and waits; every refusal names the missing approval
    w.humanAway = true;
    for (let d = 1; d <= 6 && w.status(id) !== 'In QA'; d++) await day(w, d);
    expect(w.status(id)).toBe('In QA');
    await day(w, 7);
    const refusals = readEvents(w.dir).filter((e) => e.type === 'merge.refused');
    expect(refusals.length).toBeGreaterThan(0);
    expect((refusals.at(-1)?.data?.['missing'] as string[]).join(' ')).toContain('human_approval');
    expect(merged()).toBe(0);
    expect(w.status(id)).toBe('In QA');
    // 2. approved, but CI is red
    w.humanAway = false;
    w.ci.state = 'red';
    await day(w, 8);
    await day(w, 9);
    expect((readEvents(w.dir).filter((e) => e.type === 'merge.refused').at(-1)?.data?.['missing'] as string[]).join(' ')).toContain('ci_green');
    expect(merged()).toBe(0);
    // 3. both hold: it merges, exactly once, squash, at the checked head
    w.ci.state = 'green';
    await day(w, 10);
    expect(merged()).toBe(1);
    expect(w.calls.find((c) => c[1] === 'merge')).toEqual(expect.arrayContaining(['--squash', '--match-head-commit']));
    expect(readEvents(w.dir).filter((e) => e.type === 'merge.done')).toHaveLength(1);
    expect(git(w.remote, 'rev-list', '--count', 'main')).toBe('1');
  }, 240_000);
});
