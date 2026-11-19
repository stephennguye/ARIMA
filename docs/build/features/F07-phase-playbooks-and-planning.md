# Feature spec: Phase playbooks and planning (`/arima:setup`, `/arima:plan`, `/arima:discover`, `/arima:design`, `/arima:assign`)

> Status: planned (nothing here is built). Work packages: WP-214 (`/arima:setup`), WP-216 (`/arima:plan`), WP-320 (`/arima:discover`, `/arima:design`); `/arima:assign` has no work package of its own (OD-F07-1). Spec: 4.2, 6.1 to 6.3, 7.1 (sizes, milestone size), 7.3, 7.5, 7.6, 10.2, 14, D-10, D-12, D-25, D-27, D-29. Contracts: `03-contracts.md` sections 3, 7, 8, 11. ADRs and decisions: D-35 (solo first), D-37 and D-38 (host scripts own push and merge), D-40 (approver placeholder), D-41 (attended only), S10, S11.
>
> Tags: `[BUILT]` exists with tests; `[SPEC]` required by the spec; `[PROPOSED]` introduced here and frozen by the package named. Skills are thin (`03-contracts.md` section 11): logic lives in tested scripts, a skill maps exit codes to messages and ends on one next command.

## 1. Purpose and spec refs

Four phase commands and one team command that sit between the gates and the build loop. `/arima:discover` runs Phase 1 to the opening of G1 (spec 6.1); `/arima:design` runs Phase 2 to the opening of G2 (6.2); `/arima:setup` runs Phase 3 to a walking skeleton on staging (6.3, exit checklist, no gate); `/arima:plan [MS-NN]` builds or revises a milestone of 8 to 12 points (7.1, D-27); `/arima:assign` switches a role between agent and human (4.2, D-10) and hands over in-flight work. "Good" is observable: a phase can be stopped and re-run and finishes only what is missing; a fan-out never starts without one cost-and-plan question; a story is never split across milestones; `team.yaml` is changed only by a human-run script. Not implemented here: the gates themselves (F04), the daily run (F02), the agents (cards in `agents/`).

## 2. Command or entry point and arguments

| Skill (spec 14) | Script `[PROPOSED]` | Arguments | Who may run |
| --- | --- | --- | --- |
| `/arima:discover` | `arima-phase --phase 1` | none (spec 14); script also takes `--dry-run` (print plan and cost, spend nothing) | human or orchestrator |
| `/arima:design` | `arima-phase --phase 2` | none; same `--dry-run` | human or orchestrator |
| `/arima:setup` | `arima-phase --phase 3` plus `arima-setup check` | none | human or orchestrator |
| `/arima:plan` | `arima-plan [--milestone MS-NN] [--dry-run]` | optional `MS-NN` to revise; default plans the next milestone | human or orchestrator |
| `/arima:assign` | `arima-assign --role <role> --to <agent\|agent:NAME\|human:PERSON> [--yes]` | `<role>` is a `team.yaml` role key (`tech-lead` is accepted for `tech_lead`); `PERSON` must be a key under `people:` | **human only** |

All five skills use `disable-model-invocation: true` and `allowed-tools` with exact script paths. No role agent may run `arima-assign` or `arima-phase`; `arima-assign` also refuses when `ARIMA_ROLE` or `ARIMA_RUN_ID` is set in its environment `[PROPOSED]`. Agents cannot edit `team.yaml`: it is in the deny list (`roles.ts` `Edit(./team.yaml)`, `Write(./team.yaml)`) and the guard rule `protected-config` (`hooks.ts`) `[BUILT]`.

## 3. Preconditions (IF/THEN)

- IF preflight fails (config, kill switch, lock, budget, env) THEN stop with 10 to 14 `[BUILT]` (`preflight.ts`). `arima-assign` checks only the run lock, because changing config must work while paused (OD-F07-4).
- `/arima:discover`: IF G0 is not Approved THEN refuse. IF the profile does not enforce G0 (solo-lite lists only G1 and G3 in `profiles/solo-lite.yaml`) THEN the brief, budget plan and charter-equivalent must exist instead (S14). Enforced by `arima-gate --check-only` once WP-330 exists; until then `NOT ENFORCED YET`.
- `/arima:design`: IF G1 is not Approved (and baseline frozen) THEN refuse.
- `/arima:setup`: IF the profile enforces G2 and it is not Approved THEN refuse; IF the profile has no G2 (solo-lite) THEN G1 Approved is the entry. WP-214 is built in Stage 2, before the gate code (WP-330), so until then this check reads the Gates mirror directly `[PROPOSED]`. Credentials from humans must exist; a missing one raises a blocking Question and stops (6.3 inputs, 7.12 "missing credential", hard stop `missing_credential`).
- `/arima:plan`: IF a candidate story is not sized S, M or L THEN it cannot be planned (D-25; DoR, WP-106). IF the plan would exceed the remaining project budget THEN refuse (13.5). IF a milestone is `In progress` THEN revising it never moves an item that already left `Ready`.
- IF the next fan-out has not been confirmed with the cost-and-plan question THEN no unit is dispatched (rule P-1 below).
- `/arima:assign`: IF a run holds `.arima/run.lock` THEN refuse (exit 11); the change takes effect at the next run (spec 4.2) and interactive commands respect the lock (spec 12.4, WP-160).

## 4. Inputs and input handling (validation, trust)

| Input | Source | Validation before use | Trust | Why |
| --- | --- | --- | --- | --- |
| `arima.yaml`, `team.yaml` | app repo root | `arima-config validate` (schema + cross-field) `[BUILT]` | trusted after validation; agents cannot write them | profile, budget, parallelism, roles |
| Profile rules and gates | `profiles/*.yaml` | `profile.schema.json` `[BUILT]` | trusted | which artifacts and gates apply |
| Artifact catalog | `catalog/artifacts.yaml` | `catalog.test.ts` `[BUILT]` | trusted | the required artifacts per phase and profile |
| Stories, sizes, priorities, dependencies | mirror `stories.json` | DoR check (WP-106) | untrusted text, trusted fields (size, priority) | planning input |
| Ledger | `.arima/ledger.jsonl` | schema `[BUILT]` | trusted | cost estimates for the fan-out prompt |
| Human answers to the cost question | Notion Questions via mirror | answered-by is a listed human | untrusted text, trusted option label | go or no-go for fan-out |
| Arguments of `/arima:assign` | command line | role in the role list, person in `people:`, person has `notion_user` | untrusted until validated | who gets tasks |
| Brief, reference material, stakeholder answers | Notion, files | secret scan before any write back | **untrusted, quoted in `untrusted` blocks** (spec 11.3) | discovery content |

Not read: production credentials, other roles' worktrees, anything under `.arima/` by an agent.

## 5. Processing steps

**5.1 Shared playbook engine (`arima-phase`, WP-320, serves discover, design and setup)**

1. Preflight, then build the **phase DAG** from spec 6.x: each step has an id, owner role, kind, input paths and output artifact id from the catalog. Step state is derived from what exists (artifact present and passes the template validator `[BUILT]`, Notion row present), never from a progress file, so a re-run finishes only what is missing (idempotence, `04-agent-build-protocol.md` rule 7).
2. Compute the **fan-out plan**: the units that can run in parallel (6.1 steps 2, 4; 6.2 step 2; 6.3 step 2) and the sequential ones. Per unit: role, kind, inputs, run cap.
3. **Cost-and-plan question (P-1)**: build one Question (blocking, no default) showing units, estimated cost and total against remaining budget. Estimate per unit is `[PROPOSED]` the median ledger cost for that role and kind if at least 3 rows exist, otherwise half the run cap; upper bound is units times `budget.per_run_cap`. Options: run all (recommended when under 25% of the remaining project budget, an estimate), pilot only, run sequentially, cancel. **STOP** until answered (attended: asked in session; orchestrator run: raised in the digest and the phase waits). The answer is stored as a DEC record and covers the whole phase; re-ask only if the unit count grows or the pilot costs more than 1.5 times its estimate (the card rule 6 threshold).
4. **Pilot (P-2)**: run one unit first, chosen by a fixed rule (first unit in dependency order, smallest input). Validate with the report validator, template validator and secret scan. **STOP** with exit 4 if it fails or exceeds 1.5 times its estimate; no fan-out follows a failed pilot.
5. **Fan-out**: dispatch remaining units through the normal dispatcher path (packet, worktree, `arima-run-agent`; one run per unit, one ledger row each), up to `parallelism`. **Sequential fallback (P-3)**: IF the parallel mechanism is unavailable (parallelism set to 1, the dispatcher cannot start a second run, or agent teams are not enabled for meetings, spec 7.3) THEN run the same units one at a time in dependency order with the same caps; outputs and cost are unchanged, only elapsed time grows. The probe and the exact switch must be checked against current Claude Code docs before building (`CLAUDE.md` rule).
6. Questions follow 7.5: batched by topic, at most 10 per batch and per digest, highest impact first; an agent that cannot decide asks, it never invents a requirement.
7. Meetings at phase end (requirements review, design review) via the meeting engine (WP-302, F04).
8. **Exit check**: `arima-gate --gate G1|G2 --check-only` (mechanical checks, F04). Unmet criteria are listed and the phase continues; met criteria open the gate page. Discover and design **never approve** a gate; setup has no gate and ends with its checklist.

**5.2 Phase 1 steps (spec 6.1)**: ba interview plan and question batches; ux discovery set and architect NFRs and security requirements in parallel; ba PRD, URS, SRS; ba epics, stories, story map; requirements review meeting; qa testability review; baseline freeze to `docs/spec/baseline-G1/`; open G1. **Phase 2 steps (6.2)**: architect SAD, ADRs, OpenAPI, data model; then ux prototype, security threat model, qa master test plan, devops environment plan in parallel; orchestrator milestone plan (`arima-plan`), DoR and DoD; design review; open G2. Artifact lists per profile come from the catalog (`required_in`), for example solo-lite has no separate URS or master test plan (`rules` in the profile).

**5.3 Phase 3 steps (spec 6.3, WP-214)**: devops repo from the stack template, CI, staging as code, secrets wiring request, monitoring baseline; tech-lead conventions and PR template; qa end-to-end skeleton; security static analysis, dependency audit and secret scan in CI; developer walking skeleton (UI, API, database) on staging; orchestrator marks the board ready and first-milestone stories `Ready`. Three actions are human or host-script only: creating secrets (hard stop `secrets_change`; the agent asks a Question naming secret names, never values), installing the merge guard and `.githooks` (denied to roles), and activating the approval-gated deploy script (the stub from WP-213 in Stage 2, which refuses production, S10). `arima-setup check` evaluates the exit checklist: skeleton green on staging (health URL returns success, CI run green), every CI stage ran, merge guard and deploy script active.

**5.4 `arima-plan` (WP-216)**

1. Preflight; read stories sized and `Ready` (or `Backlog` meeting DoR), priority, dependencies, and pinned stories (already `In Progress` or later in this milestone).
2. Weights S=1, M=2, L=4; target 8 to 12 points (D-27). Order by priority, then by dependency (a story follows its dependencies in the same or an earlier milestone).
3. Fill greedily by priority: add the next story if the running total stays at or below 12; **a story that would exceed 12 is skipped and left for the next milestone, never split**; continue scanning smaller stories that fit. The skip rule is `[PROPOSED]` because spec 7.1 says only "fills by priority up to that range" (OD-F07-2).
4. If the total is under 8 and the backlog still has fitting stories, add them; if the backlog is exhausted, allow the short milestone and say so.
5. Budget check: sum of story budgets (S 1, M 3, L 6 USD, D-25) must not exceed remaining project budget (spec 13.5); **STOP** with exit 13 otherwise and print the over-budget list.
6. Warn if tech-debt stories are under about 15% of points (7.10, "about 15 to 20%"); a warning, not a refusal.
7. Revision (`MS-NN`): pinned stories stay; unstarted stories may be re-ordered or moved to a later milestone; a story already counted is never split or duplicated.
8. Write the Milestones row (`MS-NN` from `arima-ids next MS`) and the story-milestone links through the engine and outbox; produce the `milestone-plan` document from its template.

**5.5 `arima-assign` (spec 4.2, D-10)**

1. Refuse if `ARIMA_ROLE` or `ARIMA_RUN_ID` is set, the run lock is held, or `team.yaml` is invalid. Parse with the `yaml` Document API so comments are kept; write atomically; validate before and after.
2. Rule checks (**STOP** exit 3): a gate approver role (`sponsor`, `po`, `legal` where a gate needs it) may not become an agent (spec 4.2 rule, validator `[BUILT]`); `developer.count` may not exceed `parallelism.max_developer_agents`; the person must exist and have `notion_user`; `pjm` to human is refused in v1 (OD-F07-3); a human who is the sole approving reviewer may not also take `developer` (GitHub forbids self-approval, D-30; OD-F07-5).
3. Show the diff and the list of in-flight items; require `--yes` (the skill passes it only after the human confirms in the conversation).
4. Write `team.yaml`; write `.arima/state/handover.json` (script-owned, pending items) `[PROPOSED]`. The next daily run (step 3, apply human inputs) creates the tasks and notes through the engine.
5. Handover, agent to human: each open item of the role gets a Notion Human task (assignee, template link, due from `human_task_sla_hours`, 7.6) and a handover note (item state, last agent report, branch and worktree, open questions, attempt count, cost so far); the attempt count carries over, so the three-strikes rule cannot be reset by reassigning. Human to agent: open Human tasks for the role are set `Cancelled` with a note (retire, never delete), the human's partial output is listed as an input of the next packet, and the items return to the queue.
6. Commit the change on `chore/team-<role>` through the host publish script (WP-111) for the human's review (OD-F07-6). Write an `interactive` ledger row (cost 0) and event `team.changed` `[PROPOSED]`.

## 6. Outputs and side effects

| Output | Location or system | Format | Written by | Validated by |
| --- | --- | --- | --- | --- |
| Phase artifacts (PRD, SAD, ...) | repo `docs/`, Notion Documents | catalog templates | role agents, via outbox for Notion | template validator `[BUILT]`, report validator |
| Fan-out Question and DEC | Notion Questions, Decisions | question/decision records | engine | schema (WP-101) |
| Milestone plan, MS-NN row, story links | Notion Milestones, Stories | outbox entries | `arima-plan` via engine | outbox schema `[BUILT]`, `plan.test.ts` |
| Walking skeleton, CI, staging infra | app repo, staging | code | developer, devops | `arima-setup check` |
| `team.yaml`, `handover.json`, Human tasks | app repo, `.arima/state/`, Notion | YAML, JSON | `arima-assign`, then engine | `arima-config validate`, `team.schema.json` `[BUILT]` |
| Events | `.arima/events.jsonl` | `unit.dispatched`, `question.raised`, `gate.opened` `[BUILT]/[PROPOSED]`; `phase.step_done`, `team.changed` `[PROPOSED]` | scripts | `event.schema.json` |
| Ledger | `.arima/ledger.jsonl` | one row per run, always | `arima-run-agent` | `ledger.schema.json` `[BUILT]` |

Idempotent: re-running a phase, plan or setup changes nothing that already passes; `arima-assign` to the current value is a no-op with exit 0.

## 7. Exit codes

Registry `[BUILT]`: 10 to 14 as preflight; 2 usage; `arima-gate` 40 reserved. All others PROPOSED, added to `03-contracts.md` section 8 by the package that builds each script.

| Code | Meaning | Registry status |
| --- | --- | --- |
| `arima-phase` 0 | Phase complete and gate opened (or setup checklist green) | PROPOSED |
| `arima-phase` 2 | Usage, or phase entry condition not met | PROPOSED |
| `arima-phase` 3 | Waiting on human answers or credentials (blocking Questions open) | PROPOSED |
| `arima-phase` 4 | Pilot failed or over estimate; no fan-out | PROPOSED |
| `arima-phase` 5 | Cost-and-plan question answered "cancel" | PROPOSED |
| `arima-phase` 10 to 14, 40 | Preflight; gate criteria unmet (reuses `arima-gate` value) | `[BUILT]` / reserved |
| `arima-plan` 0, 2, 13 | Plan written; usage or unsized story; over budget | PROPOSED (13 reuses the preflight meaning) |
| `arima-plan` 3 | No plannable story | PROPOSED |
| `arima-assign` 0, 2, 3, 10, 11 | Done or no-op; usage or unknown role or person; rule refused; config invalid; run lock held | PROPOSED |

## 8. Conditions and rules

| Rule | Enforced by | Status |
| --- | --- | --- |
| P-1 one cost-and-plan question before any fan-out; P-2 pilot first; P-3 sequential fallback with identical outputs | `arima-phase`, `evals/playbooks` (WP-320) | `[SPEC]` principle in `01-architecture.md` section 4, code `[PROPOSED]` |
| Milestone 8 to 12 points, S=1 M=2 L=4, never split | `plan.test.ts` property tests: no story in two milestones; total in range unless backlog exhausted; deterministic | `[SPEC]` 7.1 |
| Gate approver roles map to humans | `arima-config` validator | `[BUILT]` |
| `team.yaml` is never written by an agent | deny list and guard rule `protected-config` | `[BUILT]` (advisory for developer and QA until the sandbox, WP-190) |
| Solo-lite enforces G1 and G3 only; discover opens G1, design skips opening G2 (G2 not enforced), setup entry is G1 | profile `gates`, `enforcedGates` (F04) | data `[BUILT]`, code `[SPEC]` |
| DPIA required when personal data is flagged, always in regulated, signed by a human legal role | catalog + gate check | `[SPEC]` 6.1 |
| Attended only (D-41); no scheduler call to these commands except through `/arima:run` | design rule | `[SPEC]` |
| Spec 14 lists `/arima:discover` and `/arima:design` as "human or orchestrator"; an orchestrator run cannot ask interactive questions, so the cost question waits in the digest | P-1 | `[PROPOSED]` |

## 9. Failure handling

| Failure | What it looks like | Result recorded | State left behind | Who is told |
| --- | --- | --- | --- | --- |
| A unit run errors | run result `error` | retry once; second failure Blocked + Question (7.12); ledger row | item Blocked | digest |
| Output fails validation | missing section, no report, secret | run `fail`, output discarded, attempt counted | none applied | digest |
| Pilot fails | exit 4 | event `phase.pilot_failed` `[PROPOSED]`, not a hard stop | no fan-out | human in session |
| Credential missing at setup | blocking Question | exit 3, `missing_credential` hard stop | setup resumable | sponsor or PO |
| `arima-assign` rule refused | exit 3 | no write | `team.yaml` unchanged | human |
| `arima-assign` crashes after writing `team.yaml` | handover.json absent | next run detects a team change with no handover and re-derives the in-flight list from the mirror `[PROPOSED]` | consistent | digest |
| Notion unreachable | outbox entries deferred | next push applies | local state fine | digest |

Safe to re-run: all five. Not safe to force: a pilot (it spends money); P-1 must be answered again if units were added.

## 10. Tests and verification

Existing: `config.test.ts` (approver-role validator), `agents.test.ts`, `skills.test.ts` (structure), `catalog.test.ts`, `profiles.test.ts`, `preflight.test.ts`, `guard-hardening.test.ts` (team.yaml protected). To write, each a sentence that can fail:

- `plan.test.ts`: fixed backlog yields the expected milestone; a story that would reach 13 points is skipped, not split; random backlogs never place a story twice; a revision keeps pinned stories; over-budget plan exits 13.
- `phase.test.ts`: the DAG matches spec 6.1 to 6.3 step tables; a re-run after deleting one artifact redoes only that step; no unit dispatches before the question is answered; a failing pilot blocks fan-out; with parallelism 1 the same units run in sequence with the same outputs.
- `assign.test.ts`: approver role to agent refused; count above cap refused; env `ARIMA_ROLE` set refused; run lock refused; handover written for each in-flight item; attempt count preserved; comments in `team.yaml` survive.
- `evals/playbooks` (WP-320) with stub agents; `evals/setup` (WP-214) skeleton on the throwaway repo; real smoke on the dev project (staging host from WP-201). The live tier is needed only for Notion task creation. Windows and Linux CI apply (paths, git, YAML newlines).

## 11. Dependencies

WP-214: WP-213, WP-210. WP-216: WP-109. WP-320: WP-310, WP-311, WP-312, WP-313, WP-302 (and through them WP-301, WP-330 for the exit check). Contracts: run packet and report (WP-101), `checkApprover()` (WP-330), baseline freeze (WP-331). Decisions: WP-201 (stack and host, S11), D-40, D-41.

## 12. Status and open decisions

`[SPEC]` all five commands; `[BUILT]` only the config validator, profiles, catalog, templates, role deny list and preflight that they rely on. `[PROPOSED]`: `arima-phase`, `arima-plan`, `arima-assign`, P-1 to P-3, greedy skip rule, handover file.

| ID | Open decision | Blocks |
| --- | --- | --- |
| OD-F07-1 | `/arima:assign` has a package: WP-232 (Stage 3, after human tasks WP-301). Resolved. |
| OD-F07-2 | Plan fill rule when the next story overshoots 12: skip and continue (proposed) or stop | WP-216 |
| OD-F07-3 | May `pjm` (the orchestrator) become human? The orchestrator is the only Notion writer (spec 2); proposed: refused in v1 | WP-320+ |
| OD-F07-4 | Should `arima-assign` run while the kill switch is on (proposed yes) | assign |
| OD-F07-5 | Human as developer and sole approver (GitHub forbids self-approval, D-30): refuse or require a second reviewer | solo mode |
| OD-F07-6 | Is `team.yaml` changed in the working tree (instant) or by PR on `chore/team-<role>` (reviewed but delayed)? | assign |
| OD-F07-7 | Cost estimate rule and the "under 25% of remaining budget" recommendation are estimates; calibrate after the first measured phase | WP-320 |

Discrepancies found: spec 6.1 step 8 freezes the baseline **before** opening G1, while 7.4 step 6 and 3.3 freeze it **on approval**; F04 and WP-331 must pick one (proposed: copy at open, mark frozen at approval). Spec 6.3 entry requires G2 approved but WP-214 (Stage 2) precedes the gate code (Stage 3) and solo-lite has no G2. Spec 7.1 says the third failed attempt blocks an item; `03-contracts.md` section 9 folds it into the `any open -> Blocked` row, so `arima-assign` handover must preserve the attempt count (stated above).
