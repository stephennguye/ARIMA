import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BRIEF_SECTIONS, checkBrief, describeGaps } from './brief.js';
import { validateProject } from './config.js';
import type { ArimaConfig, TeamConfig } from './config.js';
import { appendEvent } from './events.js';
import { ensureNotionSwitch } from './killswitch.js';
import { GATE_CRITERIA, GATE_PHASE } from './gates.js';
import { findSecrets } from './lib/secrets.js';
import { appendLedgerRow, buildLedgerRow } from './ledger.js';
import { mapAndWrite } from './notion/map-file.js';
import { findRow, pullMirror, readMirror } from './notion/mirror.js';
import { enqueue, pushOutbox } from './notion/outbox.js';
import type { OutboxEntry } from './notion/outbox.js';
import type { NotionPort } from './notion/port.js';
import { PREFLIGHT_EXIT, runPreflight } from './preflight.js';
import { enforcedGates, loadProfile, requiredApproverRoles } from './profiles.js';
import type { GateId } from './profiles.js';
import { releaseRunLock } from './runlock.js';
import { issueRunId } from './runid.js';
import { StateError, pushState } from './state.js';

/** Exit codes of `arima-init`; preflight failures keep their own codes (10-14). */
export const INIT_EXIT = {
  ok: 0,
  usage: 2,
  briefGaps: 3,
  mapFailed: 4,
  pushFailed: 5,
  briefSecret: 6,
} as const;

export interface InitOptions {
  projectDir: string;
  briefFile: string;
  port: NotionPort;
  env?: NodeJS.ProcessEnv;
  /** Notion root page (the duplicated template); defaults to notion.root_page_id in arima.yaml. */
  rootPageId?: string;
  now?: Date;
  /** Skip committing .arima/ to the arima-state branch (e.g. not a git repo yet). */
  skipState?: boolean;
  log?: (line: string) => void;
}

export interface InitResult {
  ok: boolean;
  exitCode: number;
  runId?: string;
  gaps: string[];
  created: string[];
  existed: string[];
  problems: string[];
  warnings: string[];
  nextSteps: string[];
}

const fmt = (n: number): string => `$${n}`;

function charter(
  name: string,
  arima: ArimaConfig,
  team: TeamConfig,
  brief: Record<string, string>,
): string {
  const a = arima as unknown as {
    project: { key: string; client: string };
    profile: string;
    budget: { project_cap: number };
  };
  const raci = Object.entries(team.roles).map(([role, r]) => {
    const who =
      r.type === 'human'
        ? `human: ${team.people[r.person ?? '']?.name ?? r.person}`
        : `agent${r.count ? ` x${r.count}` : ''}`;
    return `- ${role}: ${who}`;
  });
  return [
    `# Charter: ${name}`,
    '',
    `Project ${a.project.key} for ${a.project.client}. Profile: ${a.profile}. Skeleton drafted by the orchestrator from the brief; the sponsor reviews it at G0.`,
    '',
    '## Scope',
    '### In scope (must-have features)',
    brief['Must-have features'] ?? 'None',
    '### Out of scope',
    brief['Out of scope'] ?? 'None',
    '',
    '## Goals and KPIs',
    brief['Goals and KPIs'] ?? 'None',
    '',
    '## Rough milestones',
    'To be proposed after G0. Milestones of 8-12 points are planned in Phase 2.',
    '',
    '## Budget plan',
    `Project cap ${fmt(a.budget.project_cap)} (estimated consumption). See the Budget plan document.`,
    '',
    '## Risks',
    brief['Known risks'] ?? 'None',
    '',
    '## Roles and responsibilities (from team.yaml)',
    ...raci,
    '',
  ].join('\n');
}

function budgetPlan(arima: ArimaConfig): string {
  const b = (
    arima as unknown as {
      budget: {
        currency: string;
        project_cap: number;
        daily_cap: number;
        per_story_default: number;
        per_run_cap: number;
        by_size?: Record<string, number>;
        alert_thresholds: number[];
      };
    }
  ).budget;
  const sizes = b.by_size ?? { S: 1, M: 3, L: 6 };
  return [
    '# Budget plan',
    '',
    `All amounts are estimated USD consumption, not money spent (spec §4.4, §13.6).`,
    '',
    '## Caps',
    `- Project cap: ${fmt(b.project_cap)}`,
    `- Daily cap: ${fmt(b.daily_cap)}`,
    `- Per-run cap: ${fmt(b.per_run_cap)}`,
    `- Default per story: ${fmt(b.per_story_default)}`,
    '',
    '## Story budgets by size',
    ...Object.entries(sizes).map(([k, v]) => `- ${k}: ${fmt(v)}`),
    '',
    '## Alerts',
    `Alerts at ${b.alert_thresholds.map((t) => `${Math.round(t * 100)}%`).join(', ')} of each budget.`,
    '',
    '## Infrastructure and hosting',
    'To be estimated by the architect at Phase 2 (hosting cost estimate).',
    '',
  ].join('\n');
}

function evidencePack(
  gate: GateId,
  name: string,
  runId: string,
  date: string,
  approvers: string,
  checked: ReadonlySet<string>,
): string {
  return [
    `# ${gate} evidence pack: ${name}`,
    '',
    `Prepared by orchestrator run ${runId} on ${date}. Approvers: ${approvers}.`,
    'Decision: Not ready.',
    '',
    '## Criteria checklist',
    ...GATE_CRITERIA[gate].map((c) => `- [${checked.has(c) ? 'x' : ' '}] ${c}`),
    '',
    '## Artifact links',
    'None yet.',
    '',
    '## Open risks',
    'None recorded yet.',
    '',
    '## Known issues',
    'None.',
    '',
    '## Agent recommendation',
    'Not ready: the criteria above are not all met.',
    '',
    '## Cost and time to date',
    'See the Cost log.',
    '',
  ].join('\n');
}

/**
 * `/arima:init` end to end (spec §6.0, v0.1): check the brief, validate config, preflight and
 * lock, map the Notion workspace, write the brief, charter skeleton, budget plan and the gate
 * pages through the outbox, leave a ledger row and events, and commit state. Re-runnable: rows
 * that already exist are left alone.
 */
export async function runInit(o: InitOptions): Promise<InitResult> {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? new Date();
  const result: InitResult = {
    ok: false,
    exitCode: INIT_EXIT.usage,
    gaps: [],
    created: [],
    existed: [],
    problems: [],
    warnings: [],
    nextSteps: [],
  };

  // 1. brief
  const briefText = readFileSync(o.briefFile, 'utf8');
  // The brief is published to Notion and read by agents, so a pasted credential must stop here.
  const leaked = findSecrets(briefText);
  if (leaked.length > 0) {
    result.problems = [
      `the brief looks like it contains a secret (${leaked.join(', ')}); remove it and keep credentials out of the brief`,
    ];
    result.exitCode = INIT_EXIT.briefSecret;
    return result;
  }
  const brief = checkBrief(briefText);
  if (!brief.ok) {
    result.gaps = describeGaps(brief);
    result.exitCode = INIT_EXIT.briefGaps;
    return result;
  }
  log('brief complete');

  // 2. config
  const cfg = validateProject(o.projectDir);
  if (!cfg.ok || cfg.arima === undefined || cfg.team === undefined) {
    result.problems = cfg.errors.map((e) => `${path.basename(e.file)}:${e.line}: ${e.message}`);
    result.exitCode = PREFLIGHT_EXIT.config;
    return result;
  }
  log('config valid');
  const arima = cfg.arima;
  const team = cfg.team;
  const raw = arima as unknown as {
    project: { name: string };
    notion: { root_page_id: string };
    github: { state_branch: string; default_branch: string; allow_public_state?: boolean };
  };
  const name = raw.project.name;
  const root = o.rootPageId ?? raw.notion.root_page_id;

  // The Notion kill switch must exist (a missing one reads as paused). Creating it unchecked never
  // changes an existing switch. If Notion is down, the preflight below reports it.
  try {
    await ensureNotionSwitch(o.port, root);
  } catch {
    /* reported by the preflight */
  }

  // 3. run id, preflight and lock
  const runId = await issueRunId(o.projectDir, now);
  result.runId = runId;
  const pre = await runPreflight({
    projectDir: o.projectDir,
    ...(o.env ? { env: o.env } : {}),
    notion: o.port,
    acquireFor: runId,
    now,
  });
  if (!pre.ok) {
    result.problems = pre.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`);
    result.exitCode = pre.exitCode;
    return result;
  }
  for (const c of pre.checks) if (c.warning) result.warnings.push(`${c.check}: ${c.warning}`);
  log(`preflight ok, run ${runId}`);

  const started = Date.now();
  await appendEvent(o.projectDir, {
    type: 'run.start',
    actor: 'orchestrator',
    run_id: runId,
    data: { command: 'init', phase: 0 },
  });
  let failure: { code: number; message: string } | undefined;
  try {
    // 4. map the workspace
    const mapped = await mapAndWrite(o.projectDir, o.port, root, { now });
    for (const i of mapped.result.issues) {
      if (i.severity === 'warning')
        result.warnings.push(`${i.database}${i.property ? `.${i.property}` : ''}: ${i.detail}`);
    }
    if (mapped.result.map === undefined) {
      const errs = mapped.result.issues.filter((i) => i.severity === 'error');
      result.problems = errs.map(
        (i) => `${i.database}${i.property ? `.${i.property}` : ''}: ${i.detail}`,
      );
      failure = {
        code: INIT_EXIT.mapFailed,
        message:
          'the Notion workspace does not match the ARIMA template (try: arima-notion map --migrate)',
      };
      throw new Error(failure.message);
    }
    const map = mapped.result.map;
    log(`mapped ${Object.keys(map.databases).length} databases`);

    // 5. mirror, then plan only what is missing
    await pullMirror(o.projectDir, o.port, map, { now, runId });
    // Entries left over from an earlier, interrupted run go first, so a re-run never queues duplicates.
    const leftover = await pushOutbox(o.projectDir, o.port, map, {
      now,
      allowStatusWrites: true,
    });
    for (const r of leftover.rejected)
      result.warnings.push('earlier outbox entry ' + r.id + ' was rejected: ' + r.reason);
    const profile = loadProfile((arima as unknown as { profile: string }).profile);
    const approverNames = (gate: GateId): string =>
      (profile.gates[gate]?.approvers ?? [])
        .map((role) => {
          const r = team.roles[role];
          return r?.type === 'human' ? (team.people[r.person ?? '']?.name ?? role) : role;
        })
        .join(', ');

    const date = now.toISOString().slice(0, 10);
    let n = 0;
    const entry = (
      e: Pick<OutboxEntry, 'op' | 'database' | 'properties' | 'content_markdown'>,
    ): void => {
      n += 1;
      enqueue(o.projectDir, {
        id: `init-${runId}-${String(n).padStart(2, '0')}`,
        created_at: new Date(now.getTime() + n).toISOString(),
        run_id: runId,
        role: 'orchestrator',
        ...e,
      });
    };
    const exists = (db: 'documents' | 'gates', id: string): boolean =>
      findRow(readMirror(o.projectDir, db), id) !== undefined;
    const doc = (title: string, type: string, owner: string, body: string): void => {
      if (exists('documents', title)) return void result.existed.push(title);
      entry({
        op: 'create',
        database: 'documents',
        properties: {
          Title: title,
          Type: type,
          Phase: 0,
          'Owner role': owner,
          Version: '0.1',
          Status: 'Draft',
          Master: 'Notion',
        },
        content_markdown: body,
      });
      result.created.push(title);
    };

    doc('Project brief', 'Project brief', 'human', readFileSync(o.briefFile, 'utf8'));
    doc(
      'Charter',
      'Charter',
      'orchestrator',
      charter(name, arima, team, brief.sections as Record<string, string>),
    );
    doc('Budget plan', 'Budget plan', 'orchestrator', budgetPlan(arima));

    const g0Done = new Set(['Brief complete (checked against the brief template)', 'Budget plan']);
    for (const gate of enforcedGates(profile)) {
      const title = gate;
      if (exists('gates', title)) {
        result.existed.push(`${gate} gate page`);
        continue;
      }
      entry({
        op: 'create',
        database: 'gates',
        properties: { Gate: gate, Phase: GATE_PHASE[gate], Status: 'Not ready' },
        content_markdown: evidencePack(
          gate,
          name,
          runId,
          date,
          approverNames(gate) || 'unassigned',
          gate === 'G0' ? g0Done : new Set(),
        ),
      });
      result.created.push(`${gate} gate page`);
    }

    // 6. apply
    const report = await pushOutbox(o.projectDir, o.port, map, { now, allowStatusWrites: true });
    if (report.rejected.length + report.conflicts.length + report.deferred.length > 0) {
      result.problems = [
        ...report.rejected.map((r) => `${r.id}: ${r.reason}`),
        ...report.conflicts.map((c) => `${c}: conflict`),
        ...report.deferred.map(
          (d) => `${d}: deferred (Notion unavailable); re-run /arima:init to retry`,
        ),
      ];
      failure = { code: INIT_EXIT.pushFailed, message: 'some Notion writes did not apply' };
      throw new Error(failure.message);
    }
    log(`created ${result.created.length}, already present ${result.existed.length}`);

    // 7. what a human must do
    const roles = requiredApproverRoles(profile);
    result.nextSteps.push(
      `Open each gate page in Notion and set Approvers (${roles.join(', ')}); agents cannot write that field.`,
      'The feasibility note and compliance screen are produced by the architect and security agents (arriving in v0.3); G0 stays "Not ready" until they exist.',
      'Review the charter skeleton and budget plan, then run /arima:status.',
    );
    result.ok = true;
    result.exitCode = INIT_EXIT.ok;
  } catch (e) {
    if (failure === undefined) {
      failure = { code: INIT_EXIT.pushFailed, message: e instanceof Error ? e.message : String(e) };
      result.problems.push(failure.message);
    }
    result.exitCode = failure.code;
  } finally {
    // 8. every run leaves a ledger row and an end event; free the lock
    const ok = result.ok;
    const row = buildLedgerRow(
      {
        type: 'result',
        subtype: 'interactive',
        is_error: !ok,
        duration_ms: Date.now() - started,
        num_turns: 0,
        total_cost_usd: 0,
      },
      {
        run_id: runId,
        date: now.toISOString().slice(0, 10),
        started_at: now.toISOString(),
        project: (arima as unknown as { project: { key: string } }).project.key,
        phase: 0,
        item: 'none',
        role: 'orchestrator',
        attempt: 1,
        is_rework: false,
        budget_usd: 0,
        result: ok ? 'pass' : 'error',
      },
    );
    await appendLedgerRow(o.projectDir, row);
    await appendEvent(o.projectDir, {
      type: 'run.end',
      actor: 'orchestrator',
      run_id: runId,
      data: { command: 'init', result: row.result },
    });
    releaseRunLock(o.projectDir, runId);
  }

  // 9. commit state (after the ledger row and end event, so they are part of it)
  if (result.ok && o.skipState !== true) {
    try {
      const s = await pushState({
        projectDir: o.projectDir,
        runId,
        branch: raw.github.state_branch,
        defaultBranch: raw.github.default_branch,
        ...(raw.github.allow_public_state === true ? { allowPublic: true } : {}),
      });
      for (const w of s.warnings) result.warnings.push(w);
      log(
        s.committed
          ? `state committed${s.pushed ? ' and pushed' : ' (no remote yet)'}`
          : 'state unchanged',
      );
      if (!s.pushed)
        result.warnings.push(
          'state was committed locally; add a git remote and re-run `arima-state push` to publish it',
        );
    } catch (e) {
      result.warnings.push(
        `state not saved: ${e instanceof StateError || e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  void BRIEF_SECTIONS;
  return result;
}
