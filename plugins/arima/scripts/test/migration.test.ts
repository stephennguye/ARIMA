import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProject } from '../src/config.js';
import { appendEvent, readEvents } from '../src/events.js';
import { readLedger, recordRun } from '../src/ledger.js';
import { CURRENT_SCHEMA_VERSION, SchemaVersionError, migrateRecord } from '../src/lib/migrate.js';
import { Throttle } from '../src/lib/throttle.js';
import { bootstrapTemplate } from '../src/notion/build.js';
import { mapWorkspace } from '../src/notion/mapper.js';
import { outboxDir, pushOutbox } from '../src/notion/outbox.js';
import { createNotionPort } from '../src/notion/port.js';
import { FakeNotion } from './fake-notion.js';
import { project, tempDir } from './helpers.js';

const V01 = path.join(import.meta.dirname, 'fixtures', 'v0.1');

/** A project as v0.1 left it: its own config files plus a `.arima/` with no `schema_version` anywhere. */
function legacyProject(): string {
  const dir = project();
  cpSync(path.join(V01, '.arima'), path.join(dir, '.arima'), { recursive: true });
  return dir;
}

describe('previous-version fixtures load (spec 15.3)', () => {
  it('the v0.1 ledger and events have no schema_version and still read', () => {
    const dir = legacyProject();
    const rows = readLedger(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.schema_version).toBeUndefined();
    expect(readEvents(dir).map((e) => e.type)).toEqual(['run.start', 'run.end']);
  });

  it('old rows stay as they were, new rows are stamped, and both read side by side', async () => {
    const dir = legacyProject();
    const before = readFileSync(path.join(dir, '.arima', 'ledger.jsonl'), 'utf8');
    await appendEvent(dir, { type: 'run.paused', actor: 'orchestrator' });
    const events = readEvents(dir);
    expect(events).toHaveLength(3);
    expect(events[2]?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(events[0]?.schema_version).toBeUndefined();
    // the old file is never rewritten
    expect(readFileSync(path.join(dir, '.arima', 'ledger.jsonl'), 'utf8')).toBe(before);
  });

  it('new ledger rows carry schema_version 1', async () => {
    const dir = tempDir();
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      num_turns: 1,
      result: 'x',
      session_id: '11111111-1111-4111-8111-111111111111',
      total_cost_usd: 0.1,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const row = await recordRun(dir, stdout, {
      run_id: 'r-20261117-0603-07',
      date: '2026-11-17',
      project: 'TAS',
      phase: 4,
      item: 'US-112',
      role: 'developer',
      attempt: 1,
      is_rework: false,
      budget_usd: 3,
    } as never);
    expect(row.schema_version).toBe(1);
    expect(readLedger(dir)[0]?.schema_version).toBe(1);
  });

  it('a v0.1 config validates', () => {
    const dir = legacyProject();
    const r = validateProject(dir);
    expect(r.errors).toEqual([]);
  });

  it('a v0.1 outbox entry (no schema_version) is judged on its merits, not its age', async () => {
    const { dir, port, map } = await outboxWorld();
    const r = await pushOutbox(dir, port, map, { bindRuns: false });
    expect(r.rejected.map((x) => x.reason).join(' ')).not.toMatch(/schema_version|newer/);
    expect(r, JSON.stringify(r)).toMatchObject({ applied: ['q-old'] });
  });
});

describe('a record from a newer ARIMA is refused, not misread', () => {
  it('migrateRecord: absent is 1, current passes, higher and junk throw', () => {
    const row = { a: 1 };
    expect(migrateRecord('ledger', row)).toBe(row);
    expect(migrateRecord('ledger', { schema_version: 1 })).toEqual({ schema_version: 1 });
    expect(() => migrateRecord('ledger', { schema_version: 2 })).toThrow(SchemaVersionError);
    expect(() => migrateRecord('event', { schema_version: 2 })).toThrow(/upgrade the plugin/);
    expect(() => migrateRecord('outbox', { schema_version: 0 })).toThrow(/invalid/);
    expect(() => migrateRecord('outbox', { schema_version: '1' })).toThrow(/invalid/);
    // other record kinds are not versioned here
    expect(migrateRecord('agent-report', { schema_version: 2 })).toEqual({ schema_version: 2 });
  });

  it('reading a ledger with a version 2 row names the file and line', () => {
    const dir = legacyProject();
    const f = path.join(dir, '.arima', 'ledger.jsonl');
    const first = readFileSync(f, 'utf8').trim();
    writeFileSync(f, `${first}\n${first.replace('{', '{"schema_version":2,')}\n`);
    expect(() => readLedger(dir)).toThrow(/ledger\.jsonl:2: .*newer than this ARIMA/);
  });

  it('a version 2 outbox entry is rejected with that reason and is not applied', async () => {
    const { dir, port, map } = await outboxWorld();
    const old = JSON.parse(readFileSync(path.join(outboxDir(dir), 'q-old.json'), 'utf8'));
    writeFileSync(
      path.join(outboxDir(dir), 'q-future.json'),
      JSON.stringify({ ...old, id: 'q-future', schema_version: 2 }),
    );
    const r = await pushOutbox(dir, port, map, { bindRuns: false });
    expect(r, JSON.stringify(r)).toMatchObject({ applied: ['q-old'] });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.id).toBe('q-future');
    expect(r.rejected[0]?.reason).toMatch(/newer than this ARIMA/);
  });
});

async function outboxWorld() {
  const fake = new FakeNotion();
  const port = createNotionPort(fake.client, new Throttle(0), { sleep: () => Promise.resolve() });
  await bootstrapTemplate(port, fake.rootId);
  const map = (await mapWorkspace(port, fake.rootId)).map!;
  const dir = legacyProject();
  writeFileSync(path.join(dir, '.arima', 'notion-map.json'), JSON.stringify(map));
  return { dir, port, map };
}
