// devops card scenario: env-plan on a scratch project (real agent, real `claude -p`, costs seat usage).
// Deterministic graders first: the report is accepted by the real collector, the files touched are in
// the allowed folders, no secret, no forbidden command in the event log, a clean commit. A scenario passes
// when RUNS runs meet the card threshold; with ARIMA_REAL_EVALS_RUNS=5 that is 4 of 5 (scenario 1 of the card).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectReport } from '../../../plugins/arima/scripts/src/report-collector.js';
import { gradeDevopsRun } from '../../devops/graders.js';
import { RUNS, realEnabled, runRealUnit, scratchProject, spentUsd } from '../_support.js';

const SAD = [
  '# SAD: Tasty App (synthetic)',
  '',
  '## Stack',
  'TypeScript, Node 22, React with Vite (web), Fastify (API), PostgreSQL 17 in Docker. Docker Compose runs everything on the owner machine (ADR-0007).',
  '',
  '## Services',
  '- web: static React build served by nginx on port 8080 inside the container.',
  '- api: Fastify on port 3001, exposes /healthz and /readyz.',
  '- db: PostgreSQL 17, one named volume, daily backup.',
  '',
  '## Non-functional requirements',
  '- NFR-001: p95 page load under 2 s on the owner machine.',
  '- NFR-002: recovery from a bad deploy within 5 minutes.',
  '- Capacity: 8 GB RAM and 4 CPUs reserved for all environments together.',
  '',
].join('\n');

describe.skipIf(!realEnabled)('devops env-plan (real agent)', () => {
  const results: { ok: boolean; why: string; cost: number }[] = [];

  it.each(Array.from({ length: RUNS }, (_, i) => i + 1))('run %i', async (n) => {
    const { dir, base } = scratchProject({ 'docs/architecture/sad.md': SAD });
    const run = runRealUnit({
      dir,
      role: 'devops',
      kind: 'env-plan',
      item: 'none',
      phase: 2,
      inputs: [{ ref: 'docs/architecture/sad.md', why: 'the architecture and the non-functional requirements' }],
      conditions: ['The profile is solo-lite', 'Preview ports 4100 to 4199; max_previews 3; staging on port 3000'],
      budgetUsd: 1,
      maxTurns: 25,
      runId: `r-20261120-0900-${String(n).padStart(2, '0')}`,
    });
    const problems: string[] = [];
    const collected = await collectReport({ projectDir: dir, runId: run.packetRunId, role: 'devops', kind: 'env-plan', item: 'none', message: run.message });
    if (!collected.ok) problems.push(`report: ${collected.errors.join('; ')}`);
    const doc = path.join(dir, 'docs', 'ops', 'env-matrix.md');
    try {
      const text = readFileSync(doc, 'utf8');
      for (const h of ['## Environment matrix', '## Pipeline design']) if (!text.includes(h)) problems.push(`missing ${h}`);
    } catch {
      problems.push('docs/ops/env-matrix.md was not written');
    }
    problems.push(...gradeDevopsRun(dir, base).map((f) => `${f.grader}: ${f.detail}`));
    if (run.exit !== 0) problems.push(`exit ${run.exit}`);
    if (run.costUsd > 0.5 * 1.5) problems.push(`cost ${run.costUsd} is over 1.5 times the 0.50 estimate`);
    results.push({ ok: problems.length === 0, why: problems.join('; '), cost: run.costUsd });
    expect(problems, `run ${n}`).toEqual([]);
  }, 25 * 60_000);

  it('meets the card threshold (4 of 5; with fewer runs, all of them)', () => {
    const need = RUNS >= 5 ? Math.ceil(RUNS * 0.8) : RUNS;
    expect(results.filter((r) => r.ok).length, JSON.stringify(results)).toBeGreaterThanOrEqual(need);
    console.log(`env-plan: ${results.filter((r) => r.ok).length}/${RUNS} passed, about ${spentUsd().toFixed(2)} USD estimated`);
  });
});
