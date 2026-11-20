// WP-212 step 2 (contract fixtures): every golden tech-lead review report is accepted or refused for the
// right reason by the real collector, plus the message-level adversarial cases.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectReport } from '../src/report-collector.js';
import { tempDir } from './helpers.js';

interface Fixture {
  name: string;
  item: string;
  report: Record<string, unknown>;
  expect: { ok: boolean; reason?: string; error?: string };
}

const fixtures = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/agents/tech-lead/reports.json'), 'utf8'),
) as Fixture[];

const FENCE = '```';
const wrap = (r: unknown): string =>
  `Done.\n\n${FENCE}arima-report\n${JSON.stringify(r)}\n${FENCE}\n`;

const run = (f: Fixture, message: string) =>
  collectReport({
    projectDir: tempDir('arima-tl-report-'),
    runId: f.report['run_id'] as string,
    role: 'tech-lead',
    kind: 'review',
    item: f.item,
    message,
  });

describe('tech-lead review report fixtures (card section 10)', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (_n, f) => {
    const r = await run(f, wrap(f.report));
    expect(r.ok, JSON.stringify(r.errors)).toBe(f.expect.ok);
    if (f.expect.reason) expect(r.reason).toBe(f.expect.reason);
    if (f.expect.error) expect(r.errors.join(' ')).toContain(f.expect.error);
  });

  it('has valid and invalid fixtures for approve, changes_requested and the hard stop', () => {
    const names = fixtures.map((f) => f.name).join('\n');
    for (const w of [
      'approve',
      'changes_requested',
      'licence',
      'planted instruction',
      'no verdict',
    ])
      expect(names).toContain(w);
    expect(fixtures.filter((f) => f.expect.ok).length).toBeGreaterThanOrEqual(5);
    expect(fixtures.filter((f) => !f.expect.ok).length).toBeGreaterThanOrEqual(8);
  });

  const base = fixtures[0] as Fixture;
  it('a message with no report block, two blocks, or an unclosed block is refused', async () => {
    expect((await run(base, 'Looks good to me.')).reason).toBe('report_invalid');
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
