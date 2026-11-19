// WP-101: the contracts of docs/build/03-contracts.md are code. Every schema has valid and invalid
// fixtures; the event, kind, reason and exit-code lists in the contract equal the code and schemas.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import type { EventType } from '../src/events.js';
import { HARD_STOPS } from '../src/hardstops.js';
import { ENV_EXIT } from '../src/env.js';
import { INIT_EXIT } from '../src/init.js';
import { UNIT_KINDS } from '../src/kinds.js';
import type { UnitKind } from '../src/kinds.js';
import { describeError, getValidator } from '../src/lib/schema.js';
import type { SchemaName } from '../src/lib/schema.js';
import { PREFLIGHT_EXIT, runPreflight } from '../src/preflight.js';
import { REASON_CODES } from '../src/reasons.js';
import { checkReport } from '../src/report.js';
import type { Role } from '../src/ledger.js';
import { EXIT } from '../src/run-agent.js';
import { REPO_ROOT, PLUGIN_ROOT, project, tempDir } from './helpers.js';

const contract = readFileSync(path.join(REPO_ROOT, 'docs', 'build', '03-contracts.md'), 'utf8');
const section = (from: string, to: string): string => {
  const a = contract.indexOf(from);
  const b = contract.indexOf(to, a + from.length);
  expect(a, `${from} not found in 03-contracts.md`).toBeGreaterThanOrEqual(0);
  return contract.slice(a, b < 0 ? undefined : b);
};
const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, 'fixtures', 'contracts', name), 'utf8'),
  ) as T;
const schemaEnum = (name: string, pick: (s: Record<string, unknown>) => unknown): string[] => {
  const s = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'schemas', name), 'utf8')) as Record<
    string,
    unknown
  >;
  return [...(pick(s) as string[])];
};
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

interface Valid {
  name: string;
  value: unknown;
  ctx?: { role: Role; kind: UnitKind };
}
interface Invalid extends Valid {
  error: string;
  evidenceMissing?: boolean;
}
const LONG = 'x'.repeat(601);
const materialise = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v).replace('__LONG__', LONG));

describe('every contract schema has valid and invalid fixtures', () => {
  const plain: SchemaName[] = ['question', 'finding', 'decision', 'work-unit'];
  for (const name of plain) {
    const valid = fixture<Valid[]>(`${name}.valid.json`);
    const invalid = fixture<Invalid[]>(`${name}.invalid.json`);
    it(`${name}: has fixtures of both kinds`, () => {
      expect(valid.length).toBeGreaterThan(0);
      expect(invalid.length).toBeGreaterThan(0);
    });
    for (const v of valid)
      it(`${name} accepts: ${v.name}`, () => {
        const validate = getValidator(name);
        expect(validate(v.value), JSON.stringify(validate.errors)).toBe(true);
      });
    for (const v of invalid)
      it(`${name} rejects: ${v.name}`, () => {
        const validate = getValidator(name);
        expect(validate(v.value)).toBe(false);
        const text = (validate.errors ?? []).map(describeError).join('; ');
        expect(text).toContain(v.error);
      });
  }

  const valid = fixture<Valid[]>('agent-report.valid.json');
  const invalid = fixture<Invalid[]>('agent-report.invalid.json');
  it('agent-report: has fixtures of both kinds', () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });
  for (const v of valid)
    it(`agent-report accepts: ${v.name}`, () => {
      const r = checkReport(materialise(v.value), v.ctx as NonNullable<Valid['ctx']>);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  for (const v of invalid)
    it(`agent-report rejects: ${v.name}`, () => {
      const r = checkReport(materialise(v.value), v.ctx as NonNullable<Valid['ctx']>);
      expect(r.ok).toBe(false);
      expect(r.errors.join('; ')).toContain(v.error);
      expect(r.evidenceMissing).toBe(v.evidenceMissing === true);
    });
});

describe('the report rules of 03-contracts 3.3', () => {
  const base = {
    schema_version: 1,
    run_id: 'r-20261117-0603-07',
    item: 'US-112',
    status: 'done',
    summary: 'x',
  };
  it('the skeleton kind is exempt from criteria_map; develop is not', () => {
    const dev = { ...base, role: 'developer' };
    expect(checkReport(dev, { role: 'developer', kind: 'skeleton' }).ok).toBe(true);
    expect(checkReport(dev, { role: 'developer', kind: 'develop' }).ok).toBe(false);
  });
  it('qa qa needs criteria_map and a verdict; qa test-write needs neither', () => {
    const qa = { ...base, role: 'qa' };
    const r = checkReport(qa, { role: 'qa', kind: 'qa' });
    expect(r.errors.join('\n')).toMatch(/criteria_map: required/);
    expect(r.errors.join('\n')).toMatch(/verdict: required/);
    expect(checkReport(qa, { role: 'qa', kind: 'test-write' }).ok).toBe(true);
  });
  it('a report with an unknown field or no summary never validates', () => {
    expect(checkReport({ ...base, role: 'ba', extra: 1 }, { role: 'ba', kind: 'author' }).ok).toBe(
      false,
    );
    const noSummary: Record<string, unknown> = { ...base, role: 'ba' };
    delete noSummary['summary'];
    expect(checkReport(noSummary, { role: 'ba', kind: 'author' }).ok).toBe(false);
  });
});

describe('lists in the contract equal the code and the schemas', () => {
  it('event types: events.ts, event.schema.json and 03-contracts.md list the same types', () => {
    const doc = section('## 5. Events', '## 6.');
    const line = /Types: `([^`]+)`/.exec(doc);
    expect(line, 'Types line').not.toBeNull();
    const inDoc = (line as RegExpExecArray)[1]?.split(/\s+/) ?? [];
    const inSchema = schemaEnum('event.schema.json', (s) => {
      const props = s['properties'] as Record<string, { enum?: string[] }>;
      return props['type']?.enum;
    });
    const events = readFileSync(path.join(import.meta.dirname, '..', 'src', 'events.ts'), 'utf8');
    const typeBlock = /export type EventType =([\s\S]*?);/.exec(events)?.[1] ?? '';
    const inCode = [...typeBlock.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1] as string);
    expect(sorted(inSchema)).toEqual(sorted(inCode));
    expect(sorted(inDoc)).toEqual(sorted(inCode));
    expect(new Set(inCode).size).toBe(inCode.length);
  });

  it('every new event type can be written and read back', async () => {
    const dir = tempDir();
    const types: EventType[] = [
      'report.accepted',
      'merge.refused',
      'deploy.production',
      'lesson.applied',
    ];
    for (const type of types) await appendEvent(dir, { type, actor: 'system' });
    expect(readEvents(dir).map((e) => e.type)).toEqual(types);
    await expect(
      appendEvent(dir, { type: 'not.an.event' as EventType, actor: 'system' }),
    ).rejects.toThrow();
  });

  it('unit kinds: kinds.ts, work-unit.schema.json and the contract list are equal', () => {
    const doc = section('### 3.1 Work-unit descriptor', '### 3.2');
    const line = /kind = ([^\n(]+?)\s{2,}\(/.exec(doc) ?? /kind = ([^\n]+)/.exec(doc);
    const inDoc = (line?.[1] ?? '')
      .split('|')
      .map((k) => k.trim())
      .filter(Boolean);
    const inSchema = schemaEnum('work-unit.schema.json', (s) => {
      const props = s['properties'] as Record<string, { enum?: string[] }>;
      return props['kind']?.enum;
    });
    expect(sorted(inSchema)).toEqual(sorted(UNIT_KINDS));
    expect(sorted(inDoc)).toEqual(sorted(UNIT_KINDS));
  });

  it('reason codes: reasons.ts, the ledger schema and section 9b are equal', () => {
    const doc = section('## 9b. Reason codes', '## 10.');
    const body = doc.split('\n').slice(1).join('\n').split('A run result is')[0] ?? '';
    const inDoc = [...body.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string);
    const inLedger = schemaEnum('ledger.schema.json', (s) => {
      const props = s['properties'] as Record<string, { enum?: string[] }>;
      return props['reason']?.enum;
    });
    expect(sorted(inDoc)).toEqual(sorted(REASON_CODES));
    expect(sorted(inLedger)).toEqual(sorted(REASON_CODES));
  });

  it('hard-stop ids: the question schema, the code and the contract agree', () => {
    const inSchema = schemaEnum('question.schema.json', (s) => {
      const props = s['properties'] as Record<string, { enum?: string[] }>;
      return props['hard_stop']?.enum;
    });
    expect(sorted(inSchema)).toEqual(sorted(HARD_STOPS));
    for (const id of HARD_STOPS) expect(section('## 1. Identity', '## 2.')).toContain(id);
  });

  it('roles in every contract schema equal ROLES', async () => {
    const { ROLES } = await import('../src/roles.js');
    for (const [file, pick] of [
      ['agent-report.schema.json', (p: Record<string, { enum?: string[] }>) => p['role']?.enum],
      ['work-unit.schema.json', (p: Record<string, { enum?: string[] }>) => p['role']?.enum],
      ['question.schema.json', (p: Record<string, { enum?: string[] }>) => p['addressed_to']?.enum],
    ] as const) {
      const got = schemaEnum(file, (s) =>
        pick(s['properties'] as Record<string, { enum?: string[] }>),
      );
      expect(sorted(got), file).toEqual(sorted(ROLES));
    }
  });
});

/** "0 ok, 2 usage, 10-14 as preflight" -> [0, 2, 10, 11, 12, 13, 14]. */
function codesOf(cell: string): number[] {
  const out: number[] = [];
  for (const part of cell.split(/[,;]/)) {
    const m = /^\s*(\d+)(?:-(\d+))?/.exec(part.replace(/\([^)]*\)/g, ''));
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    for (let c = lo; c <= hi; c += 1) out.push(c);
  }
  return out;
}

describe('exit-code registry (03-contracts 8) matches the code', () => {
  const doc = section('## 8. Exit-code registry', 'Planned scripts reserve');
  const rows = new Map<string, number[]>();
  for (const m of doc.matchAll(/^\| `(arima-[a-z-]+)` \| (.+) \|$/gm))
    rows.set(m[1] as string, codesOf(m[2] as string));

  it('lists a row for every built script and no script that does not exist', () => {
    const bins = readdirSync(path.join(import.meta.dirname, '..', 'src', 'bin'))
      .map((f) => f.replace(/\.ts$/, ''))
      .filter((n) => n !== 'arima-version');
    expect(sorted([...rows.keys()])).toEqual(sorted(bins));
    for (const name of rows.keys())
      expect(existsSync(path.join(PLUGIN_ROOT, 'scripts', 'src', 'bin', `${name}.ts`)), name).toBe(
        true,
      );
  });

  it('arima-preflight lists exactly the codes of PREFLIGHT_EXIT', () => {
    expect(sorted((rows.get('arima-preflight') ?? []).map(String))).toEqual(
      sorted(Object.values(PREFLIGHT_EXIT).map(String)),
    );
  });

  it('arima-init lists exactly the codes of INIT_EXIT plus the preflight codes (10-14)', () => {
    const want = new Set([...Object.values(INIT_EXIT), 10, 11, 12, 13, 14]);
    expect(sorted((rows.get('arima-init') ?? []).map(String))).toEqual(
      sorted([...want].map(String)),
    );
    expect(INIT_EXIT.stateNotSaved).toBe(7);
  });

  it('arima-env lists exactly the codes of ENV_EXIT (70 = production refused)', () => {
    expect(sorted((rows.get('arima-env') ?? []).map(String))).toEqual(
      sorted(Object.values(ENV_EXIT).map(String)),
    );
    expect(ENV_EXIT.refused).toBe(70);
  });

  it('arima-run-agent lists every code of EXIT, and 12 and 13 from preflight', () => {
    const got = rows.get('arima-run-agent') ?? [];
    for (const c of Object.values(EXIT)) expect(got, String(c)).toContain(c);
    expect(got).toContain(PREFLIGHT_EXIT.killSwitch);
    expect(got).toContain(PREFLIGHT_EXIT.budget);
  });

  it('every row lists 0 and, except arima-hook, 2 for usage', () => {
    for (const [name, codes] of rows) {
      expect(codes, name).toContain(0);
      if (name !== 'arima-hook') expect(codes, name).toContain(2);
    }
  });

  it('planned scripts do not reuse a built script name', () => {
    const planned = section('Planned scripts reserve', '## 9. Ticket');
    for (const name of rows.keys())
      expect(planned).not.toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });
});

describe('G-03: the GitHub token is required only by commands that use GitHub', () => {
  const setup = (): string => {
    return project();
  };
  const env = { ARIMA_NOTION_TOKEN: 'ntn_test_value_not_a_secret' } as NodeJS.ProcessEnv;

  it('preflight without needs.github passes without a GitHub token only when the config names none', async () => {
    const dir = setup();
    const r = await runPreflight({
      projectDir: dir,
      env,
      notion: null,
      statePause: () => Promise.resolve(false),
    });
    const envCheck = r.checks.find((c) => c.check === 'env');
    // The example config names a GitHub token variable, so a command that uses GitHub needs it.
    expect(envCheck?.ok).toBe(false);
    expect(envCheck?.detail).toMatch(/GITHUB|github|GH_/i);
  });

  it('preflight with needs.github false does not ask for the GitHub token', async () => {
    const dir = setup();
    const r = await runPreflight({
      projectDir: dir,
      env,
      notion: null,
      needs: { github: false },
      statePause: () => Promise.resolve(false),
    });
    expect(r.checks.find((c) => c.check === 'env')?.ok).toBe(true);
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.ok);
  });

  it('a missing Notion token still fails, whatever the command needs', async () => {
    const dir = setup();
    const r = await runPreflight({
      projectDir: dir,
      env: {},
      notion: null,
      needs: { github: false },
      statePause: () => Promise.resolve(false),
    });
    expect(r.exitCode).toBe(PREFLIGHT_EXIT.env);
  });
});
