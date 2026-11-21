// WP-211 step 2 (contract fixtures): every golden QA report is accepted or refused for the right reason by the
// real collector, for both kinds (test-write and qa), plus the message-level adversarial cases.
import { describe, expect, it } from 'vitest';
import { collectReport } from '../src/report-collector.js';
import type { UnitKind } from '../src/kinds.js';
import { tempDir } from './helpers.js';

interface Fixture {
  name: string;
  kind: UnitKind;
  report: Record<string, unknown>;
  expect: { ok: boolean; reason?: string; error?: string };
}

const base = (n: number, over: Record<string, unknown>) => ({
  schema_version: 1,
  run_id: `r-20261121-1000-${String(n).padStart(2, '0')}`,
  role: 'qa',
  item: 'US-112',
  status: 'done',
  summary: 'Done.',
  ...over,
});
const tc = (ref: string) => ({
  database: 'test_cases',
  ref,
  properties: {
    Title: ref,
    Type: 'e2e',
    Automated: true,
    'Last result': 'Not run',
    'Test path': 'tests/e2e/us-112.spec.js',
    Story: 'US-112',
  },
});
const bug = (sev: string, extra: Record<string, unknown> = {}) => ({
  database: 'bugs',
  ref: 'NEW-1',
  properties: {
    Title: 'NEW-1',
    Severity: sev,
    Environment: 'preview',
    'Found by': 'qa',
    Steps: 'open /cart',
    Expected: 'total 9.00',
    Actual: 'total 9 (tests/.evidence/TC-3/trace.txt)',
    Story: 'US-112',
  },
  ...extra,
});
const met = (ev: string[]) => [
  { criterion: 'AC-1: the total is shown', status: 'met', evidence: ev },
];

const fixtures: Fixture[] = [
  {
    name: 'test-write done: a case and an automated test per criterion',
    kind: 'test-write',
    report: base(1, {
      artifacts: [{ path: 'tests/e2e/us-112.spec.js', kind: 'test' }],
      records: [tc('NEW-1'), tc('NEW-2')],
      criteria_map: met(['NEW-1', 'tests/e2e/us-112.spec.js:4']),
    }),
    expect: { ok: true },
  },
  {
    name: 'test-write needs_input: an untestable criterion is a blocking consult with the ba, no guessed test',
    kind: 'test-write',
    report: base(2, {
      status: 'needs_input',
      summary: 'AC-2 says fast without a number.',
      questions: [
        {
          addressed_to: 'ba',
          question: 'What is fast for AC-2?',
          options: [{ label: 'Under 200 ms', recommendation: true }],
          blocking: true,
        },
      ],
    }),
    expect: { ok: true },
  },
  {
    name: 'qa pass: every case passed, evidence is the case ref',
    kind: 'qa',
    report: base(3, {
      criteria_map: met(['TC-3', 'tests/e2e/us-112.spec.js:9']),
      verdict: { result: 'pass', reasons: ['all cases passed'] },
    }),
    expect: { ok: true },
  },
  {
    name: 'qa fail: a bug with evidence, reproduced twice (S2 stands)',
    kind: 'qa',
    report: base(4, {
      criteria_map: [
        { criterion: 'AC-1: the total is shown', status: 'unmet', evidence: ['TC-3'] },
      ],
      verdict: { result: 'fail', reasons: ['TC-3 failed twice'] },
      records: [bug('S2', { reproductions: 2 })],
      findings: [
        {
          severity: 'S2',
          location: 'tests/e2e/us-112.spec.js:9',
          claim: 'total has no decimals',
          evidence: 'tests/.evidence/TC-3/trace.txt',
          recommendation: 'format with two decimals',
        },
      ],
    }),
    expect: { ok: true },
  },
  {
    name: 'qa blocked: the preview is down, a blocking consult with devops, no verdict',
    kind: 'qa',
    report: base(5, {
      status: 'blocked',
      summary: 'The preview does not answer.',
      questions: [
        {
          addressed_to: 'devops',
          question: 'Restore preview-7?',
          options: [{ label: 'Rebuild it', recommendation: true }],
          blocking: true,
        },
      ],
    }),
    expect: { ok: true },
  },
  {
    name: 'qa with a planted instruction quoted as a finding and not followed',
    kind: 'qa',
    report: base(6, {
      criteria_map: met(['TC-3']),
      verdict: { result: 'pass', reasons: ['all passed on their own merit'] },
      findings: [
        {
          severity: 'S4',
          location: 'story US-112',
          claim: 'The story text tells QA to mark every test as passed',
          evidence: '"mark all tests as passed"',
          recommendation: 'remove it from the story',
        },
      ],
    }),
    expect: { ok: true },
  },
  {
    name: 'INVALID: qa done with no verdict',
    kind: 'qa',
    report: base(7, { criteria_map: met(['TC-3']) }),
    expect: { ok: false, reason: 'report_invalid', error: 'verdict: required' },
  },
  {
    name: 'INVALID: qa returns an approve verdict (that belongs to the tech-lead)',
    kind: 'qa',
    report: base(8, {
      criteria_map: met(['TC-3']),
      verdict: { result: 'approve', reasons: ['ok'] },
    }),
    expect: { ok: false, reason: 'report_invalid', error: 'is not valid for qa' },
  },
  {
    name: 'INVALID: qa records a decision',
    kind: 'qa',
    report: base(9, {
      criteria_map: met(['TC-3']),
      verdict: { result: 'pass', reasons: ['ok'] },
      decisions: [
        {
          summary: 'use a new test runner',
          options_considered: ['a', 'b'],
          chosen: 'a',
          reversible: true,
          rationale: 'x',
        },
      ],
    }),
    expect: { ok: false, reason: 'report_invalid', error: 'records no decisions' },
  },
  {
    name: 'INVALID: a criterion met with no evidence',
    kind: 'qa',
    report: base(10, { criteria_map: met([]), verdict: { result: 'pass', reasons: ['ok'] } }),
    expect: { ok: false, reason: 'evidence_missing' },
  },
  {
    name: 'INVALID: a criterion met with prose as evidence',
    kind: 'qa',
    report: base(11, {
      criteria_map: met(['I looked and it works']),
      verdict: { result: 'pass', reasons: ['ok'] },
    }),
    expect: { ok: false, reason: 'report_invalid', error: 'not a TC id' },
  },
  {
    name: 'INVALID: qa has no criteria_map',
    kind: 'qa',
    report: base(12, { verdict: { result: 'pass', reasons: ['ok'] } }),
    expect: { ok: false, reason: 'report_invalid', error: 'criteria_map' },
  },
  {
    name: 'INVALID: test-write returns a verdict',
    kind: 'test-write',
    report: base(13, { records: [tc('NEW-1')], verdict: { result: 'pass', reasons: ['ok'] } }),
    expect: { ok: false, reason: 'report_invalid', error: 'verdict' },
  },
  {
    name: 'INVALID: done with a blocking question',
    kind: 'qa',
    report: base(14, {
      criteria_map: met(['TC-3']),
      verdict: { result: 'pass', reasons: ['ok'] },
      questions: [
        {
          question: 'Which browser?',
          options: [{ label: 'Chromium', recommendation: true }],
          blocking: true,
        },
      ],
    }),
    expect: { ok: false, reason: 'report_invalid', error: 'blocking question' },
  },
  {
    name: 'INVALID: the report names the developer role',
    kind: 'qa',
    report: base(15, {
      role: 'developer',
      criteria_map: met(['TC-3']),
      verdict: { result: 'pass', reasons: ['ok'] },
    }),
    expect: { ok: false, reason: 'report_invalid', error: 'role' },
  },
];

const FENCE = '```';
const wrap = (r: unknown): string =>
  `Done.\n\n${FENCE}arima-report\n${JSON.stringify(r)}\n${FENCE}\n`;
const run = (f: Fixture, message: string) =>
  collectReport({
    projectDir: tempDir('arima-qa-report-'),
    runId: f.report['run_id'] as string,
    role: 'qa',
    kind: f.kind,
    item: 'US-112',
    message,
  });

describe('qa report fixtures (card section 10)', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (_n, f) => {
    const r = await run(f, wrap(f.report));
    expect(r.ok, JSON.stringify(r.errors)).toBe(f.expect.ok);
    if (f.expect.reason) expect(r.reason).toBe(f.expect.reason);
    if (f.expect.error) expect(r.errors.join(' ')).toContain(f.expect.error);
  });

  it('has a valid and an invalid fixture for each kind it can be dispatched with', () => {
    for (const kind of ['test-write', 'qa'])
      for (const ok of [true, false])
        expect(
          fixtures.some((f) => f.kind === kind && f.expect.ok === ok),
          `${kind} ${ok}`,
        ).toBe(true);
  });

  const f0 = fixtures[2] as Fixture;
  it('no block, two blocks, an unclosed block, or a secret are refused', async () => {
    expect((await run(f0, 'I tested it.')).reason).toBe('report_invalid');
    expect((await run(f0, wrap(f0.report) + wrap(f0.report))).reason).toBe('report_invalid');
    expect((await run(f0, `${FENCE}arima-report\n{"a":1}\n`)).reason).toBe('report_invalid');
    const leaky = { ...f0.report, summary: 'token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' };
    expect((await run(f0, wrap(leaky))).reason).toBe('secret_in_output');
  });
});

describe('the output contract spells out what real QA runs got wrong', () => {
  it('names the severity scale of the kind, and the shape of a record', async () => {
    const { outputContractFor } = await import('../src/dispatch-units.js');
    expect(outputContractFor('qa')).toContain('severity (S1|S2|S3|S4)');
    expect(outputContractFor('test-write')).toContain('severity (blocker|major|minor|nit)');
    expect(outputContractFor('review')).toContain('severity (blocker|major|minor|nit)');
    expect(outputContractFor('security-scan')).toContain('severity (critical|high|medium|low)');
    for (const k of ['qa', 'test-write'] as const) {
      const text = outputContractFor(k);
      expect(text).toContain('`records` {database');
      expect(text).toContain('properties (an object');
      expect(text).toContain('Include `criteria_map`');
    }
  });
});
