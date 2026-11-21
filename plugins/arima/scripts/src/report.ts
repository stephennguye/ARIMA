import type { Role } from './ledger.js';
import { describeError, getValidator } from './lib/schema.js';
import type { UnitKind } from './kinds.js';

/** The structured part of an agent report (03-contracts 3.3). Shape is checked by the schema. */
export interface AgentReport {
  schema_version: 1;
  run_id: string;
  role: Role;
  item: string;
  status: 'done' | 'blocked' | 'failed' | 'needs_input';
  summary: string;
  artifacts?: { path: string; kind: string; artifact_id?: string }[];
  outbox_entries?: string[];
  criteria_map?: { criterion: string; status: 'met' | 'unmet' | 'unclear'; evidence: string[] }[];
  verdict?: { result: string; reasons: string[] };
  findings?: Record<string, unknown>[];
  questions?: { blocking: boolean; hard_stop?: string; default?: string }[];
  decisions?: Record<string, unknown>[];
  assumptions?: { text: string; basis: string }[];
  records?: Record<string, unknown>[];
}

/** Where `criteria_map` is required (a unit that has criteria to pass or fail). */
const CRITERIA_REQUIRED: readonly [Role, UnitKind][] = [
  ['developer', 'develop'],
  ['qa', 'qa'],
];
/** Where it is allowed but not required. `skeleton` has no acceptance criteria and is exempt. */
const CRITERIA_OPTIONAL: readonly UnitKind[] = [
  'skeleton',
  'fix',
  'hotfix',
  'regression',
  'test-write',
];

/** Kinds that must end in a verdict, and the results each may use. */
const VERDICT_REQUIRED: Partial<Record<UnitKind, readonly string[]>> = {
  review: ['approve', 'changes_requested'],
  'adr-review': ['approve', 'changes_requested'],
  qa: ['pass', 'fail'],
  regression: ['pass', 'fail'],
  'perf-test': ['pass', 'fail'],
  'a11y-test': ['pass', 'fail'],
  'design-qa': ['pass', 'fail'],
  'security-scan': ['pass', 'fail'],
};
/** Kinds where a verdict is optional. Every other kind produces none and must not return one. */
const VERDICT_OPTIONAL: Partial<Record<UnitKind, readonly string[]>> = {
  meeting: ['go', 'no_go', 'approve', 'changes_requested'],
  'gate-pack': ['go', 'no_go'],
  'verify-finding': ['pass', 'fail'],
  'scan-triage': ['pass', 'fail'],
  screen: ['pass', 'fail'],
  'preview-diagnose': ['pass', 'fail'],
  'uat-script': ['pass', 'fail'],
};

export interface ReportCheck {
  ok: boolean;
  /** Human-readable problems; each names the rule that failed. */
  errors: string[];
  /** Set when the problem is the missing evidence rule, so the run maps to `evidence_missing`. */
  evidenceMissing: boolean;
}

/**
 * Checks a parsed report against the schema and the kind-dependent rules of 03-contracts 3.3.
 * `kind` is the unit's kind; the report itself does not name it.
 */
const EVIDENCE_SHAPE = /^((?:[\w.@/-]+\/)?[\w.@-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?|(?:TC|BUG)-\d+)$/;

export function checkReport(report: unknown, ctx: { role: Role; kind: UnitKind }): ReportCheck {
  const errors: string[] = [];
  let evidenceMissing = false;
  const validate = getValidator('agent-report');
  if (!validate(report)) {
    for (const e of validate.errors ?? []) {
      errors.push(describeError(e));
      if (e.instancePath.includes('criteria_map') && e.keyword === 'minItems')
        evidenceMissing = true;
    }
    return { ok: false, errors, evidenceMissing };
  }
  const r = report as AgentReport;

  if (r.role !== ctx.role)
    errors.push(`role: report says "${r.role}" but the unit's role is "${ctx.role}"`);

  const needsCriteria = CRITERIA_REQUIRED.some(
    ([role, kind]) => role === ctx.role && kind === ctx.kind,
  );
  const mayHaveCriteria = needsCriteria || CRITERIA_OPTIONAL.includes(ctx.kind);
  if (
    needsCriteria &&
    r.status === 'done' &&
    (r.criteria_map === undefined || r.criteria_map.length === 0)
  ) {
    errors.push(`criteria_map: required for ${ctx.role} ${ctx.kind} units`);
  }
  if (!mayHaveCriteria && r.criteria_map !== undefined) {
    errors.push(`criteria_map: not allowed for ${ctx.kind} units`);
  }

  const required = VERDICT_REQUIRED[ctx.kind];
  const optional = VERDICT_OPTIONAL[ctx.kind];
  if (required !== undefined && r.verdict === undefined && r.status === 'done') {
    errors.push(`verdict: required for ${ctx.kind} units`);
  }
  if (required === undefined && optional === undefined && r.verdict !== undefined) {
    errors.push(`verdict: not allowed for ${ctx.kind} units`);
  }
  const allowed = required ?? optional;
  if (allowed !== undefined && r.verdict !== undefined && !allowed.includes(r.verdict.result)) {
    errors.push(
      `verdict.result: "${r.verdict.result}" is not valid for ${ctx.kind} (use ${allowed.join(', ')})`,
    );
  }

  for (const [i, f] of (r.findings ?? []).entries()) {
    if (typeof f['severity'] === 'string' && !severityFits(ctx, f['severity'])) {
      errors.push(
        `findings.${i}.severity: "${f['severity']}" does not fit ${ctx.role} ${ctx.kind} units`,
      );
    }
  }

  // A developer that reports done has met every criterion, with evidence that names something (a
  // file:line, a test case or a bug id); the file and line are resolved when the work is published.
  if (ctx.role === 'developer' && ctx.kind === 'develop' && r.status === 'done') {
    for (const c of r.criteria_map ?? []) {
      if (c.status !== 'met')
        errors.push(
          `criteria_map: "${c.criterion.slice(0, 40)}" is ${c.status}, so the status cannot be done`,
        );
      for (const ev of c.evidence)
        if (!EVIDENCE_SHAPE.test(ev.trim()))
          errors.push(
            `criteria_map: evidence "${ev.slice(0, 40)}" is not file:line, a test case id or a bug id`,
          );
    }
  }
  // QA proves, it does not decide (card 5): no decisions, and a criterion is met only with the id of a test
  // case that ran, a path:line, or an evidence file under tests/.evidence.
  if (ctx.role === 'qa') {
    if ((r.decisions ?? []).length > 0)
      errors.push(
        "decisions: a QA run records no decisions (architecture and design are not QA's)",
      );
    if (r.status === 'done')
      for (const c of r.criteria_map ?? [])
        if (c.status === 'met')
          for (const ev of c.evidence)
            if (
              !EVIDENCE_SHAPE.test(ev.trim()) &&
              !/^NEW-[0-9]+$/.test(ev.trim()) &&
              !/^tests\/\.evidence\/\S+$/.test(ev.trim())
            )
              errors.push(
                `criteria_map: evidence "${ev.slice(0, 40)}" is not a TC id, path:line or tests/.evidence path`,
              );
  }
  if (r.status === 'needs_input' && (r.questions ?? []).length === 0)
    errors.push('status: needs_input needs at least one question');

  // A review's verdict must agree with its own findings: nothing is approved with a blocker or a major
  // finding standing, and a change request names what blocks (tech-lead card, section 4 step 8).
  if (ctx.kind === 'review' && r.verdict !== undefined) {
    const stops = (r.findings ?? []).some(
      (f) => f['severity'] === 'blocker' || f['severity'] === 'major',
    );
    if (r.verdict.result === 'approve' && stops)
      errors.push('verdict: approve is not allowed while a blocker or major finding stands');
    if (r.verdict.result === 'changes_requested' && !stops)
      errors.push('verdict: changes_requested needs at least one blocker or major finding');
  }

  const questions = r.questions ?? [];
  const blockingOpen = questions.some((q) => q.blocking);
  if (r.status === 'done' && blockingOpen) {
    errors.push('status: done is not allowed while a blocking question is unanswered');
  }
  if (r.status === 'blocked' && !questions.some((q) => q.blocking)) {
    errors.push('status: blocked needs at least one blocking question');
  }

  for (const a of r.assumptions ?? []) {
    if (a.basis.trim() === '') errors.push('assumptions: every assumption needs a basis');
  }

  return { ok: errors.length === 0, errors, evidenceMissing };
}

const REVIEW_SEVERITY = ['blocker', 'major', 'minor', 'nit'];
const SECURITY_SEVERITY = ['critical', 'high', 'medium', 'low'];
const BUG_SEVERITY = ['S1', 'S2', 'S3', 'S4'];

/** Review kinds use blocker..nit, security kinds critical..low, bugs S1..S4; others may raise any. */
function severityFits(ctx: { role: Role; kind: UnitKind }, severity: string): boolean {
  if (
    ctx.role === 'security' &&
    ['security-scan', 'scan-triage', 'verify-finding'].includes(ctx.kind)
  )
    return SECURITY_SEVERITY.includes(severity);
  if (ctx.kind === 'review' || ctx.kind === 'adr-review') return REVIEW_SEVERITY.includes(severity);
  if (ctx.kind === 'qa' || ctx.kind === 'regression' || ctx.kind === 'design-qa')
    return BUG_SEVERITY.includes(severity);
  return true;
}
