// E-S1 (spec 15.4, F10 5.3, WP-121): five stories walk Backlog to Done with stub roles, through the real
// dispatcher, state machine, report collector, outbox, publish and merge scripts, over a local bare
// remote, a fake `gh` and a fake Notion. A stub that emits invalid output fails its run.
//
// Not covered yet, said plainly: a UI story with design screens (the queue plans no `design-qa`
// unit until the ux agent, WP-311).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDispatch } from '../../plugins/arima/scripts/src/dispatch.js';
import type { DispatchResult } from '../../plugins/arima/scripts/src/dispatch.js';
import { readEvents } from '../../plugins/arima/scripts/src/events.js';
import { readLedger } from '../../plugins/arima/scripts/src/ledger.js';
import { readMirror } from '../../plugins/arima/scripts/src/notion/mirror.js';
import { enqueue, pushOutbox } from '../../plugins/arima/scripts/src/notion/outbox.js';
import { readNotionMap } from '../../plugins/arima/scripts/src/notion/mirror.js';
import { itemSpent } from '../../plugins/arima/scripts/src/story-budget.js';
import { DAY, BASE, approveG2, day, git, readyAll, reportText, stubRoles, world } from './support.js';
import { ledgerRows, noDuplicateRows, stateTrace } from '../lib/graders.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('E-S1: five stories Backlog to Done with stub agents', () => {
  it('walks every story along legal edges only, with the ledger, cost, outbox, git and idempotence graders', async () => {
    const w = await world();
    stubRoles(w);

    // Negative control (D-46): before the Phase 3 exit (G2 not approved) the run is refused, exit 5, nothing started.
    const refused = await runDispatch(w.opts());
    expect(refused.exitCode).toBe(5);
    expect(readEvents(w.dir).some((e) => e.type === 'run.start' && e.data?.['command'] === 'dispatch')).toBe(false);
    await approveG2(w);
    await readyAll(w);

    const results: DispatchResult[] = [];
    let days = 0;
    while (days < 40 && !w.stories.every((id) => w.status(id) === 'Done')) {
      days += 1;
      results.push(await day(w, days));
    }

    // ---- state trace: every story Done, along the legal path, every edge legal for its actor
    for (const id of w.stories) expect(w.status(id), id).toBe('Done');
    const events = readEvents(w.dir);
    for (const id of w.stories)
      expect(
        stateTrace(events, id, ['Ready', 'In Progress', 'In Review', 'In QA', 'PO Acceptance', 'Done']),
        id,
      ).toEqual([]);

    // ---- ledger: one row per run, per-story cost equals the ledger sum and the Cost log in Notion
    const ledger = readLedger(w.dir);
    const dispatched = results.flatMap((r) => r.dispatched).filter((d) => d.result !== 'skipped');
    expect(ledgerRows(ledger, dispatched.length)).toEqual([]);
    const roles = ledger.map((r) => r.role);
    for (const role of ['developer', 'tech-lead', 'qa']) expect(roles.filter((x) => x === role)).toHaveLength(5);
    await w.push();
    await w.pull();
    const costLog = readMirror(w.dir, 'cost_log')?.rows ?? [];
    for (const id of w.stories) {
      const sum = ledger.filter((r) => r.item === id).reduce((n, r) => n + r.cost_usd, 0);
      expect(itemSpent(w.dir, id), id).toBeCloseTo(sum, 6);
      const logged = costLog.filter((r) => r.properties['Item'] === id).reduce((n, r) => n + Number(r.properties['Cost USD'] ?? 0), 0);
      expect(logged, `${id} Cost log`).toBeCloseTo(sum, 6);
    }

    // ---- outbox: Status is the engine's; an agent entry that writes it is rejected and changes nothing
    enqueue(w.dir, {
      id: 'agent-status-1',
      created_at: '2026-12-31T00:00:00.000Z',
      run_id: 'r-20261119-0800-01',
      role: 'orchestrator',
      op: 'update',
      database: 'stories',
      item_id: w.stories[0] as string,
      properties: { Status: 'Backlog' },
    });
    const rejected = await pushOutbox(w.dir, w.port, readNotionMap(w.dir), {});
    expect(rejected.applied).toHaveLength(0);
    expect(rejected.rejected[0]?.reason).toMatch(/Status/);
    await w.pull();
    expect(w.status(w.stories[0] as string)).toBe('Done');

    // ---- git: five feature branches published by the host; nobody pushed main; each story merged once, by arima-merge
    expect(git(w.remote, 'branch', '--list').split('\n').filter((l) => l.includes('feat/'))).toHaveLength(5);
    expect(git(w.remote, 'rev-list', '--count', 'main')).toBe('1');
    expect(readEvents(w.dir).filter((e) => e.type === 'merge.done')).toHaveLength(5);
    const merges = w.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');
    expect(merges).toHaveLength(5);
    for (const m of merges) {
      expect(m).toContain('--squash');
      expect(m.some((a) => a === '--match-head-commit')).toBe(true);
    }
    expect(readEvents(w.dir).filter((e) => e.type === 'pr.published')).toHaveLength(5);

    // ---- digest: written by each run from the template, in order, lists capped, each story shipped once
    const digestDir = path.join(w.dir, '.arima', 'digests');
    const digests = readdirSync(digestDir).sort().map((f) => readFileSync(path.join(digestDir, f), 'utf8'));
    expect(digests.length).toBeGreaterThanOrEqual(5);
    const headings = [...readFileSync(path.join(ROOT, 'plugins/arima/templates/digest.md'), 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toHaveLength(8);
    for (const d of digests) {
      expect([...d.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(headings);
      for (const section of d.split(/^## /m).slice(1))
        expect(section.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThanOrEqual(11);
    }
    const shippedLines = digests.flatMap((d) =>
      (/## Shipped\n([\s\S]*?)\n## /.exec(d)?.[1] ?? '').split('\n'),
    );
    for (const id of w.stories) expect(shippedLines.filter((l) => l.includes(id)), id).toHaveLength(1);
    expect(readEvents(w.dir).filter((e) => e.type === 'digest.published').length).toBeGreaterThanOrEqual(5);

    // ---- idempotence: another dispatch changes nothing (no unit, no new row, no new PR)
    const counts = (): Record<string, number> => ({
      stories: readMirror(w.dir, 'stories')?.rows.length ?? 0,
      cost_log: readMirror(w.dir, 'cost_log')?.rows.length ?? 0,
      digests: readMirror(w.dir, 'digests')?.rows.length ?? 0,
    });
    const before = counts();
    const prCalls = w.calls.filter((c) => c[1] === 'create').length;
    const ledgerBefore = readLedger(w.dir).length;
    const again = await runDispatch(w.opts({ deps: w.deps({ now: new Date(BASE + days * DAY) }) }));
    expect(again.dispatched.filter((d) => d.result !== 'skipped')).toEqual([]);
    await w.pull();
    expect(noDuplicateRows(before, counts())).toEqual([]);
    expect(w.calls.filter((c) => c[1] === 'create')).toHaveLength(prCalls);
    expect(readLedger(w.dir)).toHaveLength(ledgerBefore);
    expect(existsSync(path.join(w.dir, '.arima', 'run.lock'))).toBe(false);
  }, 240_000);

  it('a stub that emits invalid output fails its run (report_invalid), is retried once, and a second failure blocks the story with a question', async () => {
    const w = await world({ stories: 1 });
    stubRoles(w);
    writeFileSync(path.join(w.stub, 'developer-develop.1.txt'), 'I finished, trust me.');
    writeFileSync(path.join(w.stub, 'developer-develop.2.txt'), reportText('developer', { criteria_map: [] }));
    await approveG2(w);
    await readyAll(w);
    const r = await day(w, 1);
    const rows = readLedger(w.dir).filter((x) => x.role === 'developer');
    expect(rows.map((x) => [x.result, x.reason])).toEqual([
      ['fail', 'report_invalid'],
      ['fail', 'report_invalid'],
    ]);
    expect(r.dispatched.some((d) => d.result === 'pass')).toBe(false);
    expect(readEvents(w.dir).filter((e) => e.type === 'report.rejected')).toHaveLength(2);
    // the failed run published nothing and the story did not advance
    expect(readEvents(w.dir).some((e) => e.type === 'pr.published')).toBe(false);
    await w.pull();
    expect(['Blocked', 'In Progress']).toContain(w.status(w.stories[0] as string));
    expect(readEvents(w.dir).some((e) => e.type === 'question.raised')).toBe(true);
  }, 120_000);
});
