# F02 Run dispatcher and `/arima:run`

Tags: `[BUILT]` exists with tests, `[SPEC]` required by the spec, not built, `[PROPOSED]` introduced here and frozen by the named package. Spec section numbers refer to `docs/spec/ARIMA-Master-Spec.md`. Values marked ESTIMATE are not in the spec; each has an open decision in section 12.

## 1. Purpose and spec refs

The dispatcher is the deterministic program behind the daily run (spec 7.2, 14): it performs the ten steps in fixed order, decides in code which work units exist today, builds one run packet per unit, starts one headless run per unit through `arima-run-agent`, validates what comes back, and leaves one ledger row per run. Judgment stays in the role agents; ordering, limits, retries and state changes stay in tested code (`01-architecture.md` section 2). Spec refs: 7.1 (state machine, sizes), 7.2 (daily run), 7.12 (failure handling), 10.3 (review queue limit, D-21), 11.1 (hard stops), 13.5 (budget enforcement), 14 (`/arima:run`), 4.4 and D-41 (attended first). Packages: WP-120 (dispatcher, `--dry-run`, `--only`), WP-109 (queue rules), WP-215 (real roles, retry rules). Status: `[SPEC]`; its building blocks are `[BUILT]` (preflight, kill switch, lock, budget, ledger, events, `runAgent`).

## 2. Command or entry point and arguments

| Entry | Form | Status |
| --- | --- | --- |
| Skill | `/arima:run [--dry-run] [--only <item>]` (spec 14); `disable-model-invocation: true`; `allowed-tools` lists the exact `arima-dispatch` path | `[SPEC]` WP-120 |
| Script | `arima-dispatch --project <dir> [--dry-run] [--only <ID>]` (`scripts/dist/arima-dispatch.mjs`, bundled) | `[SPEC]` WP-120 |
| Scheduler | Only ever calls `/arima:run` (spec 14); **not allowed** until Gate U (D-41, `02-stages.md` section 5) | `[SPEC]` WP-230 |

Arguments: `--dry-run` runs steps 1 to 4 and prints the plan; `--only <ID>` limits step 4 to the next work unit of one item (US-, BUG-, INC-, CR-, MS- ids, spec section 2). Both may combine. Unknown flags: exit 2. An item id that fails the id format of `ids.schema.json`: exit 2.

## 3. Preconditions (IF/THEN)

| IF | THEN | Enforced by |
| --- | --- | --- |
| `arima.yaml` or `team.yaml` invalid | Refuse, exit 10, `preflight.fail` event | `preflight.ts`; `preflight.test.ts` `[BUILT]` |
| Kill switch on, or no source readable (D-39) | Refuse, exit 12; unreadable counts as on | `killswitch.ts`; `killswitch-hardening.test.ts` `[BUILT]` |
| Another live `run.lock` | Refuse, exit 11; a lock older than `max_run_minutes + 30` is replaced | `runlock.ts`; `preflight.test.ts` `[BUILT]` |
| Project or daily budget at or over cap | Refuse, exit 13 | `budget.ts`; `preflight.test.ts` `[BUILT]` |
| Required env var missing (Notion token, machine token, `ANTHROPIC_API_KEY` if `runtime.auth: api_key`) | Refuse, exit 14 (names only are reported) | `preflight.ts` `[BUILT]` |
| Profile not set or `autonomy.mode` not `autonomous` | `[SPEC]` silent on what `assisted`/`gated` change; ESTIMATE: treat `assisted` as "dry-run only, human confirms each unit" (open decision O-1) | NOT ENFORCED YET (WP-120) |
| Run started by a scheduler before Gate U | Refuse; there is no scheduler until WP-230 (D-41) | NOT ENFORCED YET (WP-230) |

## 4. Inputs and input handling (validation, trust)

| Input | Source | Handling |
| --- | --- | --- |
| Config and team | `arima.yaml`, `team.yaml` | Schema-validated by `validateProject`; trusted after validation `[BUILT]` |
| Board, gates, questions, answers, vetoes, priorities, CRs | `.arima/mirror/*.json` after `arima-notion pull` | **Untrusted data.** Read as values only; text fields are quoted into `untrusted` blocks of a run packet, never into instruction headings (`03-contracts.md` 3.2). A mirror older than the pull of this run is refused (stale mirror, exit 14 PROPOSED) |
| CI, PR and alert status | GitHub, monitoring (spec 7.2 step 2) | Data. Pulled only through host scripts that hold the token; agents never receive it (D-37) |
| Ledger, events | `.arima/ledger.jsonl`, `events.jsonl` | Written only by scripts; read through `readLedger`/`readEvents` (validated) `[BUILT]` |
| Agent report | `runs/<run_id>.report.json` | Validated against `agent-report.schema.json` (WP-101/103) before any state change; invalid = run `fail`, reason `report_invalid` `[PROPOSED]` |
| Outbox entries | `.arima/outbox/*.json` | Schema, secret scan, human-only refusal, `Status` refusal, conflict check on push `[BUILT]` |
| `--only` value | command line | Id-format check; the item must exist in the mirror, else exit 2 |

## 5. Processing steps

Code versus model: every step is code except the work performed inside a dispatched run (step 5) and the prose of meetings and digests' judgment sections. No step asks a model to count, order or decide a state transition.

1. **Preflight** (code `[BUILT]`): `runPreflight` with `acquireFor` = a new run id (`r-YYYYMMDD-HHMM-NN`). Stops with exit 10 to 14 as in section 3. Dry-run: checks run, lock **not** acquired (PROPOSED, WP-120).
2. **Sync in** (code): `arima-notion pull` into the mirror; GitHub status for open PRs, CI, `main` and staging health. Notion or GitHub unreachable: continue on local state, outbox retried next run; but no readable kill-switch source at all means paused (spec 7.12, D-39). Stops: none beyond that.
3. **Apply human inputs** (code, WP-140): approvals advance gates (via `checkApprover()`, F04); answers unblock items; vetoes create an undo task and send the story back one step; priority changes reorder; new CRs enter triage. Every transition goes through the state machine (WP-107): actor, guard, hard stop, budget, `item.status` event, engine-owned `Status` write (WP-108). Mirror diffs are compared by property value, not timestamp (spec 3.3).
4. **Plan the day** (pure code, WP-109): produce an ordered list of work-unit descriptors (`03-contracts.md` 3.1) using the rule table below. Output is deterministic for a given mirror, ledger and clock. Stops: empty plan, then steps 6 to 10 still run, exit 3 only when the plan is empty **and** something blocks it (all items Blocked, queue full, budget).
5. **Dispatch runs** (code starts, model works): for each unit, in plan order up to parallelism: build the descriptor, render the packet (`arima-packet`, WP-102), create the worktree (WP-110), call `runAgent`. `runAgent` re-checks kill switch and budget before every spawn (`assertMayDispatch`, `hardstop.hit`, exit 12/13) `[BUILT]` and writes exactly one ledger row plus `run.start`/`run.end` (or `run.paused`) `[BUILT]`. Then the report collector validates the report (WP-103); the orchestrator applies the outbox and the state transition. A usage-limit result (exit 75) stops dispatch for the rest of the run: no further units, steps 8 to 10 still run (spec 4.4).
6. **Hold due meetings** (WP-302, F04): standup is generated from state; other meetings only when their trigger holds.
7. **Check gates** (WP-330, F04): if a phase's exit criteria are met, build the evidence pack and open the gate. Mechanical checks are scripts.
8. **Handle hard stops** (code): record `hardstop.hit`, pause dependent items (Blocked + question), continue independent work. A hard-stop id must be one of the canonical ids (`hardstops.ts`, D-42).
9. **Sync out** (code): `arima-notion push` flushes the outbox in `created_at` order; results `applied/rejected/conflict/deferred` as in `03-contracts.md` section 4. Deferred entries retry next run.
10. **Close** (code): write the digest (F05), commit `.arima/` to `arima-state` (private remote only, `[BUILT]` `state.ts`), release the lock. The lock is released on every exit path, including failure of steps 2 to 9 (try/finally, PROPOSED test).

### Plan-the-day priority rules (spec 7.2 step 4; WP-109 test table `queue.test.ts`)

| Rank | Work | Work-unit kind and role | Eligibility condition (IF) |
| --- | --- | --- | --- |
| 1 | P1/P2 incidents | triage/mitigate (devops), hotfix (developer) | Incident open with priority P1 or P2; outranks everything (`02-stages.md` section 7) |
| 2 | Broken `main` or staging | fix (developer/devops) | CI red on `main` after the flaky re-run, or staging smoke failing |
| 3 | Rework on in-flight items | develop (developer) | Item In Progress with attempt > 1 or a linked open BUG; finish before starting new |
| 4 | QA of finished PRs | review (tech-lead), qa (qa) | PR open, CI green, criteria mapped; QA only after tech-lead approval (state machine) |
| 5 | Test-case writing | test-write (qa) | Story newly Ready and no linked Test Cases (guard of Ready to In Progress) |
| 6 | New stories by priority | develop (developer) | Story Ready (DoR met), has test cases, story budget available, WIP and parallelism limits, review queue not full |
| 7 | Recurring jobs due today | per job table spec 7.10 | Cadence due and not run in the period |
| 8 | Documentation and tech-debt items | author/develop | Remaining budget and parallelism |

Ties within a rank: PO priority, then size S before L, then oldest first (ESTIMATE, O-2). Parallelism: at most `min(parallelism.max_developer_agents, team developer.count)` developer runs (spec 4.2). WIP limit: spec 7.1 names it but gives no number (ESTIMATE: equal to developer count, O-3).

## 6. Outputs and side effects

| Output | Where | Notes |
| --- | --- | --- |
| Ledger rows | `.arima/ledger.jsonl` | One per run, even on crash `[BUILT]`; orchestrator overhead uses `role: orchestrator`, `item: none` (spec 13.2) |
| Events | `.arima/events.jsonl` | `[BUILT]`: `run.start run.end run.paused preflight.fail item.status hardstop.hit budget.alert notion.* state.push`. `[PROPOSED]` (WP-101): `unit.dispatched unit.retried report.accepted report.rejected merge.done merge.refused` |
| Run records | `.arima/runs/<run_id>.json`, `.report.json` | Secret-scanned `[BUILT]` |
| Notion | outbox then `arima-notion push` | `Status` only by the engine with the human flag (WP-108) |
| Git | worktree per run; host publish script pushes branches and opens PRs (WP-111); `arima-merge` merges (WP-112); `.arima/` commit on `arima-state` | Agents hold no push credential (D-37) |
| Console | plan (always), per-unit result, final summary and next command | Skill ends on one command (`03-contracts.md` 11) |
| `--dry-run` | prints the ordered plan with unit, role, item, cap; writes **nothing** except the console | No lock, no ledger row, no outbox, no Notion write, no git (acceptance of WP-120) |

## 7. Exit codes

Registry (`03-contracts.md` section 8): `arima-dispatch` 0 ok, 4 nothing to do, 12/13/14 as preflight (reserved, final values fixed by WP-120).

| Code | Meaning | Status |
| --- | --- | --- |
| 0 | Run completed (units may have failed individually; see digest) or dry-run printed | `[SPEC]` |
| 2 | Usage error | `[SPEC]` |
| 4 | Plan empty because everything is blocked, queue full or no Ready work | `[SPEC]` reserved |
| 10, 11, 12, 13, 14 | Config, locked, kill switch, budget, environment (as `PREFLIGHT_EXIT`) | `[BUILT]` in preflight |
| 75 | Usage limit reached mid-run; later units skipped | `[PROPOSED]` (mirrors `arima-run-agent`) |
| 1 | Run completed but sync out or state push failed (outbox kept) | `[PROPOSED]` WP-120 |

Note: code 3 means "blocked by a turn or budget cap" in `arima-run-agent`; `arima-dispatch` uses 4 for "nothing to do" so the two never clash (resolved, `07-known-gaps.md` G-24).

## 8. Conditions and rules

| IF (state) | THEN | Enforced by / test |
| --- | --- | --- |
| Story not Ready (DoR unmet) | Never assigned | `queue.test.ts` (WP-109), `item.test.ts` (WP-106); NOT ENFORCED YET |
| `review.max_prs_awaiting_human` (default 5) PRs await approval | No new story starts (rank 6 skipped); ranks 3, 4, 5, 8 continue (spec 10.3, D-21) | `queue.test.ts`; NOT ENFORCED YET |
| Run errors out (non-zero, no valid report, not a cap or pause) | Retry once with the same packet and `attempt` unchanged; second failure: item Blocked, question raised (spec 7.12) | `report-collector.test.ts` (WP-103), `dispatch.test.ts`; NOT ENFORCED YET |
| CI red on a PR or `main` | Re-run CI once; repeated failure: file a BUG on the test (spec 7.12) | `dispatch.test.ts` (WP-215); NOT ENFORCED YET |
| Review or QA fails | Item back to In Progress, `attempt + 1`, `is_rework: true`, reason `failed_review`/`failed_qa` | `state-machine.test.ts` (WP-107) |
| Third failed review or QA attempt | Item Blocked, question raised, escalated in digest | `state-machine.test.ts` |
| Run hits budget or turn cap (`error_max_turns`, `error_max_budget_usd`) | Result `blocked`; item Blocked with cost so far and options; no retry | `run-agent.test.ts` (outcome mapping `[BUILT]`), `dispatch.test.ts` |
| Story budget used up (`story_budget`) | No new run for the item; Blocked with cost and options; `hardstop.hit` | `story-budget.test.ts` (WP-105) |
| Unit budget | `budget_usd = min(per_run_cap, remaining story budget)`; per-story default by size S 1, M 3, L 6 est. USD (spec 7.1) | `story-budget.test.ts`; `runAgent` already rejects `budget > per_run_cap` `[BUILT]` |
| Daily or project budget reached mid-run | Next dispatch refused (exit 13 inside `runAgent`), no new runs, digest alert (spec 11.1) | `dispatch-recheck.test.ts` `[BUILT]` |
| Kill switch turned on mid-run | Next dispatch refused (exit 12); running child is not killed by dispatch (PROPOSED: no new units, finish steps 8 to 10) | `dispatch-recheck.test.ts` `[BUILT]` for refusal |
| Missing credential or account | Hard stop `missing_credential`; Blocked + question to the responsible human (spec 7.12) | NOT ENFORCED YET (WP-120) |
| Agent report asks for a state change (e.g. `Status`) | Ignored; only the engine changes `Status` | `outbox.test.ts` `[BUILT]`; `status-ownership.test.ts` |
| Same unit dispatched twice (lost response) | No duplicate artifacts, outbox entries or rows (idempotence rule 7, `04-agent-build-protocol.md`) | `dispatch.test.ts`; NOT ENFORCED YET |
| Unattended invocation | Not supported (D-41) | Gate U |

Attended-first (D-41): until Gate U every real run is started by the human, who is present; there is no scheduler, no wake timer and no catch-up logic in WP-120. Profile differences: solo-lite enforces only G1 and G3 (spec 4.3) so step 7 checks only those; code review uses one reviewer agent (client-project: against tech-lead rules; regulated: two), a count the plan uses to emit one or two review units.

## 9. Failure handling

| Failure | Response | Spec |
| --- | --- | --- |
| Preflight fails | Exit with the code; no state change; event logged | 7.2 step 1 |
| Notion or GitHub unreachable | Continue on local state; deferred outbox | 7.12 |
| Unit fails validation (report, template, secret scan) | Run result `fail`; output discarded; counts as a run failure (`run_failures`), not as an `attempt` | `01-architecture.md` section 7 |
| Child hangs or exceeds `max_run_minutes` | Process tree killed, result `error` `[BUILT]` (`killtree.test.ts`) | 7.2 |
| Dispatcher crashes between steps | Lock goes stale after `max_run_minutes + 30`; next run replaces it; ledger rows already written stay | 4.1 |
| Outbox push fails permanently for an entry | Entry rejected with reason, others continue | `outbox.ts` `[BUILT]` |
| State push refused (public or unknown remote) | Run still succeeds, exit 1, warning in digest (hard rule: never push state to a public remote) | 11.3 |

## 10. Tests and verification

Existing `[BUILT]`: `preflight.test.ts`, `dispatch-recheck.test.ts`, `run-agent.test.ts`, `killswitch-hardening.test.ts`, `killtree.test.ts`, `ledger-events.test.ts`, `hardstops.test.ts`, `hardstop-ids.test.ts`, `outbox.test.ts`.

To write:

| Test file | Proves |
| --- | --- |
| `queue.test.ts` (WP-109) | Rank table above as a table test; every rule in section 8 incl. review-queue limit, parallelism, tie-break; mutation of the order breaks it |
| `dispatch.test.ts` (WP-120) | Ten steps in order (event sequence); `--dry-run` leaves repo, `.arima/` and fake Notion byte-identical; `--only` plans one unit; unreadable kill switch refuses; lock released on every path; retry-once; usage-limit stops dispatch |
| `report-collector.test.ts` (WP-103) | Invalid report = `fail`; second failure Blocked + question |
| `state-machine.test.ts` (WP-107) | Third-strike Blocked; every illegal edge refused |
| `story-budget.test.ts` (WP-105) | Cap formula; `hardstop.hit story_budget` |
| `evals/stage1/E-S1` (WP-121) | Five stories Backlog to Done with stub agents; invalid stub output fails the run |
| `evals/run` (WP-215) | Failure-loop scenarios with real agents; one capped live run on the dev project (`D:\GitHub\arima-dev`) before `done` |

## 11. Dependencies

WP-120 depends on WP-102, 103, 104, 109, 110. **Gap:** step 3 needs WP-140 (apply human inputs) and `Status` writes need WP-108, neither is a listed dependency of WP-120 (contradiction C-2). WP-109 depends on WP-107, 105. WP-215 depends on WP-120, 210, 211, 212. Also used: WP-101 (contracts), WP-111/112 (publish, merge), WP-130 (digest, step 10), WP-330/302 (steps 6, 7). Blocking owner decision for Stage 2: WP-201 (stack and staging host).

## 12. Status and open decisions

Status: `[SPEC]` for the dispatcher, queue and retry rules; `[BUILT]` for the guards it calls.

| ID | Open decision | ESTIMATE / default |
| --- | --- | --- |
| O-1 | What `autonomy.mode: assisted` and `gated` change for `/arima:run` (spec 4.1 defines the key, not the effect) | `assisted` = dry-run plus confirm per unit |
| O-2 | Tie-break inside a rank | PO priority, then size, then age |
| O-3 | WIP limit number (spec 7.1 names it) | = developer count; start with 1 (R-04) |
| O-4 | Turn cap per run (spec 13.5 requires one, gives no value; `runAgent` needs `maxTurns`) | S 30, M 50, L 80 turns |
| O-5 | Does `--only` bypass rank order and review-queue limit? | Bypass order only; every guard still applies |
| O-6 | Retry-once: same packet and same budget, or fresh worktree? | Fresh worktree, same packet, budget = remaining cap |

Resolved since writing (see `07-known-gaps.md` G-24, G-25, G-50): C-1, C-2 and C-3 below are fixed in the contracts and work packages. Contradictions found: C-1 exit code 3 has two meanings across scripts (`03-contracts.md` section 8). C-2 WP-120 omits WP-140/108 though spec 7.2 steps 3 and 9 need them. C-3 spec 7.12 says second failure blocks the item, spec 7.1 says third failed review/QA attempt blocks it: they are different counters (run errors versus rework attempts); the dispatcher must keep both, and `03-contracts.md` section 9 mentions only the second. C-4 `03-contracts.md` section 3.1 says `budget_usd <= min(per_run_cap, remaining story budget)` while spec 13.5 says caps may overshoot after spend is added; the dispatcher refuses to start rather than trusting the cap.
