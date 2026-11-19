# Feature spec: Release and operations (Phases 5 to 8)

> Status: planned (Stage 4, v0.4). Work packages: WP-401 (Phase 5), WP-402 (release and production deploy), WP-403 (hypercare, G4, incidents, CRs, recurring jobs, retro), WP-404 (remaining hard stops), WP-410 (eval E-R1). Spec: 6.5 to 6.8, 7.7 to 7.11, 11.1, 14, 15.3. Contracts: `03-contracts.md` sections 4, 5, 8, 9. Decisions: D-23, D-29, D-31, D-37 to D-42, D-44 to D-48, S10. Tags: `[BUILT]` exists with tests; `[SPEC]` required by the spec; `[PROPOSED]` introduced here, binding when the named package freezes it. Headings follow the feature template; all of Stage 4 runs **attended only** (D-41). Hosting is local (D-47): production, staging and previews are Docker Compose projects on the owner machine, and the only production deploy path is the approval-gated local script `arima-release`; GitHub Actions never deploys.

## 1. Purpose and spec refs

Take a milestone-complete build to production safely and keep it healthy: stabilize and prove a release candidate (6.5, G3), ship it only with human approval (6.6, hard stop `prod_deploy`), stabilize in production and close the build project (6.7, G4), then run operations through incidents, change requests, recurring jobs and retros (6.8, 7.8 to 7.11). Principle 7 (humans own production and money) and principle 10 (fail closed) govern every sub-feature; the point of this file is that each "MUST wait for a human" is a refusal in code, not a sentence in an agent file.

| Sub-feature | Spec | Package | Command or entry |
| --- | --- | --- | --- |
| F06a Stabilization, G3 | 6.5, 7.4, 7.7 | WP-401 | `/arima:stabilize` (new 19th command, D-46; playbook `arima-phase --phase 5`), gate via `/arima:gate G3` |
| F06b Release, production deploy | 6.6, 10.4, 11.1 | WP-402 | `/arima:release <version>` + host script `arima-release` |
| F06c Hypercare, G4 | 6.7 | WP-403 | `/arima:hypercare [--days N]`; the daily hypercare work runs inside `/arima:run` (operations, D-46) |
| F06d Incident and hotfix | 7.8, 7.7 | WP-403 | `/arima:incident <description or alert id>` |
| F06e Change request | 7.9 | WP-403 | `/arima:cr <description>` |
| F06f Retro and lessons | 7.11 | WP-403 | `/arima:retro [MS-NN]` |
| F06g Recurring jobs | 7.10 | WP-403 | no command; due jobs run inside `/arima:run` (priority 7 of 7.2.4, operations scope) |
| F06h Remaining hard stops | 11.1 | WP-404 | enforcement code, no command |

## 2. Command or entry point and arguments

All skills are thin (`03-contracts.md` section 11): `disable-model-invocation: true`, `allowed-tools` lists exact script paths, the body maps each exit code to a message and ends on one next command. Spec 14 fixes 18 commands; D-46 says Phase 5 runs through its own playbook command and `/arima:run` refuses it, so **`/arima:stabilize` is added as the 19th command** (spec 14 is amended; RD-F06-1). It runs `arima-phase --phase 5` (F07) and ends by opening G3 with `/arima:gate G3`. `/arima:run` covers Phase 4 and operations only.

| Entry | Arguments | Validation (exit 2 on failure) | Who runs |
| --- | --- | --- | --- |
| `/arima:stabilize` | none (`--dry-run` prints the plan and cost) | G2 Approved (or the solo-lite equivalent) and all Must stories in release scope Done, or the PO calls the release | human |
| `/arima:release` | `<version>` or `rollback` | version matches `vMAJOR.MINOR.PATCH` (ids schema), greater than the last tag, not already a Releases row; `rollback` takes no other argument | human only |
| `arima-release` `[PROPOSED]` | subcommands `rc`, `plan`, `notes`, `tag`, `deploy`, `rollback` | `deploy` accepts only `<version>` and `--dry-run`; `rollback` accepts only `--dry-run`; **any other flag is a usage error** | host process only (the human session); no role agent, including devops (RD-F06-3) |
| `/arima:hypercare` | `[--days N]` | integer, default 14 (D-31), **minimum 7**: `N` below 7 is refused with exit 2 because the G4 exit needs 7 consecutive days at SLO (G-41, RD-F06-7) | human or orchestrator |
| `/arima:incident` | `<description or alert id>` | non-empty; alert id looked up, text stored as untrusted | human or devops |
| `/arima:cr` | `<description>` | non-empty; secret scan (exit 6 style refusal) | human |
| `/arima:retro` | `[MS-NN]` | MS id exists and its stories are Done or moved | orchestrator |

## 3. Preconditions (IF/THEN)

- IF all Must stories in release scope are Done, or the PO calls the release, THEN Phase 5 may start (6.5 entry). ELSE the dispatcher does not create Phase 5 units.
- IF G3 is not Approved THEN `/arima:release` stops at exit 40 and creates nothing (6.6 entry). Under solo-lite only G1 and G3 are enforced (`profiles/solo-lite.yaml`), so G3 is still required there; G4 is not: hypercare still runs at least 7 days and ends with the closure report, shown in the digest, with no G4 page (RD-F06-6).
- IF the kill switch is on or unreadable THEN every entry stops at preflight, exit 12 `[BUILT]` (D-39).
- IF the production target has no approval recorded on the release page THEN `arima-release deploy` refuses (F06b rule R1).
- IF a P1/P2 incident is open THEN it outranks every other item in the plan of the day (7.2.4, `02-stages.md` section 7).
- IF a critical or high security finding is open without a human-accepted risk record THEN merge and release are blocked (hard stop `critical_finding`).
- IF G4 is Approved THEN Phase 8 work (incidents, CRs, recurring jobs) is the only work; a new feature re-enters at Phase 1 as a CR-sized discovery (6.8).

## 4. Inputs and input handling (validation, trust)

| Input | Source | Validation | Trust |
| --- | --- | --- | --- |
| Release scope, stories, bugs, RTM | mirror `stories`, `bugs`, `requirements`, `test_cases` | mirror schema; RTM computed by script, never by agent (WP-340) | data |
| Merged PR titles for notes | GitHub via host script | titles must carry an ID (S9); other titles listed as "unlinked" | untrusted text, quoted |
| Approval record | **live Notion read** of the Releases row (`Prod deploy approval`, `Prod deploy approver`) `[BUILT]` human-only properties | value `Approved`; approver passes `checkApprover()` (D-40 placeholder) | trusted only if Notion is reachable; otherwise treated as absent |
| Alert or user report text (INC, CR, feedback) | Notion, monitoring, issues | stored inside `untrusted` blocks; never executed | untrusted (spec 11.3) |
| Production configuration and secrets | the file `~/.config/arima/production.env` and the `production` Compose project on the owner machine (D-29, D-47); outside every role sandbox and worktree | read only by `arima-release deploy` and `rollback` | secret, never printed or logged |
| Migration flag | PR label `migration` and the path patterns `migration_paths` of the stack file (`stacks/default-web/stack.yaml`: `db/migrations/**`); the architect may change them only through an ADR accepted by the tech-lead (RD-F06-5) | data |
| Availability series | the health and smoke probes that `arima-release probe` records at every hypercare-day run plus the container restart counts of the `production` Compose project (RD-F06-8) | one value per probed day; a day with no probe is "no data" and does not count toward the 7 consecutive days | data |

Rule: the packet builder gives role agents none of the production configuration, the approval fields, or the deploy script path (agents' deny list gains `arima-release` `[PROPOSED]`, WP-402). The devops agent also has no Docker daemon access (it edits `infra/**` files; the host scripts `arima-deploy staging|preview` and `arima-release` run Docker), because daemon access would reach the `production` project on the same machine (RD-F06-3).

## 5. Processing steps

**F06a Stabilization (6.5), WP-401**
1. Code freeze: tech-lead verdict, then **host script** `arima-release rc` tags `vX.Y.Z-rc.N` (no agent holds push credentials, D-37; the spec text that has the tech-lead tag is amended, C-1). After the tag the queue admits only BUG and INC items and `arima-merge` refuses `feat/` branches `[PROPOSED]`.
2. In parallel: regression, integration, cross-browser and cross-device (qa); load and stress against NFR targets (devops + qa) on the local staging project, whose CPU, RAM and port limits are stated in the SAD; dynamic scan of **staging only** (security); accessibility audit (ux + qa). Each produces its report artifact (`test-reports`, `security-report`, performance report).
3. Pentest if the profile says so (`human_pentest`: none, recommended, required); human-run.
4. UAT scripts are generated from acceptance criteria (orchestrator); humans run them on staging; results recorded as Test Cases of type UAT plus a Documents row "UAT report" and a Human task (no new database; spec 8.1 "Notion Test Runs" is amended, C-4, RD-F06-10).
5. Daily defect triage by severity (7.7): S1/S2 block, S3 needs an accepted workaround, S4 does not block.
6. Go/No-Go meeting (7.3, WP-302): each agent returns `verdict.result` `go` or `no_go` with evidence (`03-contracts.md` 3.3). A `no_go` is shown, never overridden by the orchestrator.
7. `arima-gate G3` evaluates G3 mechanically, then the orchestrator opens the page (exit 40 if criteria unmet, reserved code).

G3 criteria (6.5) and how each is checked: 0 open S1/S2 (script over mirror); every open S3 has an accepted workaround (field present, human-set); RTM coverage per `rtm_coverage_at_g3` (`none` / `must_requirements` / `all_requirements`, script); performance targets met (report values against NFR targets, script reads a structured result `[PROPOSED]`); no open critical/high finding without accepted risk (script over the Risks rows; `Accepted` is human-only, RD-F06-15); UAT signed (human, G3 approver); runbook and rollback plan exist and pass template validation `[BUILT]`.

**F06b Release (6.6), WP-402** (`/arima:release <version>`)
1. devops writes the release plan (what changes in the `production` Compose project, the backup step, the rollback target); notes are **generated** from merged PR titles (principle 4) and only reworded by an agent; the version tag and the GitHub release are created by the host script with the machine token. The images are built locally from a clean checkout of the RC commit and tagged `<service>:<version>`. Release record = Releases row with `Status: Candidate`.
2. Orchestrator sets `Status: Awaiting approval` through the engine (Status writes are engine-only `[BUILT]` rule) and posts an Urgent-page @mention (D-23, 12.3). **Stop: wait for the human.** If the migration flag is set, the same wait covers `prod_data_migration` (F06h).
3. Human sets `Prod deploy approval = Approved` on the release page.
4. `arima-release deploy <version>` (host, after approval): R1 to R6 below, then, in order: back up the production named volumes (the backup script), start the new images in the `production` Compose project one service at a time (**health-gated replacement**: a service is replaced only when its readiness endpoint answers, and the old container stays until the new one is ready), run the production smoke test, and roll back to the previous image tags if it fails (RD-F06-2). The deploy script touches only Compose projects named `production` and its own volumes.
5. In parallel: user guide, FAQ, release notes published (ba + orchestrator); support knowledge base and escalation matrix (devops).
6. Exit checklist: production smoke passed; release record complete; no rollback within 24 hours (checked by the next daily runs).

Deploy rules `[PROPOSED]` in code, frozen by WP-402, each with a test that tries to break it:
- R1 No override: no flag, environment variable, config key or file disables the check. The parser rejects unknown flags; a test greps the bundle for any bypass token and a mutation test removes the check.
- R2 Read the approval live from Notion at the moment of deploy, never from the mirror. Notion unreachable or unreadable means refuse (same fail-closed rule as D-39).
- R3 `Prod deploy approval == Approved` and the approver is a listed approver through `checkApprover()`; a placeholder pass is logged as `method: placeholder`.
- R4 The release row names the version and the RC commit; the script deploys exactly that commit; a different tag or later commit needs a new approval (RD-F06-4).
- R5 G3 is Approved, no open S1/S2, no open critical finding without accepted risk.
- R6 `hardstop.hit` event with `prod_deploy` on every refusal; `deploy.staging` is not reused for production, a new event `deploy.production` is added `[PROPOSED]`.
- Rollout on a single local host is health-gated replacement, not percentage stages (RD-F06-2); the approval is re-read between services (R2) and a withdrawn approval halts the replacement and rolls back to the previous tags.
- R7 `arima-release rollback` restores the previously deployed, previously approved image tags and, only if a migration ran, the pre-deploy volume backup; it needs no new approval (it returns to an already approved state) but is run by the human session only, and every run posts an Urgent @mention (RD-F06-3).

**F06c Hypercare (6.7).** 1) `/arima:hypercare` writes `.arima/state/hypercare.json` (`start`, `days`, `ends`) `[PROPOSED]`. 2) Daily, inside `/arima:run`: `arima-release probe` records the health and smoke results, thresholds are tightened to half of the normal ones (RD-F06-8), incident triage (devops), hotfixes via F06d. 3) Final ops manual and runbooks (devops). 4) At the end: hypercare report, closure report, lessons, then `arima-gate G4`. G4 criteria: no open P1/P2; availability at or above the SLO (default 99.5%, D-31) for 7 consecutive days; operations docs complete; closure report accepted (human sponsor).

**F06d Incident and hotfix (7.8).** 1) INC id from `arima-ids next INC`; Incidents row with priority P1 (down, data loss, breach), P2 (major function broken), P3 (workaround), P4 (minor). 2) devops triages and proposes the mitigation in its report; it never touches production (C-5, RD-F06-3). A rollback is `arima-release rollback`, run by the human; a config or flag change in production is a hotfix release that passes the same approval-gated deploy. P1 and P2 raise an Urgent @mention at once. 3) A developer works on `hotfix/INC-NNN-slug`; "expedited" means P1/P2 priority in the queue and no milestone or review-queue limit; **review, QA, CI, human PR approval and merge-script conditions are not relaxed** `[PROPOSED]`. 4) Production deploy is still the F06b hard stop, sent as an urgent @mention. 5) P1/P2: blameless postmortem (template sections `[BUILT]`: summary, impact, timeline, root cause, contributing factors, what went well, action items, no-blame statement) within 5 working days; actions become backlog stories linked through `Incidents.Actions`.

**F06e Change request (7.9).** 1) `arima-ids next CR`; row `Submitted`. 2) ba writes the impact analysis (affected REQs, stories, tests, complexity, cost, schedule, risk); status `Impact analysis`. 3) Approval: PO if budget and deadline are unchanged, else sponsor; regulated adds sponsor sign-off (`change_requests` rule); solo-lite is informal. Row to `Pending decision`; `Decision` and `Approver` are human-only `[BUILT]`. 4) On Approved the baseline version increments (baseline-G1 v1.1) and new or changed stories enter the backlog; the frozen copy is written by the baseline script (WP-331), never by an agent. 5) ba updates SRS and RTM links; the change ships in a normal release.

**F06f Retro and lessons (7.11).** At milestone end: orchestrator computes the inputs (ledger metrics, rework reasons, findings, vetoes) by script; agents propose LES records (`Scope`: `project` or `upstream`); the tech-lead approves a project lesson and the owner may veto it from the digest (RD-F06-12); approved project lessons are written by a script to `.arima/overrides/<role>.md` or `.arima/overrides/<LES-id>.json` and rendered by the packet builder into `## Conditions` `[PROPOSED]`; upstream lessons become a scrubbed proposal file for a human to open as a PR to the ARIMA repo (agents hold no push credential, and the repo is public so client data must be stripped).

**F06g Recurring jobs (7.10).** A pure function `due(job, lastRun, today)` over `.arima/state/recurring.json` `[PROPOSED]` decides which jobs the plan of the day adds at priority 7.

| Job | Cadence | Owner (who does the work) | Output | Due rule |
| --- | --- | --- | --- | --- |
| Dependency and security updates | weekly | devops + security | update PRs, SBOM | 7 days after last run |
| SLO and cost report | monthly | orchestrator | report page | first run of a new calendar month |
| Backup restore test | quarterly | devops (script-run on staging data) | restore test record | 3 months; RD-F06-13 |
| Disaster-recovery drill | yearly | devops prepares, the owner runs the production-backup restore | DR test report | 12 months; human-run |
| Platform deprecation check | monthly | tech-lead | adaptive maintenance stories | new calendar month |
| Tech-debt allocation | every milestone | tech-lead + po | about 15 to 20% of capacity | at `/arima:plan` |
| Analytics and feedback review | monthly | po + ux | new backlog items | new calendar month; feedback text is untrusted |

Ownership and dispatch (RD-F06-9): the orchestrator is the dispatcher of every recurring job (it decides due-ness from `recurring.json` and creates the work unit); the role in the Owner column does the work; the PO (the owner) is involved only where the row says so (tech-debt share is a tech-lead proposal the PO can veto in the digest; the analytics review is prepared by ux and its resulting backlog items are shown in the digest). No job needs a scheduler: due jobs run inside `/arima:run` (attended until Gate U). A job never starts when the daily or project budget is exhausted.

## 6. Outputs and side effects

| Output | Location or system | Format | Written by | Validated by |
| --- | --- | --- | --- | --- |
| Releases, Incidents, Change Requests, Lessons, Gates, Bugs, Documents rows; Urgent-page @mentions (D-23) | Notion, through the outbox; `Status` only by the engine; never a delete | outbox entries `[BUILT]` | agents propose, orchestrator pushes | outbox schema, human-only refusal |
| Runbooks, ops manual, baseline increment, release notes, SBOM | repo `docs/ops/`, `docs/spec/baseline-G1/`, GitHub release (10.4) | Markdown, catalog templates | devops, ba; baseline by script (WP-331) | template validator `[BUILT]` |
| RC tag and version tag | git | tags `vX.Y.Z-rc.N`, `vX.Y.Z` | host script only | `arima-release` tests |
| `overrides/`, `state/hypercare.json`, `state/recurring.json` | `.arima/` on `arima-state` | JSON, Markdown `[PROPOSED]` | scripts only | schemas (WP-403) |
| Events: `gate.opened`, `gate.decided`, `hardstop.hit`, `item.status`, `run.*` `[BUILT]`; `deploy.production`, `deploy.rollback`, `release.rc_tagged`, `incident.opened`, `incident.closed`, `cr.decided`, `lesson.applied`, `probe.recorded` `[PROPOSED]`, registered by WP-101 or the package that builds them | `.arima/events.jsonl` | one `ArimaEvent` per line | scripts, hooks | `event.schema.json` |
| Ledger rows | `.arima/ledger.jsonl` | one per run, always; phase 5 to 8, item `INC-`/`CR-`/`MS-`/`G3` | `arima-run-agent` | `ledger.schema.json` `[BUILT]` |

## 7. Exit codes

Registry `[BUILT]` codes are reused (0, 2, 12, 13, 14 as `arima-preflight`; `arima-gate` 40 reserved). New codes are **PROPOSED** and are added to `03-contracts.md` section 8 in the same change that builds each script.

| Code | Meaning | Registry status |
| --- | --- | --- |
| `arima-release` 0, 2 | ok; usage (including any unknown flag) | PROPOSED (0 and 2 follow the registry pattern) |
| `arima-release` 12, 14 | kill switch on; environment or credential missing | `[BUILT]` meaning (preflight) |
| `arima-release` 40 | G3 criteria unmet (rc, release) | reserved by `arima-gate` |
| `arima-release` 50 / 51 / 52 | production approval absent or not Approved / approver not listed / data-migration approval absent | PROPOSED, WP-402 and WP-404 register them |
| `arima-release` 53 / 54 | smoke test failed and rollback ran / rollback also failed (page the human); `rollback` returns 0 on success and 54 on failure | PROPOSED, WP-402 |
| `arima-incident` 0, 2, 60 | ok; usage; postmortem overdue (`check`) | PROPOSED |
| `arima-cr` 0, 2, 61 | ok; usage; baseline bump refused (no approved decision by an approver) | PROPOSED |
| `arima-lessons` 0, 2, 62, 6 | ok; usage; lesson not approved by a human; content contains a secret | PROPOSED (6 as `arima-init`) |
| `arima-hypercare` 0, 2, 40 | ok; usage (`--days` below 7, RD-F06-7); G4 criteria unmet | PROPOSED / reserved, WP-403 registers them |

## 8. Conditions and rules

| Rule | Enforced by | Status |
| --- | --- | --- |
| IF target is production THEN approval on release page is required, no override | `arima-release deploy` R1 to R6; `deploy.test.ts` | `[SPEC]` WP-402 |
| IF migration files are flagged in the PR THEN a separate approval on the release page is also required | F06h; `hardstops-v04.test.ts` | `[SPEC]` WP-404 |
| IF a critical/high finding is open without an accepted-risk record THEN `arima-merge` (code 30) and release (code 40) refuse | WP-404 | `[SPEC]` |
| IF a dependency licence is not on the approved list (`arima.yaml` `licence.allowed`, default Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD) THEN the PR check fails and a Question to the owner is raised (hard stop `licence`, a legal matter) | WP-404, RD-F06-11 | `[SPEC]` |
| IF a new paid service or account appears THEN raise a Question with cost and alternatives, never assume (7.5) | WP-404 | `[SPEC]` |
| IF profile is solo-lite THEN G4 is not a gate and CRs are informal; regulated adds required pentest, PDF evidence export, legal at G1 and G3 | profile files `[BUILT]`, gate code WP-330 | `[BUILT]` data |
| IF the daily budget or project budget is exhausted THEN no recurring job or hypercare run starts | preflight `[BUILT]` | `[BUILT]` |
| Postmortem due 5 working days (weekdays only, as D-32) after the incident is Resolved (RD-F06-14); an incident open longer than 5 working days is flagged separately in the digest | `arima-incident check` | `[PROPOSED]` |
| Hard-stop ids are fixed; none of this feature may add or remove one | `hardstops.ts`, `hardstop-ids.test.ts` | `[BUILT]` |

Hard-stop details (F06h, WP-404; spec 11.1, ids from `hardstops.ts`):

| Id | Detected by | Action | Resolved by | Gap found |
| --- | --- | --- | --- | --- |
| `prod_data_migration` | migration paths and PR label | require approval on release page | human release approver | Releases has one approval property, no migration one; add `Data migration` checkbox and a human-only `Data migration approval` (schema change, bump `template_schema_version`) |
| `new_paid_service` | declared services manifest diff `[PROPOSED]` | Question to sponsor, work paused | sponsor | the spec names "dependency and infra review" but no data source |
| `licence` | dependency audit in CI | PR blocked | tech-lead alternative, or human approval | no approved-licence list exists in `arima.yaml` yet: add `licence.allowed` (RD-F06-11) |
| `critical_finding` | security scans | merge and release blocked | fix or human-accepted risk | `Risks.Status` has value `Accepted` but it is **not** human-only in `notion/schema.ts`, so an agent could set it; add `humanOnlyValues: ['Accepted']` and a human-only `Accepted by` (RD-F06-15) |

## 9. Failure handling

Columns: failure; result recorded (event, ledger, exit code); state left behind; who is told. Safe to re-run: `plan`, `notes`, `check`, `report`; `deploy` is safe to re-run because R1 to R6 are re-evaluated every time; a half-finished rollout is resumed only after a fresh approval read.

| Failure | Result recorded, state left, who is told |
| --- | --- |
| Smoke test fails during replacement | stop the replacement, roll back to the previous image tags (and restore the volume backup only if a migration ran), exit 53, event `deploy.production` with result `rolled_back`, an INC P1 is opened, urgent mention; rollback failure is exit 54 and a page to the human |
| Notion unreachable at deploy time | refuse (R2), exit 50, `hardstop.hit prod_deploy`, nothing deployed, digest alert |
| Run fails twice, third failed attempt, budget cap | as spec 7.12: Blocked plus Question, ledger row, never a silent retry |
| Output fails validation (report, template, secret scan) | run result `fail`, output discarded, counts as a run failure (not an `attempt`) |
| Postmortem overdue | exit 60 from `check`, digest alert (red health) and a Human task to the PO; never auto-closes the INC |
| Approval withdrawn after deploy started | the script re-reads R2 between services, halts, and rolls back to the previous tags (restoring an approved state needs no new approval, RD-F06-3) |
| Restore test needs production data | the quarterly restore test uses a staging backup (synthetic data); production data is never copied into staging or prompts (spec 11.3); only the yearly DR drill restores a production backup, run by the owner into a throwaway Compose project that is destroyed afterwards (RD-F06-13) |

## 10. Tests and verification

- Unit: `deploy.test.ts` (every refusal path R1 to R6, unknown flag, Notion error, stale approval, placeholder approver), `hardstops-v04.test.ts` (each of four hard stops has a test that tries to break it), `incident.test.ts` (working-day arithmetic), `cr.test.ts` (approver rule, baseline bump only after human decision), `recurring.test.ts` (due table), `lessons.test.ts` (override render is additive only and secret-scanned), an `arima-gate G3` table test.
- Mutation checks (manual, recorded in the review file): remove R2, R3 and R4 one by one; delete the unknown-flag rejection; make `Risks.Status` agent-writable; each must fail a test.
- Eval E-R1 (stub agents then real, WP-410, spec 15.3 item 4): release, simulated incident and CR on the eval project; production deploy refused without approval, then succeeds after a human sets it. See F10.
- `rollback.test.ts` (WP-402): rollback restores the previous tags, needs no approval, refuses any flag, and is refused for a role (`ARIMA_ROLE` set); `hypercare.test.ts`: `--days 6` exits 2, probe days and the 7-consecutive-days rule.
- Real check on the dev project before `done`: one real Releases row approved by hand; deploy against a stub Docker wrapper that records its calls and a throwaway `production-eval` Compose project; one real postmortem page.
- Judge **J4** at the end of Stage 4 (`docs/process/JUDGE.md`): asked to bypass the production gate by every route (flag, env, mirror edit, stale approval, agent-written Notion property).

## 11. Dependencies

WP-350 (v0.3 eval) before WP-401 (which also needs `arima-phase` from WP-320 through WP-350); WP-401 and WP-213 before WP-402; WP-402 and WP-302 before WP-403; WP-402 before WP-404 and WP-405; WP-403 and WP-404 before WP-410 (`work-packages.yaml`). Contracts needed frozen: gate decision record and `checkApprover()` (WP-330), baseline freeze (WP-331), RTM (WP-340), meeting engine (WP-302), merge script code 30 (WP-112). Agents: devops (WP-213), tech-lead (WP-212), security (WP-313), qa (WP-211), ba (WP-310).

## 12. Status and resolved decisions

Status: everything `[SPEC]` or `[PROPOSED]`. Built and reusable: hard-stop ids, Releases, Incidents, Change Requests and Lessons databases with human-only approval fields, postmortem and CR templates (sections), kill switch, outbox human-only refusal. Decided under `09-owner-decisions.md` (D-46, D-47):

| Decision | Reason | Implemented by |
| --- | --- | --- |
| RD-F06-1: add `/arima:stabilize` (19th command) for Phase 5; `/arima:run` refuses Phase 5 and Phase 6 work; spec 14 is amended | D-46 names "the stabilization command" | WP-401 |
| RD-F06-2: production rollout on the local host is health-gated replacement per service with the old container kept until the new one is ready, a smoke test, and automatic rollback; no 10/50/100 stages | One host cannot split traffic; keeps the deploy portable to K3s later (09 section 3) | WP-402 |
| RD-F06-3: production is touched only by `arima-release deploy` and `arima-release rollback`, run by the human session; devops proposes mitigation in its report, never runs Docker against production and has no Docker daemon access (host scripts run staging and preview); a config or flag change is a hotfix release through the same approval; rollback needs no new approval because it returns to an approved state (C-5) | An irreversible production action is a critical blocker (09 section 1); daemon access would reach the `production` project | WP-402, WP-213, `roles.ts` (deny `arima-release`) |
| RD-F06-4: the approval is valid for one version and one RC commit; any other tag or commit needs a new approval | A stale approval must not ship unreviewed code | WP-402 (`deploy.test.ts`) |
| RD-F06-5: migration paths come from `stacks/default-web/stack.yaml` (`db/migrations/**`) plus the PR label `migration`; changing them needs an ADR accepted by the tech-lead | Stack-specific data lives with the stack | WP-404 |
| RD-F06-6: solo-lite opens no G4 page; hypercare still runs at least 7 days and ends with the closure report in the digest | Profile enforces G1 and G3 only | WP-403 |
| RD-F06-7: `/arima:hypercare --days N` refuses N below 7 with exit 2 (default 14) | G-41; G4 needs 7 consecutive days | WP-403 |
| RD-F06-8: availability comes from the probes recorded at each hypercare-day run plus restart counts; a day without a probe is "no data"; tightened alert thresholds are half of the normal ones | No scheduler (D-41) and no cloud monitoring (D-47); honest about gaps | WP-403 (`arima-release probe`) |
| RD-F06-9: the orchestrator dispatches every recurring job; the owner role in the table does the work; tech-debt share and analytics items are shown in the digest for veto | 09 section 1: agents run the team, the owner reviews results | WP-403 (`recurring.test.ts`) |
| RD-F06-10: UAT results are Test Cases of type UAT plus a Documents row "UAT report" and a Human task; no new database; spec 8.1 is amended (G-36, C-4) | Smallest change | WP-401 |
| RD-F06-11: licence allow-list in `arima.yaml` `licence.allowed` (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD); anything else is a hard stop and one question to the owner (a legal matter) | Apache-2.0-compatible per CLAUDE.md | WP-404 |
| RD-F06-12: the tech-lead approves project lessons (additive only; lessons that touch hard stops, guard rules or an agent "Must not" section are rejected by a validator); the owner may veto from the digest; upstream lessons are scrubbed proposal files a human opens as a PR | Agents decide inside the team (09 section 1); the learning loop must not weaken safety | WP-217, WP-403 (`lessons.test.ts`) |
| RD-F06-13: the quarterly restore test restores a staging backup into a scratch Compose project; only the yearly DR drill restores a production backup, run by the owner | Spec 11.3: no production personal data in staging or prompts | WP-403 |
| RD-F06-14: the postmortem clock starts at Resolved | Spec silent; Started would be due before the fix | WP-403 |
| RD-F06-15: `Risks.Status` value `Accepted` and a new `Accepted by` property are human-only; Releases gets a `Data migration` checkbox and a human-only `Data migration approval` (template bump) | G-27: an agent could otherwise satisfy `critical_finding` | WP-404 |
| RD-F06-16: tags (RC and version) and the GitHub release are created by host scripts; spec 6.5 step 1, 6.4 step 7, 6.6 and 11.2 are reworded (C-1) | D-37, D-38 | WP-402, WP-401 |
| RD-F06-17: Q-21 (seat or API key) and optional OpenTelemetry do not block v0.4; default is the Team seat and OpenTelemetry off | CLAUDE.md names the seat; WP-405 stays an owner package that can be skipped | WP-405 |

No item is left open that blocks a package. The seat terms for unattended runs are an OWNER matter only at Gate U (F09).
