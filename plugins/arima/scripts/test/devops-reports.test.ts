// WP-213 step 2 (contract fixtures): every golden devops report is accepted or refused for the right
// reason by the real collector; the message-level adversarial cases (no block, two blocks, a secret).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAttribution } from '../src/attribution.js';
import { collectReport } from '../src/report-collector.js';
import type { UnitKind } from '../src/kinds.js';
import { tempDir } from './helpers.js';

interface Fixture {
  name: string;
  kind: UnitKind;
  item: string;
  report: Record<string, unknown>;
  expect: { ok: boolean; reason?: string; error?: string };
}

const fixtures = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/agents/devops/reports.json'), 'utf8'),
) as Fixture[];

const FENCE = '```';
const wrap = (r: unknown): string =>
  `Done.\n\n${FENCE}arima-report\n${JSON.stringify(r)}\n${FENCE}\n`;

const run = (f: Fixture, message: string) =>
  collectReport({
    projectDir: tempDir('arima-devops-report-'),
    runId:
      f.report['run_id'] === 'r-20260101-0000-99'
        ? 'r-20261120-0900-08'
        : (f.report['run_id'] as string),
    role: 'devops',
    kind: f.kind,
    item: f.item,
    message,
  });

describe('devops report fixtures (card section 10)', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (_n, f) => {
    const r = await run(f, wrap(f.report));
    expect(r.ok, JSON.stringify(r.errors)).toBe(f.expect.ok);
    if (f.expect.reason) expect(r.reason).toBe(f.expect.reason);
    if (f.expect.error) expect(r.errors.join(' ')).toContain(f.expect.error);
  });

  it('has at least one valid and one invalid fixture for each kind it can be dispatched with', () => {
    for (const kind of ['env-plan', 'deploy-staging', 'preview-diagnose'])
      for (const ok of [true, false])
        expect(
          fixtures.some((f) => f.kind === kind && f.expect.ok === ok),
          `${kind} ${ok}`,
        ).toBe(true);
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

describe('the recorded real run (card step 6: one real env-plan on a scratch project, 2026-11-20)', () => {
  const real = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, 'fixtures/agents/devops/real-env-plan.json'),
      'utf8',
    ),
  ) as {
    packet_run_id: string;
    cost_usd: number;
    num_turns: number;
    tool_events: string[];
    commit_subject: string;
    matrix_h2: string[];
    result_text: string;
  };

  it('its final message is accepted by the collector, with the matrix as a doc artifact', async () => {
    const r = await collectReport({
      projectDir: tempDir('arima-devops-real-'),
      runId: real.packet_run_id,
      role: 'devops',
      kind: 'env-plan',
      item: 'none',
      message: real.result_text,
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.report?.status).toBe('done');
    expect(r.report?.artifacts).toEqual([{ path: 'docs/ops/env-matrix.md', kind: 'doc' }]);
    expect((r.report?.findings ?? []).length).toBeGreaterThan(0);
  });

  it('kept to the card: the template sections, only Write and Bash used, a clean conventional commit, cheap', () => {
    expect(real.matrix_h2).toEqual(['Environment matrix', 'Pipeline design']);
    expect(real.tool_events.filter((e) => e.startsWith('tool.used'))).toEqual([
      'tool.used:Write',
      'tool.used:Bash',
    ]);
    expect(real.commit_subject).toMatch(/^docs\(ops\): /);
    expect(findAttribution(real.commit_subject)).toEqual([]);
    expect(real.cost_usd).toBeLessThan(0.5);
    expect(real.num_turns).toBeLessThanOrEqual(20);
  });

  it('does not ask for production, a paid service or a cloud account', () => {
    expect(real.result_text).not.toMatch(/docker (run|compose)|kubectl|aws |gcloud/i);
  });
});
