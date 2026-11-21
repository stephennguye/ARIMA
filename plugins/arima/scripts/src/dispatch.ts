import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from './config.js';
import type { TeamConfig } from './config.js';
import {
  TURN_CAPS,
  QA_SPARSE,
  REVIEW_KINDS,
  needsWorktree,
  outputContractFor,
  taskFor,
  turnCap,
} from './dispatch-units.js';
import { appendEvent, readEvents } from './events.js';
import { applyHumanInputs } from './inbox.js';
import { mirrorStatus, moveItem } from './item-status.js';
import type { Size } from './item.js';
import { checkKillSwitch } from './killswitch.js';
import type { Role } from './ledger.js';
import { mergePr, summariseChecks, verdictAfterLastPush } from './merge.js';
import { buildDigest, publishDigest } from './digest.js';
import { applyApprovedLessons, overrideConditions } from './lessons.js';
import { heldForReview, reviewTick } from './milestone-review.js';
import { sendNotifications } from './notify.js';
import { enqueue } from './notion/outbox.js';
import { enqueueReportRecords } from './notion/proposals.js';
import { findRow, pullMirror, readMirror, readNotionMap } from './notion/mirror.js';
import type { NotionPort } from './notion/port.js';
import { pushOutbox } from './notion/outbox.js';
import { settingsFrom, stagingFailing } from './env.js';
import type { EnvDeps, EnvSettings } from './env.js';
import {
  branchSha,
  ensurePreviews,
  failedPreviews,
  previewHealthy,
  previewOf,
  previewUrl,
  previewsPossible,
  removePreview,
  sweepPreviews,
} from './preview.js';
import { renderPacket } from './packet.js';
import { reviewContext } from './review-context.js';
import { QaTestsError, adoptQaTests, qaTipOf } from './qa-tests.js';
import type { PacketInput } from './packet.js';
import { PREFLIGHT_EXIT, runPreflight } from './preflight.js';
import { loadProfile } from './profiles.js';
import type { Profile } from './profiles.js';
import { renderPrBody } from './pr-body.js';
import { ENGINE_STATUS_PREFIX } from './item-status.js';
import { postReview, publishBranch } from './publish.js';
import type { GhRunner } from './publish.js';
import { planDay, storiesFromMirror } from './queue.js';
import type { PlanLimits, PlannedUnit, StoryFacts } from './queue.js';
import { expireQuestions, raiseQuestions, readQuestions } from './questions.js';
import type { QuestionPolicy } from './questions.js';
import type { AgentReport } from './report.js';
import { releaseRunLock } from './runlock.js';
import { issueRunId } from './runid.js';
import { DispatchRefused, agentConfigFrom, runUnit } from './run-agent.js';
import type { AgentConfig, UnitOutcome } from './run-agent.js';
import { pushState } from './state.js';
import { recordStoryBudgetHit, storyBudgetFromMirror, unitBudget } from './story-budget.js';
import {
  branchFor,
  createWorktree,
  pruneWorktrees,
  removeWorktree,
  worktreePath,
} from './worktree.js';
import { costAlerts, recordCostAlerts, storyMetas, syncCostLog } from './cost.js';
import { readLedger } from './ledger.js';
import type { UnitKind } from './kinds.js';

/**
 * The dispatcher (spec 7.2, 14; F02; WP-120): the deterministic program behind the daily run. It
 * performs the ten steps in fixed order; every step is code except the work inside a dispatched
 * run. `phase.step_done` events mark the steps, so the order is on record.
 */

export const DISPATCH_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  nothing: 4,
  phase: 5,
  config: PREFLIGHT_EXIT.config,
  locked: PREFLIGHT_EXIT.locked,
  killSwitch: PREFLIGHT_EXIT.killSwitch,
  budget: PREFLIGHT_EXIT.budget,
  env: PREFLIGHT_EXIT.env,
  paused: 75,
} as const;

export const STEPS = [
  'preflight',
  'sync_in',
  'apply_inputs',
  'plan',
  'dispatch',
  'meetings',
  'gates',
  'hard_stops',
  'sync_out',
  'close',
] as const;

export interface GithubFacts {
  /** Open pull request whose checks are all green. */
  prReady(item: string): Promise<boolean>;
  ciRedOnMain(): Promise<boolean>;
  prsAwaitingHuman(): Promise<number>;
}

export const noGithubFacts: GithubFacts = {
  prReady: () => Promise.resolve(false),
  ciRedOnMain: () => Promise.resolve(false),
  prsAwaitingHuman: () => Promise.resolve(0),
};

export interface DispatchDeps {
  claudeBin?: string;
  killSwitchPollMs?: number;
  /** Notion access; null means Notion is not configured (the run is degraded). */
  notion?: { port: NotionPort } | null;
  github?: GithubFacts;
  gh?: GhRunner;
  token?: string | undefined;
  /** `gated` mode: confirm each unit; false skips it. */
  confirm?: (unit: PlannedUnit) => Promise<boolean>;
  /** The Phase 3 exit checklist (`arima-setup check`, F07, not built yet). */
  setupCheck?: () => { green: boolean; detail: string };
  /** After a merge: rebuild staging (arima-env, WP-213). */
  afterMerge?: (info: { item: string; sha: string }) => Promise<void>;
  /** Whether a story's preview is up (WP-218). Defaults to the recorded smoke result of its preview. */
  previewReady?: (item: string) => boolean;
  /** Dependencies of the arima-env calls (previews): a stub exec in tests. */
  envDeps?: EnvDeps;
  skipState?: boolean;
  /** Overrides the push URL of publish (tests). */
  remoteUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Variables handed to every role run as given, on top of the allow-list (stub agents in tests). */
  extraEnv?: Record<string, string>;
  now?: Date;
  log?: (line: string) => void;
}

export interface DispatchOptions {
  projectDir: string;
  dryRun?: boolean;
  /** Limit step 4 to the units of one item. Bypasses only the rank order, never a guard (RD-F02-5). */
  only?: string;
  /** `assisted` mode: the hash of the plan the human confirmed. */
  yesPlan?: string;
  deps?: DispatchDeps;
}

export interface UnitResult {
  unit: PlannedUnit;
  runId?: string;
  result: string;
  reason?: string;
  blocked?: boolean;
  note?: string;
}

export interface DispatchResult {
  exitCode: number;
  runId?: string;
  planHash?: string;
  plan: PlannedUnit[];
  skipped: { rankName: string; item: string; reason: string }[];
  dispatched: UnitResult[];
  warnings: string[];
  degraded: boolean;
  message?: string;
}

export const planHash = (units: readonly PlannedUnit[]): string =>
  createHash('sha256')
    .update(JSON.stringify(units.map((u) => [u.rank, u.kind, u.role, u.item, u.reviewer ?? 0])))
    .digest('hex')
    .slice(0, 12);

type Cfg = {
  profile: string;
  autonomy: { mode: 'assisted' | 'gated' | 'autonomous'; question_policy: QuestionPolicy };
  parallelism?: { max_developer_agents?: number };
  review?: { max_prs_awaiting_human?: number };
  environments?: { staging?: { url?: string } };
  budget: {
    per_story_default: number;
    by_size?: { S?: number; M?: number; L?: number };
    per_run_cap: number;
  };
  github: {
    repo: string;
    default_branch: string;
    state_branch: string;
    allow_unchecked_remote?: boolean;
  };
  notion: { root_page_id: string };
  schedule: { max_run_minutes: number };
};

const PHASE4_GATE = (p: Profile): 'G2' | 'G1' => (p.gates.G2 !== undefined ? 'G2' : 'G1');

/** The phase check (D-46): Phase 4 and operations only. Reads the Gates mirror until WP-330. */
export function phaseCheck(
  projectDir: string,
  profile: Profile,
  setup: { green: boolean; detail: string },
): { ok: true; warning?: string } | { ok: false; command: string; message: string } {
  const gate = PHASE4_GATE(profile);
  const row = findRow(readMirror(projectDir, 'gates'), gate);
  const status = row?.properties['Status'];
  const approved = status === 'Approved' || status === 'Approved with conditions';
  const g3 = findRow(readMirror(projectDir, 'gates'), 'G3')?.properties['Status'];
  if (g3 === 'Approved' || g3 === 'Approved with conditions')
    return {
      ok: false,
      command: '/arima:release',
      message:
        'G3 is approved: the release candidate is past Phase 4. /arima:run does not dispatch Phase 5 or 6 work (D-46).',
    };
  if (row !== undefined && !approved) {
    const cmd = gate === 'G2' ? '/arima:design' : '/arima:discover';
    return {
      ok: false,
      command: cmd,
      message: `${gate} is "${String(status)}", so the project is not in Phase 4 yet. Run ${cmd}.`,
    };
  }
  if (!setup.green)
    return {
      ok: false,
      command: '/arima:setup',
      message: `the Phase 3 exit checklist is not green (${setup.detail}). Run /arima:setup.`,
    };
  return row === undefined
    ? {
        ok: true,
        warning: `no ${gate} gate row was found; entering Phase 4 on the setup checklist only`,
      }
    : { ok: true };
}

const sizeOf = (projectDir: string, item: string): Size | undefined => {
  const s = findRow(readMirror(projectDir, 'stories'), item)?.properties['Complexity'];
  return s === 'S' || s === 'M' || s === 'L' ? s : undefined;
};

/**
 * Runs the daily run. Returns the result instead of exiting, so tests can inspect it; the CLI
 * maps `exitCode` to the process exit.
 */
export async function runDispatch(o: DispatchOptions): Promise<DispatchResult> {
  const d = o.deps ?? {};
  const now = d.now ?? new Date();
  const log = d.log ?? (() => undefined);
  const env = d.env ?? process.env;
  const dry = o.dryRun === true;
  const res: DispatchResult = {
    exitCode: 0,
    plan: [],
    skipped: [],
    dispatched: [],
    warnings: [],
    degraded: false,
  };
  /** Per item: why an approve of the review being run cannot be trusted (empty when it can). */
  const unapprovableReviews = new Map<string, string[]>();
  const fail = (code: number, message: string): DispatchResult => ({
    ...res,
    exitCode: code,
    message,
  });

  // ---- 1. Preflight and phase check -------------------------------------------------------
  const cfgResult = validateProject(o.projectDir);
  if (!cfgResult.ok || cfgResult.arima === undefined || cfgResult.team === undefined)
    return fail(
      DISPATCH_EXIT.config,
      cfgResult.errors.map((e) => `${path.basename(e.file)}:${e.line}: ${e.message}`).join('\n'),
    );
  const cfg = cfgResult.arima as unknown as Cfg;
  const team = cfgResult.team as TeamConfig;
  const profile = loadProfile(cfg.profile);
  if (o.only !== undefined && !/^(US|BUG|INC|CR|MS)-\d+$/.test(o.only))
    return fail(DISPATCH_EXIT.usage, `--only "${o.only}" is not an item id`);
  if (
    !dry &&
    cfg.autonomy.mode !== 'autonomous' &&
    cfg.autonomy.mode === 'assisted' &&
    o.yesPlan === undefined
  )
    return fail(
      DISPATCH_EXIT.usage,
      'autonomy.mode is assisted: run with --dry-run, show the plan to the human, then run again with --yes-plan <hash>',
    );

  const runId = dry ? 'dry-run' : await issueRunId(o.projectDir, now);
  const pre = await runPreflight({
    projectDir: o.projectDir,
    env,
    notion: d.notion === undefined ? null : (d.notion?.port ?? null),
    ...(dry ? {} : { acquireFor: runId }),
    now,
    record: !dry,
    needs: { github: true },
  });
  if (!pre.ok) {
    const envCheck = pre.checks.find((c) => c.check === 'env' && !c.ok);
    if (envCheck && !dry)
      await appendEvent(o.projectDir, {
        type: 'hardstop.hit',
        actor: 'system',
        data: { stop: 'missing_credential', message: envCheck.detail },
      });
    return fail(
      pre.exitCode,
      pre.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.check}: ${c.detail}`)
        .join('\n'),
    );
  }
  if (!dry) res.runId = runId;
  const step = async (n: number, extra: Record<string, unknown> = {}): Promise<void> => {
    if (!dry)
      await appendEvent(o.projectDir, {
        type: 'phase.step_done',
        actor: 'orchestrator',
        run_id: runId,
        data: { step: n, name: STEPS[n - 1], ...extra },
      });
  };

  try {
    const setup = d.setupCheck?.() ?? {
      green: true,
      detail: 'arima-setup is not built yet; the Phase 3 checklist was not checked',
    };
    if (d.setupCheck === undefined) res.warnings.push(setup.detail);
    const phase = phaseCheck(o.projectDir, profile, setup);
    if (!phase.ok) {
      if (!dry)
        await appendEvent(o.projectDir, {
          type: 'preflight.fail',
          actor: 'system',
          data: { check: 'phase', detail: phase.message, reason: 'phase_refused' },
        });
      return fail(DISPATCH_EXIT.phase, `${phase.message} (exit 5: ${phase.command})`);
    }
    if (phase.warning) res.warnings.push(phase.warning);
    if (!dry)
      await appendEvent(o.projectDir, {
        type: 'run.start',
        actor: 'orchestrator',
        run_id: runId,
        data: { command: 'dispatch', phase: 4 },
      });
    await step(1);

    // ---- 2. Sync in ---------------------------------------------------------------------------
    const gh = d.github ?? noGithubFacts;
    if (!dry) {
      if (d.notion === undefined || d.notion === null) {
        res.degraded = true;
        res.warnings.push(
          'Notion is not configured here: the run is degraded (finish in-flight work only)',
        );
      } else {
        try {
          await pullMirror(o.projectDir, d.notion.port, readNotionMap(o.projectDir), {
            now,
            runId,
          });
        } catch (e) {
          res.degraded = true;
          res.warnings.push(
            `the Notion pull failed (${e instanceof Error ? e.message : String(e)}): the run is degraded, using the older mirror`,
          );
        }
      }
    }
    await step(2, { degraded: res.degraded });

    // ---- 3. Apply human inputs ------------------------------------------------------------------
    if (!dry && !res.degraded) {
      const budgetOk = (item: string): boolean =>
        unitBudget(
          o.projectDir,
          item,
          storyBudgetFromMirror(o.projectDir, item, {
            perStoryDefault: cfg.budget.per_story_default,
            ...(cfg.budget.by_size ? { bySize: cfg.budget.by_size } : {}),
          }),
          cfg.budget.per_run_cap,
        ).ok;
      const inbox = await applyHumanInputs({
        projectDir: o.projectDir,
        runId,
        team,
        profile,
        now,
        budgetAvailable: budgetOk,
      });
      const exp = await expireQuestions({
        projectDir: o.projectDir,
        runId,
        now,
        budgetAvailable: budgetOk,
      });
      await step(3, {
        gates: inbox.gates.length,
        answered: inbox.answered.length,
        vetoes: inbox.vetoes.length,
        expired: exp.tookDefault.length,
      });
    } else await step(3, { skipped: dry ? 'dry run' : 'degraded' });

    if (!dry && !res.degraded) {
      await advanceByFacts();
      await refreshPreviews();
      // WP-217: approved lessons become overrides; a milestone whose stories are all accepted gets its review
      // (a veto row per story), and an open one closes after its window. Then what is not held is accepted.
      try {
        await applyApprovedLessons({ projectDir: o.projectDir, runId, now });
        await reviewTick({
          projectDir: o.projectDir,
          runId,
          now,
          ...(cfg.environments?.staging?.url ? { stagingUrl: cfg.environments.staging.url } : {}),
        });
      } catch (e) {
        res.warnings.push(
          `the milestone review step failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
        );
      }
      await autoAccept();
    }

    // ---- 4. Plan the day ----------------------------------------------------------------------------
    const stories: StoryFacts[] = storiesFromMirror(o.projectDir, {
      perStoryDefault: cfg.budget.per_story_default,
      ...(cfg.budget.by_size ? { bySize: cfg.budget.by_size } : {}),
      perRunCap: cfg.budget.per_run_cap,
    });
    for (const s of stories) {
      const prReady =
        (s.status === 'In Review' || s.status === 'In QA') && (await gh.prReady(s.id));
      if (prReady) s.prReady = true;
      if (s.status === 'In QA' && verdictAfterLastPush(o.projectDir, s.id, 'qa', 'qa') === 'pass')
        s.qaPassed = true;
    }
    const developers = Math.max(
      1,
      Math.min(cfg.parallelism?.max_developer_agents ?? 1, team.roles['developer']?.count ?? 1),
    );
    const limits: PlanLimits = {
      maxDevelopers: developers,
      maxPrsAwaitingHuman: cfg.review?.max_prs_awaiting_human ?? 5,
      prsAwaitingHuman: await gh.prsAwaitingHuman(),
      reviewers: profile.rules.code_review.reviewers >= 2 ? 2 : 1,
    };
    let plan = planDay(
      {
        stories,
        ciRedOnMain: await gh.ciRedOnMain(),
        stagingSmokeFailing: stagingFailing(o.projectDir) !== undefined,
        previewsFailing: failingPreviewItems(),
      },
      limits,
    );
    // A degraded run finishes in-flight work only: no new story starts (RD-F02-7).
    if (res.degraded)
      plan = { units: plan.units.filter((u) => u.rank <= 5), skipped: plan.skipped };
    if (o.only !== undefined) {
      if (!stories.some((s) => s.id === o.only) && !/^(INC|CR|MS)-/.test(o.only))
        return fail(DISPATCH_EXIT.usage, `${o.only} is not in the Notion mirror`);
      plan = {
        units: plan.units.filter((u) => u.item === o.only),
        skipped: plan.skipped.filter((s) => s.item === o.only),
      };
    }
    const unsupported = plan.units.filter((u) => !(u.kind in TURN_CAPS));
    if (unsupported.length > 0)
      return fail(DISPATCH_EXIT.usage, `no turn cap for kind ${unsupported[0]?.kind}`);
    res.plan = plan.units;
    res.skipped = plan.skipped;
    res.planHash = planHash(plan.units);
    await step(4, { units: plan.units.length, plan_hash: res.planHash });
    if (dry) {
      res.exitCode = plan.units.length === 0 ? DISPATCH_EXIT.nothing : DISPATCH_EXIT.ok;
      return res;
    }
    if (cfg.autonomy.mode === 'assisted' && o.yesPlan !== res.planHash)
      return fail(
        DISPATCH_EXIT.usage,
        `the plan changed since it was confirmed (now ${res.planHash}); show it again and confirm`,
      );

    // ---- 5. Dispatch runs -----------------------------------------------------------------------------
    const policy = cfg.autonomy.question_policy;

    // A story whose budget is used up is skipped by the planner; the human must hear about it once: a
    // story_budget hard stop and a blocking question (spec 11.1, 13.5), never a silent stall.
    for (const sk of plan.skipped.filter((x) => x.reason === 'story budget used up')) {
      if (!/^US-\d+$/.test(sk.item) || mirrorStatusOf(sk.item) === 'Blocked') continue;
      await appendEvent(o.projectDir, {
        type: 'hardstop.hit',
        actor: 'system',
        run_id: runId,
        item: sk.item,
        data: { stop: 'story_budget', message: `${sk.item} has used its story budget` },
      });
      await blockWithQuestion(
        {
          kind: 'develop',
          role: 'orchestrator',
          item: sk.item,
          why: 'story budget used up',
        } as PlannedUnit,
        `${sk.item} has used its story budget (see the cost so far in the digest). Options: raise its Budget USD, split the story, or cancel it.`,
        'story_budget',
      );
    }

    let stop = false;
    for (const unit of plan.units) {
      if (stop) break;
      if (cfg.autonomy.mode === 'gated' && d.confirm !== undefined && !(await d.confirm(unit))) {
        res.dispatched.push({ unit, result: 'skipped', note: 'not confirmed' });
        continue;
      }
      const r = await dispatchUnit(unit);
      res.dispatched.push(r);
      if (r.result === 'paused') stop = true;
    }

    async function dispatchUnit(unit: PlannedUnit): Promise<UnitResult> {
      const size = sizeOf(o.projectDir, unit.item);
      const cap = turnCap(unit.kind, size);
      if (cap === undefined) return { unit, result: 'skipped', note: 'no model run for this kind' };
      const story = /^US-\d+$/.test(unit.item);
      const config: AgentConfig = {
        ...agentConfigFrom(
          cfgResult.arima as unknown as Record<string, unknown>,
          unit.role as Role,
        ),
      };
      let budgetUsd = config.perRunCap;
      let storyBudgetUsd: number | undefined;
      if (story) {
        storyBudgetUsd = storyBudgetFromMirror(o.projectDir, unit.item, {
          perStoryDefault: cfg.budget.per_story_default,
          ...(cfg.budget.by_size ? { bySize: cfg.budget.by_size } : {}),
        });
        const ub = unitBudget(o.projectDir, unit.item, storyBudgetUsd, config.perRunCap);
        if (!ub.ok) {
          const message = await recordStoryBudgetHit(o.projectDir, unit.item, ub, unit.role);
          await blockWithQuestion(
            unit,
            `${message}. Options: raise the story budget, re-scope the story, or cancel it.`,
            'story_budget',
          );
          return { unit, result: 'blocked', reason: 'story_budget', blocked: true };
        }
        budgetUsd = ub.budgetUsd;
      }

      // A new story goes Ready -> In Progress first (the guards of contracts section 9).
      if (unit.kind === 'develop' && story && mirrorStatus(o.projectDir, unit.item) === 'Ready') {
        const row = storiesFromMirror(o.projectDir, {
          perStoryDefault: cfg.budget.per_story_default,
          perRunCap: cfg.budget.per_run_cap,
        }).find((x) => x.id === unit.item);
        const moved = await moveItem({
          projectDir: o.projectDir,
          item: unit.item,
          to: 'In Progress',
          actor: 'orchestrator',
          runId,
          now,
          facts: {
            guards: {
              test_cases_exist: (row?.testCases ?? 0) > 0,
              story_budget_available: true,
              wip_ok: true,
            },
            budget_available: true,
          },
        });
        if (!moved.ok) return { unit, result: 'skipped', note: moved.message };
      }

      // The worktree (a rework unit starts from the story branch).
      const branch =
        unit.item === 'none'
          ? ''
          : unit.kind === 'qa' || unit.kind === 'test-write'
            ? `qa/${unit.item}-tests`
            : branchFor(unit.item, titleOf(unit.item));
      let cwd = o.projectDir;
      const makeWorktree = async (): Promise<void> => {
        if (!needsWorktree(unit.kind, unit.role as Role) || unit.item === 'none') return;
        await removeWorktree({
          projectDir: o.projectDir,
          branch,
          defaultBranch: cfg.github.default_branch,
          stateBranch: cfg.github.state_branch,
        }).catch(() => undefined);
        const reuse = branchExists(o.projectDir, branch);
        const base =
          unit.kind === 'qa' || unit.kind === 'test-write'
            ? (storyBranchOf(unit.item) ?? cfg.github.default_branch)
            : cfg.github.default_branch;
        const c = await createWorktree({
          projectDir: o.projectDir,
          branch,
          base,
          runId,
          defaultBranch: cfg.github.default_branch,
          stateBranch: cfg.github.state_branch,
          ...(reuse ? { reuse: true } : {}),
          ...(unit.kind === 'qa' || unit.kind === 'test-write' ? { sparse: [...QA_SPARSE] } : {}),
        });
        cwd = c.path;
      };
      try {
        await makeWorktree();
      } catch (e) {
        res.warnings.push(
          `${unit.kind} ${unit.item}: could not create the worktree: ${e instanceof Error ? e.message : String(e)}`,
        );
        return { unit, result: 'error', reason: 'guard_blocked', note: 'worktree' };
      }

      let outcome: UnitOutcome;
      try {
        outcome = await runUnit(
          {
            projectDir: o.projectDir,
            role: unit.role as Role,
            item: unit.item,
            budgetUsd,
            maxTurns: cap,
            promptFile: '',
            phase: 4,
            cwd,
            kind: unit.kind,
            config,
            killSwitch: { notion: null },
            ...(unit.reworkReason ? { reworkReason: unit.reworkReason } : {}),
            ...(storyBudgetUsd !== undefined ? { storyBudgetUsd } : {}),
            ...(d.extraEnv ? { extraEnv: d.extraEnv } : {}),
            ...(d.claudeBin ? { claudeBin: d.claudeBin } : {}),
            ...(d.killSwitchPollMs !== undefined ? { killSwitchPollMs: d.killSwitchPollMs } : {}),
            env,
            now,
            ...(story ? { attempt: readAttempt(unit.item) } : {}),
            buildPrompt: (rid) =>
              renderPacket(packetFor(unit, rid, size, cap, budgetUsd, cwd, branch)),
          },
          { beforeRetry: makeWorktree },
        );
      } catch (e) {
        if (e instanceof DispatchRefused) {
          res.warnings.push(`${unit.kind} ${unit.item}: dispatch refused (${e.message})`);
          if (e.exitCode === DISPATCH_EXIT.killSwitch) {
            stop = true;
            res.exitCode = DISPATCH_EXIT.killSwitch;
            return { unit, result: 'paused', reason: 'kill_switch', note: e.message };
          }
          if (e.exitCode === DISPATCH_EXIT.budget && story) {
            await blockWithQuestion(unit, e.message, 'story_budget');
            return { unit, result: 'blocked', reason: 'story_budget', blocked: true };
          }
          stop = true;
          return { unit, result: 'refused', note: e.message };
        }
        throw e;
      }
      return handleOutcome(unit, outcome, branch);
    }

    function mirrorStatusOf(item: string): string | undefined {
      const v = findRow(readMirror(o.projectDir, 'stories'), item)?.properties['Status'];
      return typeof v === 'string' ? v : undefined;
    }
    function attemptOf(item: string): number {
      return mirrorAttempt(o.projectDir, item);
    }
    function readAttempt(item: string): number {
      return attemptOf(item);
    }
    function envSettings(): EnvSettings | undefined {
      try {
        return settingsFrom(o.projectDir, cfgResult.arima);
      } catch {
        return undefined;
      }
    }
    /** The status the engine last decided for a story (the mirror lags until the next push and pull), else the mirror's. */
    function currentStatus(item: string): string | undefined {
      const last = readEvents(o.projectDir)
        .filter((e) => e.type === 'item.status' && e.item === item)
        .at(-1);
      return typeof last?.data?.['to'] === 'string' ? last.data['to'] : mirrorStatusOf(item);
    }
    function inReviewWithPr(): { item: string; pr: number; branch: string }[] {
      const out: { item: string; pr: number; branch: string }[] = [];
      for (const r of readMirror(o.projectDir, 'stories')?.rows ?? []) {
        if (currentStatus(r.id) !== 'In Review') continue;
        const pr = prNumber(r.id);
        if (pr !== undefined) out.push({ item: r.id, pr, branch: branchFor(r.id, titleOf(r.id)) });
      }
      return out;
    }
    /** Step 3b: a story In Review gets a preview that answers its smoke request (WP-218); a failure is recorded, not thrown. */
    async function refreshPreviews(): Promise<void> {
      const s = envSettings();
      if (s === undefined) return;
      try {
        // A merged, accepted, released or cancelled story keeps no preview.
        const prItems: Record<number, string> = {};
        for (const e of readEvents(o.projectDir))
          if (
            e.type === 'pr.published' &&
            e.item !== undefined &&
            typeof e.data?.['pr'] === 'number'
          )
            prItems[e.data['pr'] as number] = e.item;
        await sweepPreviews(s, prItems, currentStatus, d.envDeps ?? { env });
        for (const r of await ensurePreviews(s, inReviewWithPr(), d.envDeps ?? { env }))
          if (r.result === 'failed') {
            await askAboutFailedPreview(r.item, r.pr, r.error ?? '');
            res.warnings.push(
              `preview of ${r.item} (PR #${r.pr}) failed: ${r.error ?? ''}`.slice(0, 300),
            );
          }
      } catch (e) {
        res.warnings.push(
          `previews could not be refreshed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
        );
      }
    }
    /** One non-blocking question per failed preview (and commit): the story stays In Review and a diagnosis follows. */
    async function askAboutFailedPreview(item: string, pr: number, error: string): Promise<void> {
      const sha = branchSha(o.projectDir, branchFor(item, titleOf(item))) ?? 'unknown';
      const topic = `preview-${pr}@${sha.slice(0, 8)}`;
      if (Object.values(readQuestions(o.projectDir)).some((q) => q.topic === topic)) return;
      await raiseQuestions({
        projectDir: o.projectDir,
        runId,
        role: 'devops',
        item,
        policy: cfg.autonomy.question_policy,
        now,
        questions: [
          {
            question: `The preview of ${item} (PR #${pr}) did not answer its smoke request (${error.slice(0, 300)}), so the story stays In Review. A devops diagnosis follows.`,
            options: [
              { label: 'Wait for the developer to fix it', recommendation: true },
              { label: 'I will look at it myself', recommendation: false },
            ],
            blocking: false,
            default: 'Wait for the developer to fix it',
            topic,
          },
        ],
      });
    }
    function failingPreviewItems(): { item: string; pr: number }[] {
      const failed = failedPreviews(o.projectDir);
      return inReviewWithPr()
        .filter((x) => failed.some((f) => f.pr === x.pr))
        .map((x) => ({ item: x.item, pr: x.pr }));
    }
    function previewFailureOf(
      item: string,
    ): { pr: number; ref: string; error: string } | undefined {
      const pr = prNumber(item);
      return failedPreviews(o.projectDir).find((f) => f.pr === pr);
    }
    /** The In Review to In QA guard: with a Compose file the preview must have answered its smoke request at the branch head. */
    function previewIsReady(item: string): boolean {
      if (d.previewReady) return d.previewReady(item);
      const s = envSettings();
      if (s === undefined || !previewsPossible(s)) return true;
      const pr = prNumber(item);
      if (pr === undefined) return false;
      return previewHealthy(
        o.projectDir,
        pr,
        branchSha(o.projectDir, branchFor(item, titleOf(item))),
      );
    }
    function previewConditions(unit: PlannedUnit): string[] {
      if (unit.kind === 'test-write') {
        const url = cfg.environments?.staging?.url;
        return url
          ? [
              `The baseline (staging) to run the new tests against is ${url}; each must fail there on its assertion`,
            ]
          : [];
      }
      if (unit.kind !== 'qa') return [];
      const pr = prNumber(unit.item);
      const rec = pr === undefined ? undefined : previewOf(o.projectDir, pr);
      return rec?.ok
        ? [
            `The preview to test is ${previewUrl(rec.port)} (its smoke request answered at ${rec.deployed_at})`,
          ]
        : [];
    }
    async function removeMergedPreview(pr: number): Promise<void> {
      const s = envSettings();
      if (s !== undefined) await removePreview(s, pr, d.envDeps ?? { env });
    }

    function lastDevelopReport(item: string): AgentReport | undefined {
      return lastReportOf(item, 'develop');
    }
    function lastReportOf(item: string, kind: string): AgentReport | undefined {
      const e = readEvents(o.projectDir)
        .filter((x) => x.type === 'report.accepted' && x.item === item && x.data?.['kind'] === kind)
        .at(-1);
      if (e?.run_id === undefined) return undefined;
      try {
        return JSON.parse(
          readFileSync(
            path.join(o.projectDir, '.arima', 'runs', `${e.run_id}.report.json`),
            'utf8',
          ),
        ) as AgentReport;
      } catch {
        return undefined;
      }
    }

    /**
     * D-16: a story that passed QA and was merged (PO Acceptance) is accepted automatically, on the
     * next run and only AFTER the human inputs of step 3 were applied, so a veto entered since the
     * last run wins (it sends the story back from PO Acceptance, spec 7.1).
     */
    async function autoAccept(): Promise<void> {
      // The mirror lags behind the engine's own queued writes (a veto applied a moment ago in step 3 has
      // not reached Notion yet): what the engine last decided decides.
      const last = new Map<string, string>();
      for (const e of readEvents(o.projectDir))
        if (e.type === 'item.status' && e.item !== undefined)
          last.set(e.item, String(e.data?.['to']));
      for (const row of readMirror(o.projectDir, 'stories')?.rows ?? []) {
        if (!/^US-\d+$/.test(row.id) || row.properties['Status'] !== 'PO Acceptance') continue;
        if ((last.get(row.id) ?? 'PO Acceptance') !== 'PO Acceptance') continue;
        if (heldForReview(o.projectDir, row.id)) continue; // its milestone review decides (WP-217)
        await moveItem({
          projectDir: o.projectDir,
          item: row.id,
          to: 'Done',
          actor: 'orchestrator',
          runId,
          now,
          facts: { guards: { qa_passed: true } },
        });
      }
    }

    /** A story whose published PR is green moves In Progress -> In Review, when every criterion was reported met. */
    async function advanceByFacts(): Promise<void> {
      for (const s of storiesFromMirror(o.projectDir, {
        perStoryDefault: cfg.budget.per_story_default,
        perRunCap: cfg.budget.per_run_cap,
      })) {
        if (s.status !== 'In Progress' || prNumber(s.id) === undefined || !(await gh.prReady(s.id)))
          continue;
        const rep = lastDevelopReport(s.id);
        const mapped =
          rep?.criteria_map !== undefined &&
          rep.criteria_map.length > 0 &&
          rep.criteria_map.every((c) => c.status === 'met');
        await moveItem({
          projectDir: o.projectDir,
          item: s.id,
          to: 'In Review',
          actor: 'developer',
          runId,
          now,
          facts: {
            guards: { pr_open: true, ci_green: true, criteria_mapped: mapped },
            budget_available: true,
          },
        });
      }
    }

    function titleOf(item: string): string {
      return String(findRow(readMirror(o.projectDir, 'stories'), item)?.properties['Title'] ?? '');
    }
    function storyBranchOf(item: string): string | undefined {
      const b = branchFor(item, titleOf(item));
      return branchExists(o.projectDir, b) ? b : undefined;
    }

    /** The repo files a developer unit works from (card section 3), only those that exist in its tree. */
    function readsFor(unit: PlannedUnit, cwd: string): { ref: string; why: string }[] {
      if (unit.role === 'qa') {
        // QA works from its own sparse tree: the API contract and the story's screens, nothing of the developer's.
        const qa: { ref: string; why: string }[] = [];
        if (existsSync(path.join(cwd, 'api/openapi.yaml')))
          qa.push({
            ref: 'api/openapi.yaml',
            why: 'the request and response shapes to test against',
          });
        if (existsSync(path.join(cwd, 'design', 'screens', unit.item)))
          qa.push({
            ref: `design/screens/${unit.item}`,
            why: 'the screens and their states (empty, loading, error, success) to assert',
          });
        return qa;
      }
      if (unit.role !== 'developer' && !(unit.role === 'tech-lead' && unit.kind === 'review'))
        return [];
      const out: { ref: string; why: string }[] = [];
      const add = (ref: string, why: string): void => {
        if (existsSync(path.join(cwd, ref))) out.push({ ref, why });
      };
      add(
        'api/openapi.yaml',
        'the API contract to implement; a criterion that contradicts it is a question',
      );
      add('docs/engineering/conventions.md', 'coding conventions');
      add('docs/architecture/adr', 'architecture decisions that constrain the design');
      add(`design/screens/${unit.item}`, 'the screens and their states for this UI story');
      return out;
    }

    function packetFor(
      unit: PlannedUnit,
      rid: string,
      size: Size | undefined,
      cap: number,
      budgetUsd: number,
      cwd: string,
      branch: string,
    ): PacketInput {
      const row = findRow(readMirror(o.projectDir, 'stories'), unit.item);
      const profileName = cfg.profile as 'solo-lite' | 'client-project' | 'regulated';
      const untrusted: { label: string; source: string; text: string }[] = [];
      if (row) {
        untrusted.push({
          label: 'Story title (Notion)',
          source: 'notion',
          text: String(row.properties['Title'] ?? ''),
        });
        const ac = String(row.properties['Acceptance criteria'] ?? '');
        if (ac)
          untrusted.push({ label: 'Acceptance criteria (Notion)', source: 'notion', text: ac });
      }
      const failed = unit.kind === 'deploy-staging' ? stagingFailing(o.projectDir) : undefined;
      const pv = unit.kind === 'preview-diagnose' ? previewFailureOf(unit.item) : undefined;
      if (pv)
        untrusted.push({
          label: 'Preview deploy result (script output)',
          source: 'arima-env',
          text: `preview-${pv.pr}; ref ${pv.ref}; ${pv.error}`,
        });
      if (failed)
        untrusted.push({
          label: 'Staging deploy result (script output)',
          source: 'arima-env',
          text: `ref ${failed.ref}; previous version restored: ${failed.restored}; ${failed.error}`,
        });
      const inputs = readsFor(unit, cwd);
      const review =
        unit.kind === 'review' && unit.item !== 'none'
          ? reviewContext({
              projectDir: o.projectDir,
              defaultBranch: cfg.github.default_branch,
              branch,
              size,
              developerReport: lastDevelopReport(unit.item),
              priorFindings: lastReportOf(unit.item, 'review')?.findings,
              attempt: attemptOf(unit.item),
            })
          : undefined;
      if (unit.role === 'qa' && row) {
        const own = new Set(
          Array.isArray(row.properties['Test Cases'])
            ? (row.properties['Test Cases'] as unknown[]).filter(
                (x): x is string => typeof x === 'string',
              )
            : [],
        );
        const cases = (readMirror(o.projectDir, 'test_cases')?.rows ?? [])
          .filter((c) => own.has(c.page_id))
          .map((c) => ({
            id: c.id,
            title: c.properties['Title'],
            type: c.properties['Type'],
            test_path: c.properties['Test path'],
            last_result: c.properties['Last result'],
          }));
        if (cases.length > 0)
          untrusted.push({
            label: 'Test cases of the story (Notion)',
            source: 'notion',
            text: JSON.stringify(cases, null, 2),
          });
      }
      if (review) untrusted.push(...review.untrusted);
      if (review) unapprovableReviews.set(unit.item, review.unapprovable);
      return {
        run_id: rid,
        max_minutes: cfg.schedule.max_run_minutes,
        unit: {
          unit_id: `${rid}-u${unit.order}`,
          role: unit.role as Role,
          item: unit.item,
          kind: unit.kind,
          phase: 4,
          attempt: attemptOf(unit.item),
          budget_usd: budgetUsd,
          max_turns: cap,
          ...(unit.reworkReason ? { rework_reason: unit.reworkReason } : {}),
          ...(cwd !== o.projectDir ? { worktree: cwd, branch } : {}),
          inputs: inputs.map((i) => i.ref),
          profile: profileName,
        },
        inputs,
        conditions: [
          `Story size: ${size ?? 'unknown'}`,
          `The profile is ${cfg.profile}`,
          ...(unit.reworkReason ? [`This is rework: ${unit.reworkReason}`] : []),
          ...(review ? review.conditions : []),
          ...previewConditions(unit),
          ...overrideConditions(o.projectDir, unit.role),
        ],
        task: taskFor(unit),
        output_contract: outputContractFor(unit.kind),
        web: { hosts: [], local_origins: [] },
        untrusted,
      };
    }

    async function blockWithQuestion(
      unit: PlannedUnit,
      message: string,
      hardStop?: string,
    ): Promise<void> {
      await raiseQuestions({
        projectDir: o.projectDir,
        runId,
        role: unit.role as Role,
        item: unit.item,
        policy,
        now,
        ...(hardStop ? { engineHardStop: hardStop } : {}),
        questions: [
          {
            question: message,
            options: [{ label: 'I will decide in Notion', recommendation: true }],
            blocking: true,
            topic: unit.item,
          },
        ],
      });
    }

    async function handleOutcome(
      unit: PlannedUnit,
      out: UnitOutcome,
      branch: string,
    ): Promise<UnitResult> {
      const base: UnitResult = {
        unit,
        runId: out.runId,
        result: out.result,
        ...(out.reason ? { reason: out.reason } : {}),
      };
      if (out.result === 'paused') {
        res.exitCode = DISPATCH_EXIT.paused;
        return base;
      }
      if (out.blocked) {
        await blockWithQuestion(
          unit,
          `${unit.kind} of ${unit.item} failed twice (${out.reason ?? out.subtype}). Options: retry later, change the approach, or cancel the item.`,
        );
        return { ...base, blocked: true };
      }
      if (out.result === 'blocked' && unit.item !== 'none') {
        await blockWithQuestion(
          unit,
          `${unit.kind} of ${unit.item} stopped at its cap (${out.reason ?? out.subtype}). Options: raise the cap, split the story, or cancel the item.`,
        );
        return { ...base, blocked: true };
      }
      const report: AgentReport | undefined = out.report;
      if (report === undefined) return base;

      const ids = await enqueueReportRecords({
        projectDir: o.projectDir,
        runId: out.runId,
        role: unit.role as Role,
        report,
        now,
      });
      if (report.questions && report.questions.length > 0)
        await raiseQuestions({
          projectDir: o.projectDir,
          runId: out.runId,
          role: unit.role as Role,
          item: unit.item,
          questions: report.questions,
          policy,
          placeholders: ids.ids,
          now,
        });

      // Verdicts and findings go to the pull request as comments (the host holds the token).
      if (REVIEW_KINDS.has(unit.kind)) await comment(unit, report);

      if (unit.kind === 'test-write' && report.status === 'done') adoptTests(unit);
      if (unit.kind === 'develop' && report.status === 'done')
        await publishDevelop(unit, report, branch);
      if (unit.kind === 'review' && report.status === 'done' && report.verdict) {
        // An approve is not acted on when the reviewer could not have seen the whole change: the host
        // treats it as changes_requested so the author fixes what blocked the review (judge major 3).
        const why = unapprovableReviews.get(unit.item) ?? [];
        const effective =
          report.verdict.result === 'approve' && why.length > 0
            ? 'changes_requested'
            : report.verdict.result;
        if (effective !== report.verdict.result)
          res.warnings.push(
            `review of ${unit.item}: the approve was not acted on (${why.join('; ')})`,
          );
        await afterReview(unit, effective);
      }
      if (unit.kind === 'qa' && report.status === 'done' && report.verdict?.result === 'fail')
        await afterQaFail(unit, report);
      if (unit.kind === 'qa' && report.status === 'done' && report.verdict?.result === 'pass') {
        // A pass that never ran the tests (the audit log of this run holds no npm run e2e or npm test) is not
        // acted on: the test cases would be marked Pass without a run (judge J-agent:qa, blocker 3).
        const ran = readEvents(o.projectDir).some(
          (e) =>
            e.run_id === out.runId &&
            e.type === 'tool.used' &&
            /^npm\s+(run\s+e2e|test)\b/.test(String(e.data?.['command'] ?? '').trim()),
        );
        if (ran) await afterQaPass(unit);
        else
          res.warnings.push(
            `QA of ${unit.item} reported pass but its run never ran npm run e2e or npm test: the pass was not acted on`,
          );
      }
      return base;
    }

    function prNumber(item: string): number | undefined {
      const e = readEvents(o.projectDir)
        .filter((x) => x.type === 'pr.published' && x.item === item)
        .at(-1);
      return typeof e?.data?.['pr'] === 'number' ? (e.data['pr'] as number) : undefined;
    }

    async function comment(unit: PlannedUnit, report: AgentReport): Promise<void> {
      const pr = prNumber(unit.item);
      if (pr === undefined || d.token === undefined) return;
      try {
        await postReview({
          projectDir: o.projectDir,
          role: unit.role as Role,
          item: unit.item,
          pr,
          repo: cfg.github.repo,
          findings: (report.findings ?? []) as never,
          verdict: report.verdict,
          token: d.token,
          ...(d.gh ? { gh: d.gh } : {}),
        });
      } catch (e) {
        res.warnings.push(
          `could not post the ${unit.kind} review of ${unit.item}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    /** QA's tests go onto the story branch, so the developer starts with the tests that judge the work. */
    function adoptTests(unit: PlannedUnit): void {
      try {
        adoptQaTests({
          projectDir: o.projectDir,
          item: unit.item,
          qaBranch: `qa/${unit.item}-tests`,
          storyBranch: branchFor(unit.item, titleOf(unit.item)),
        });
      } catch (e) {
        res.warnings.push(
          `the tests of ${unit.item} were not put on the story branch: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
        );
        if (!(e instanceof QaTestsError)) throw e;
      }
    }

    async function publishDevelop(
      unit: PlannedUnit,
      report: AgentReport,
      branch: string,
    ): Promise<void> {
      const criteria = report.criteria_map ?? [];
      const ui = existsSync(path.join(o.projectDir, 'design', 'screens', unit.item));
      const body = renderPrBody({
        items: [unit.item],
        summary: report.summary,
        criteria: criteria.map((c) => ({
          criterion: c.criterion,
          status: c.status,
          evidence: c.evidence,
        })),
        ui,
        screenshots: ui ? [`design/screens/${unit.item}/success.html`] : [],
        risk: 'See the story; the change is limited to this item.',
        rollback: 'Revert the merge commit.',
        dodDone: [1],
      });
      try {
        await publishBranch({
          projectDir: o.projectDir,
          runId,
          branch,
          item: unit.item,
          role: unit.role as Role,
          ...(qaTipOf(o.projectDir, unit.item)
            ? { testsBase: qaTipOf(o.projectDir, unit.item) as string }
            : {}),
          title: titleOf(unit.item) || unit.item,
          body,
          repo: cfg.github.repo,
          defaultBranch: cfg.github.default_branch,
          stateBranch: cfg.github.state_branch,
          ...(d.remoteUrl
            ? { remoteUrl: d.remoteUrl, allowUncheckedRemote: true }
            : cfg.github.allow_unchecked_remote
              ? { allowUncheckedRemote: true }
              : {}),
          token: d.token,
          ...(d.gh ? { gh: d.gh } : {}),
          isPaused: async () => (await checkKillSwitch(o.projectDir, null)).on,
        });
      } catch (e) {
        res.warnings.push(
          `could not publish ${unit.item}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    /** QA passed: the engine (not QA) sets `Last result` to Pass on every test case of the story (merge needs it). */
    async function afterQaPass(unit: PlannedUnit): Promise<void> {
      const story = findRow(readMirror(o.projectDir, 'stories'), unit.item);
      const refs = Array.isArray(story?.properties['Test Cases'])
        ? (story?.properties['Test Cases'] as string[])
        : [];
      const cases = readMirror(o.projectDir, 'test_cases');
      let n = 0;
      for (const ref of refs) {
        const row = findRow(cases, ref);
        if (row === undefined) continue;
        n += 1;
        enqueue(o.projectDir, {
          id: `qa-${runId}-${unit.item}-${n}`,
          created_at: new Date(now.getTime() + n).toISOString(),
          run_id: runId,
          role: 'orchestrator',
          op: 'update',
          database: 'test_cases',
          item_id: row.id,
          properties: { 'Last result': 'Pass' },
        });
      }
    }

    /** The third failed review or QA attempt redirects to Blocked; the state machine says a question is due (WP-107, WP-141). */
    async function raiseDueQuestion(
      unit: PlannedUnit,
      moved: Awaited<ReturnType<typeof moveItem>>,
    ): Promise<void> {
      if (!moved.ok || moved.applied.question === undefined) return;
      await blockWithQuestion(unit, moved.applied.question.summary);
    }

    async function afterReview(unit: PlannedUnit, verdict: string): Promise<void> {
      const budget = unitBudget(
        o.projectDir,
        unit.item,
        storyBudgetFromMirror(o.projectDir, unit.item, {
          perStoryDefault: cfg.budget.per_story_default,
          ...(cfg.budget.by_size ? { bySize: cfg.budget.by_size } : {}),
        }),
        cfg.budget.per_run_cap,
      ).ok;
      if (verdict === 'approve')
        await moveItem({
          projectDir: o.projectDir,
          item: unit.item,
          to: 'In QA',
          actor: 'tech-lead',
          runId,
          now,
          facts: {
            guards: {
              review_approved: true,
              preview_deployed: previewIsReady(unit.item),
            },
            budget_available: budget,
          },
        });
      else if (verdict === 'changes_requested')
        await raiseDueQuestion(
          unit,
          await moveItem({
            projectDir: o.projectDir,
            item: unit.item,
            to: 'In Progress',
            actor: 'tech-lead',
            runId,
            now,
            facts: { guards: { changes_requested: true }, budget_available: budget },
          }),
        );
    }

    async function afterQaFail(unit: PlannedUnit, report: AgentReport): Promise<void> {
      const bugs = (report.records ?? []).some(
        (r) => (r as { database?: string }).database === 'bugs',
      );
      await raiseDueQuestion(
        unit,
        await moveItem({
          projectDir: o.projectDir,
          item: unit.item,
          to: 'In Progress',
          actor: 'qa',
          runId,
          now,
          facts: { guards: { test_failed: true, bug_linked: bugs }, budget_available: true },
        }),
      );
    }

    // Merge what is ready: a refusal is normal (the human has not approved yet).
    const merges: string[] = [];
    if (!stop && d.token !== undefined) {
      for (const s of storiesFromMirror(o.projectDir, {
        perStoryDefault: cfg.budget.per_story_default,
        perRunCap: cfg.budget.per_run_cap,
      })) {
        if (s.status !== 'In QA') continue;
        const pr = prNumber(s.id);
        if (pr === undefined) continue;
        try {
          const m = await mergePr({
            projectDir: o.projectDir,
            runId,
            pr,
            item: s.id,
            repo: cfg.github.repo,
            defaultBranch: cfg.github.default_branch,
            team,
            token: d.token,
            ...(d.gh ? { gh: d.gh } : {}),
            isPaused: async () => (await checkKillSwitch(o.projectDir, null)).on,
          });
          merges.push(s.id);
          await d.afterMerge?.({ item: s.id, sha: m.sha });
          await removeMergedPreview(pr);
        } catch (e) {
          log(
            `merge of ${s.id} not done: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
          );
        }
      }
    }
    await step(5, { dispatched: res.dispatched.length, merged: merges });

    // ---- 6. Meetings and 7. Gates: not built yet (WP-302, WP-330) ---------------------------------------
    await step(6, { skipped: 'meetings are not built yet (WP-302)' });
    await step(7, { skipped: 'gate evidence packs are not built yet (WP-330)' });

    // ---- 8. Handle hard stops ------------------------------------------------------------------------------
    const hardStops = readEvents(o.projectDir).filter(
      (e) => e.type === 'hardstop.hit' && e.run_id === undefined,
    ).length;
    await step(8, { hard_stops_in_log: hardStops });

    // ---- 9. Sync out ---------------------------------------------------------------------------------------------
    let syncFailed = false;
    const rows = readLedger(o.projectDir);
    await syncCostLog({ projectDir: o.projectDir, runId, rows, now });
    await recordCostAlerts(
      o.projectDir,
      costAlerts(
        rows,
        storyMetas(o.projectDir, {
          perStoryDefault: cfg.budget.per_story_default,
          ...(cfg.budget.by_size ? { bySize: cfg.budget.by_size } : {}),
        }),
      ),
    );
    // The digest of the day (spec 12.1, WP-130): on demand until Gate U, so each attended run writes it.
    let digestNote = 'not written';
    let red: { date: string; reasons: string[] } | undefined;
    if (!dry) {
      try {
        const model = buildDigest(o.projectDir, now);
        const pub = await publishDigest({ projectDir: o.projectDir, runId, model, now });
        digestNote = `${model.health}; ${path.relative(o.projectDir, pub.file)}`;
        if (model.health === 'red') red = { date: model.date, reasons: model.healthReasons };
      } catch (e) {
        res.warnings.push(
          `the digest was not written: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
        );
      }
    }
    if (d.notion !== undefined && d.notion !== null && !res.degraded) {
      try {
        const push = await pushOutbox(o.projectDir, d.notion.port, readNotionMap(o.projectDir), {
          now,
          allowStatusWrites: { idPrefix: ENGINE_STATUS_PREFIX },
        });
        if (push.rejected.length + push.conflicts.length + push.deferred.length > 0) {
          syncFailed = push.deferred.length > 0 || push.rejected.length > 0;
          res.warnings.push(
            `outbox: ${push.applied.length} applied, ${push.rejected.length} rejected, ${push.conflicts.length} in conflict, ${push.deferred.length} deferred`,
          );
        }
      } catch (e) {
        syncFailed = true;
        res.warnings.push(`the outbox push failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else syncFailed = d.notion !== undefined && d.notion !== null;

    // @mentions (spec 12.3, WP-142): each item awaiting a person, and the Urgent page. Append-only, once per state;
    // a failure is a warning, never a failed run.
    if (
      !dry &&
      d.notion !== undefined &&
      d.notion !== null &&
      !res.degraded &&
      cfg.notion?.root_page_id
    ) {
      try {
        const n = await sendNotifications({
          projectDir: o.projectDir,
          port: d.notion.port,
          rootPageId: cfg.notion.root_page_id,
          now,
          ...(red ? { redHealth: red } : {}),
        });
        if (n.failed.length > 0)
          res.warnings.push(
            `${n.failed.length} notification(s) failed: ${n.failed[0]?.reason ?? ''}`,
          );
      } catch (e) {
        res.warnings.push(
          `notifications failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
        );
      }
    }
    await step(9);

    // ---- 10. Close -------------------------------------------------------------------------------------------------------
    await pruneWorktrees({
      projectDir: o.projectDir,
      defaultBranch: cfg.github.default_branch,
      stateBranch: cfg.github.state_branch,
    }).catch(() => undefined);
    await step(10, { digest: digestNote });
    await appendEvent(o.projectDir, {
      type: 'run.end',
      actor: 'orchestrator',
      run_id: runId,
      data: { command: 'dispatch', dispatched: res.dispatched.length },
    });
    if (d.skipState !== true) {
      try {
        const s = await pushState({
          projectDir: o.projectDir,
          runId,
          branch: cfg.github.state_branch,
          defaultBranch: cfg.github.default_branch,
        });
        for (const w of s.warnings) res.warnings.push(w);
      } catch (e) {
        syncFailed = true;
        res.warnings.push(`state not saved: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (res.exitCode === 0) {
      if (plan.units.length === 0 && res.dispatched.length === 0)
        res.exitCode = DISPATCH_EXIT.nothing;
      else if (syncFailed) res.exitCode = DISPATCH_EXIT.failed;
    }
    return res;
  } finally {
    if (!dry) releaseRunLock(o.projectDir, runId);
  }
}

function branchExists(projectDir: string, branch: string): boolean {
  return existsSync(worktreePath(projectDir, branch)) ? true : gitHasBranch(projectDir, branch);
}

function gitHasBranch(projectDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: projectDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function mirrorAttempt(projectDir: string, item: string): number {
  const a = findRow(readMirror(projectDir, 'stories'), item)?.properties['Attempt'];
  return typeof a === 'number' && a >= 1 ? a : 1;
}

/** Builds a `GithubFacts` from `gh` for the pull requests ARIMA published (the host holds the token). */
export function githubFactsFromGh(o: {
  projectDir: string;
  repo: string;
  token: string;
  gh: GhRunner;
}): GithubFacts {
  const prOf = (item: string): number | undefined => {
    const e = readEvents(o.projectDir)
      .filter((x) => x.type === 'pr.published' && x.item === item)
      .at(-1);
    return typeof e?.data?.['pr'] === 'number' ? (e.data['pr'] as number) : undefined;
  };
  const env = { ...process.env, GH_TOKEN: o.token, GH_PROMPT_DISABLED: '1' };
  const view = (
    pr: number,
  ): { state: string; isDraft: boolean; statusCheckRollup: never[] } | undefined => {
    const r = o.gh(
      ['pr', 'view', String(pr), '--repo', o.repo, '--json', 'state,isDraft,statusCheckRollup'],
      { cwd: o.projectDir, env },
    );
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return undefined;
    }
  };
  return {
    prReady: async (item) => {
      const pr = prOf(item);
      const v = pr === undefined ? undefined : view(pr);
      if (v === undefined || v.state !== 'OPEN' || v.isDraft) return false;
      const c = summariseChecks(v.statusCheckRollup);
      return c.checks > 0 && c.failing.length + c.pending.length === 0;
    },
    ciRedOnMain: () => Promise.resolve(false),
    prsAwaitingHuman: async () => {
      let n = 0;
      for (const row of readMirror(o.projectDir, 'stories')?.rows ?? [])
        if (row.properties['Status'] === 'In QA' && prOf(row.id) !== undefined) n += 1;
      return n;
    },
  };
}

export type { UnitKind };
export { mirrorStatus };
