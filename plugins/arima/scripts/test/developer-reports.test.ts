// WP-210 step 2 (contract fixtures): every golden developer report is accepted or refused for the right
// reason by the real collector, plus the message-level adversarial cases and the output contract.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { outputContractFor, taskFor } from '../src/dispatch-units.js';
import { collectReport } from '../src/report-collector.js';
import { tempDir } from './helpers.js';

interface Fixture {
  name: string;
  kind: 'develop';
  item: string;
  report: Record<string, unknown>;
  expect: { ok: boolean; reason?: string; error?: string };
}

const fixtures = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/agents/developer/reports.json'), 'utf8'),
) as Fixture[];

const FENCE = '```';
const wrap = (r: unknown): string =>
  `Done.\n\n${FENCE}arima-report\n${JSON.stringify(r)}\n${FENCE}\n`;

const run = (f: Fixture, message: string) =>
  collectReport({
    projectDir: tempDir('arima-dev-report-'),
    runId: f.report['run_id'] as string,
    role: 'developer',
    kind: f.kind,
    item: f.item,
    message,
  });

describe('developer report fixtures (card section 10)', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (_n, f) => {
    const r = await run(f, wrap(f.report));
    expect(r.ok, JSON.stringify(r.errors)).toBe(f.expect.ok);
    if (f.expect.reason) expect(r.reason).toBe(f.expect.reason);
    if (f.expect.error) expect(r.errors.join(' ')).toContain(f.expect.error);
  });

  it('covers every adversarial case of the card: met without evidence, no criteria, a verdict, an id, a secret', () => {
    const names = fixtures.map((f) => f.name).join('\n');
    for (const w of ['met with no evidence', 'no criteria_map', 'verdict', 'chose an id'])
      expect(names).toContain(w);
  });

  const base = fixtures[0] as Fixture;
  it('a message with no report block, two blocks, or an unclosed block is refused', async () => {
    expect((await run(base, 'I did the work.')).reason).toBe('report_invalid');
    expect((await run(base, wrap(base.report) + wrap(base.report))).reason).toBe('report_invalid');
    expect((await run(base, `${FENCE}arima-report\n{"a":1}\n`)).reason).toBe('report_invalid');
  });

  it('a secret in the final message is discarded before anything else (secret_in_output)', async () => {
    const leaky = {
      ...base.report,
      summary: 'token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    };
    expect((await run(base, wrap(leaky))).reason).toBe('secret_in_output');
  });
});

describe('output contract and task for a develop unit', () => {
  const text = outputContractFor('develop');
  it('asks for criteria_map with evidence and never a verdict', () => {
    expect(text).toContain('criteria_map');
    expect(text).toContain('`met` needs at least one');
    expect(text).toContain('criterion (the criterion id and its text');
    expect(text).not.toContain('Include `verdict`');
  });
  it('lets a question be addressed to a role (a consult) and names the hard-stop ids a developer meets', () => {
    expect(text).toContain('addressed_to?');
    for (const id of ['licence', 'new_paid_service', 'secrets_change']) expect(text).toContain(id);
  });
  it('the task says: tests first, commit, no push, ask instead of guess, never edit tests/e2e', () => {
    const t = taskFor({ kind: 'develop', role: 'developer', item: 'US-1', why: 'x' } as never);
    for (const w of ['Do not push', 'tests/e2e', 'ambiguous', 'criteria_map'])
      expect(t).toContain(w);
  });
});

describe('judge J-agent:developer, majors 1 and 2: a done report must be backed, a needs_input needs a question', () => {
  const base = fixtures[0] as Fixture;
  const withReport = (over: Record<string, unknown>) => ({
    ...base,
    report: { ...base.report, ...over },
  });
  it('done with an unmet or unclear criterion is refused', async () => {
    for (const status of ['unmet', 'unclear']) {
      const f = withReport({ criteria_map: [{ criterion: 'AC-1: x', status, evidence: [] }] });
      const r = await run(f, wrap(f.report));
      expect(r.errors.join(' '), status).toContain('the status cannot be done');
    }
  });
  it('evidence that is not file:line, a test case id or a bug id is refused; the real shapes pass', async () => {
    for (const ev of ['see code', 'the cart module', 'src/a.js', 'src/a.js:x'])
      expect(
        (
          await run(
            withReport({ criteria_map: [{ criterion: 'AC-1: x', status: 'met', evidence: [ev] }] }),
            wrap(
              withReport({
                criteria_map: [{ criterion: 'AC-1: x', status: 'met', evidence: [ev] }],
              }).report,
            ),
          )
        ).ok,
        ev,
      ).toBe(false);
    for (const ev of [
      'src/a.js:3',
      'test/a.test.js:10-14',
      'TC-12',
      'BUG-5',
      'C:/x/a.js:2'.slice(3),
    ]) {
      const f = withReport({
        criteria_map: [{ criterion: 'AC-1: x', status: 'met', evidence: [ev] }],
      });
      expect((await run(f, wrap(f.report))).ok, ev).toBe(true);
    }
  });
  it('needs_input with no question is refused', async () => {
    const f = withReport({
      status: 'needs_input',
      criteria_map: [{ criterion: 'AC-1: x', status: 'unclear', evidence: [] }],
    });
    expect((await run(f, wrap(f.report))).errors.join(' ')).toContain('missing required property');
  });
});
