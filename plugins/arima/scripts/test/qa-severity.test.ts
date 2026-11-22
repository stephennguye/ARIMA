// WP-211: the severity of a QA bug is a proposal; S1 and S2 stand only for a failure that reproduced in
// two runs (spec 7.7 and 7.12), otherwise the engine lowers the proposal to S3 and says so.
import { describe, expect, it } from 'vitest';
import { bugSeverityRule } from '../src/notion/proposals.js';
import { collectReport } from '../src/report-collector.js';
import { tempDir } from './helpers.js';

const props = (Severity: string) => ({
  Title: 'NEW-1',
  Severity,
  Steps: 's',
  Expected: 'e',
  Actual: 'a',
});

describe('bugSeverityRule', () => {
  it.each(['S1', 'S2'])('lowers an unreproduced %s to S3 and says why in Actual', (sev) => {
    for (const reproductions of [undefined, 1, 'two', 0]) {
      const out = bugSeverityRule('qa', 'bugs', props(sev), reproductions);
      expect(out['Severity'], String(reproductions)).toBe('S3');
      expect(String(out['Actual'])).toContain(`lowered from ${sev} to S3`);
      expect(String(out['Actual']).startsWith('a ')).toBe(true);
    }
  });

  it.each(['S1', 'S2'])('keeps %s when the failure reproduced in two runs or more', (sev) => {
    for (const reproductions of [2, 3])
      expect(bugSeverityRule('qa', 'bugs', props(sev), reproductions)).toEqual(props(sev));
  });

  it('never changes S3 and S4, another role, or another database', () => {
    expect(bugSeverityRule('qa', 'bugs', props('S3'), undefined)).toEqual(props('S3'));
    expect(bugSeverityRule('qa', 'bugs', props('S4'), undefined)).toEqual(props('S4'));
    expect(bugSeverityRule('developer', 'bugs', props('S1'), undefined)).toEqual(props('S1'));
    expect(bugSeverityRule('qa', 'risks', props('S1'), undefined)).toEqual(props('S1'));
  });

  it('works without an Actual text', () => {
    const out = bugSeverityRule('qa', 'bugs', { Title: 'NEW-1', Severity: 'S2' }, 1);
    expect(String(out['Actual'])).toContain('lowered');
  });
});

describe('the report schema carries `reproductions` on a record, and nothing else new', () => {
  const FENCE = '```';
  const report = (extra: Record<string, unknown>) =>
    `${FENCE}arima-report\n${JSON.stringify({
      schema_version: 1,
      run_id: 'r-20261121-0900-01',
      role: 'qa',
      item: 'US-112',
      status: 'done',
      summary: 'Failed.',
      verdict: { result: 'fail', reasons: ['AC-1 failed'] },
      criteria_map: [{ criterion: 'AC-1: x', status: 'unmet', evidence: ['TC-1'] }],
      records: [
        {
          database: 'bugs',
          ref: 'NEW-1',
          properties: { Title: 'NEW-1', Severity: 'S2' },
          ...extra,
        },
      ],
    })}\n${FENCE}\n`;
  const run = (message: string) =>
    collectReport({
      projectDir: tempDir('arima-qa-sev-'),
      runId: 'r-20261121-0900-01',
      role: 'qa',
      kind: 'qa',
      item: 'US-112',
      message,
    });

  it('accepts a positive integer and refuses zero, a string and an unknown key', async () => {
    expect((await run(report({ reproductions: 2 }))).ok).toBe(true);
    expect((await run(report({ reproductions: 0 }))).ok).toBe(false);
    expect((await run(report({ reproductions: 'two' }))).ok).toBe(false);
    expect((await run(report({ severity_note: 'x' }))).ok).toBe(false);
  });
});

describe('normaliseRelations (found by the live check against real Notion)', () => {
  it('turns one id into a one-element array for a relation property, and leaves everything else alone', async () => {
    const { normaliseRelations } = await import('../src/notion/proposals.js');
    expect(normaliseRelations('bugs', { Title: 'NEW-1', Story: 'US-12' })).toEqual({
      Title: 'NEW-1',
      Story: ['US-12'],
    });
    expect(normaliseRelations('bugs', { Story: ['US-12', 'US-13'] })).toEqual({
      Story: ['US-12', 'US-13'],
    });
    expect(
      normaliseRelations('test_cases', { Story: 'US-12', 'Test path': 'tests/e2e/a.js' }),
    ).toEqual({
      Story: ['US-12'],
      'Test path': 'tests/e2e/a.js',
    });
    // Not a relation: a text value is not wrapped.
    expect(normaliseRelations('bugs', { Steps: 'open it' })).toEqual({ Steps: 'open it' });
  });
});
