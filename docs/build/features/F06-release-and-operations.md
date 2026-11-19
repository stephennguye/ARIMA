# Feature spec: Release and operations (Phases 5 to 8)

> Status: planned (Stage 4, v0.4). Work packages: WP-401 (Phase 5), WP-402 (release and production deploy), WP-403 (hypercare, G4, incidents, CRs, recurring jobs, retro), WP-404 (remaining hard stops), WP-410 (eval E-R1). Spec: 6.5 to 6.8, 7.7 to 7.11, 11.1, 14, 15.3. Contracts: `03-contracts.md` sections 4, 5, 8, 9. Decisions: D-23, D-29, D-31, D-37 to D-42, S10. Tags: `[BUILT]` exists with tests; `[SPEC]` required by the spec; `[PROPOSED]` introduced here, binding when the named package freezes it. Headings follow the feature template; all of Stage 4 runs **attended only** (D-41).

## 1. Purpose and spec refs

Take a milestone-complete build to production safely and keep it healthy: stabilize and prove a release candidate (6.5, G3), ship it only with human approval (6.6, hard stop `prod_deploy`), stabilize in production and close the build project (6.7, G4), then run operations through incidents, change requests, recurring jobs and retros (6.8, 7.8 to 7.11). Principle 7 (humans own production and money) and principle 10 (fail closed) govern every sub-feature; the point of this file is that each "MUST wait for a human" is a refusal in code, not a sentence in an agent file.

| Sub-feature | Spec | Package | Command or entry |
| --- | --- | --- | --- |
| F06a Stabilization, G3 | 6.5, 7.4, 7.7 | WP-401 | no own command; playbook inside `/arima:run`, gate via `/arima:gate G3` |
| F06b Release, production deploy | 6.6, 10.4, 11.1 | WP-402 | `/arima:release <version>` + host script `arima-release` |
| F06c Hypercare, G4 | 6.7 | WP-403 | `/arima:hypercare [--days N]` |
| F06d Incident and hotfix | 7.8, 7.7 | WP-403 | `/arima:incident <description or alert id>` |
| F06e Change request | 7.9 | WP-403 | `/arima:cr <description>` |
| F06f Retro and lessons | 7.11 | WP-403 | `/arima:retro [MS-NN]` |
| F06g Recurring jobs | 7.10 | WP-403 | no command; due jobs run inside `/arima:run` (priority 7 of 7.2.4) |
| F06h Remaining hard stops | 11.1 | WP-404 | enforcement code, no command |

## 2. Command or entry point and arguments

All skills are thin (`03-contracts.md` section 11): `disable-model-invocation: true`, `allowed-tools` lists exact script paths, the body maps each exit code to a message and ends on one next command. Spec 14 fixes 18 commands; **Phase 5 has none** `[SPEC]`, so it is entered by the dispatcher (spec 6.5 entry) and its gate by `/arima:gate G3`. Open decision OD-1 (a `/arima:stabilize` command would make 19, so not proposed).

| Entry | Arguments | Validation (exit 2 on failure) | Who runs |
| --- | --- | --- | --- |
| `/arima:release` | `<version>` | matches `vMAJOR.MINOR.PATCH` (ids schema), greater than the last tag, not already a Releases row | human or orchestrator |
| `arima-release` `[PROPOSED]` | subcommands `rc`, `plan`, `notes`, `tag`, `deploy` | `deploy` accepts only `<version>` and `--dry-run`; **any other flag is a usage error** | host process only |
| `/arima:hypercare` | `[--days N]` | integer, default 14 (D-31), **minimum 7** because exit G4 needs 7 consecutive days `[PROPOSED]` | orchestrator |
| `/arima:incident` | `<description or alert id>` | non-empty; alert id looked up, text stored as untrusted | human or devops |
| `/arima:cr` | `<description>` | non-empty; secret scan (exit 6 style refusal) | human |
| `/arima:retro` | `[MS-NN]` | MS id exists and its stories are Done or moved | orchestrator |

## 3. Preconditions (IF/THEN)

- IF all Must stories in release scope are Done, or the PO calls the release, THEN Phase 5 may start (6.5 entry). ELSE the dispatcher does not create Phase 5 units.
- IF G3 is not Approved THEN `/arima:release` stops at exit 40 and creates nothing (6.6 entry). Under solo-lite only G1 and G3 are enforced (`profiles/solo-lite.yaml`), so G3 is still required there; G4 is not (see OD-6).
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
| Production credentials | secret store the sandbox cannot read (D-29) | read only by `arima-release deploy` | secret, never printed or logged |
| Migration flag | PR labels and path patterns for migration files | patterns stack-specific, set at G2 (OD-5) | data |
| Availability series | monitoring source (not specified by the spec) | numeric, one value per day | data (OD-7) |

Rule: the packet builder gives role agents none of the production credentials, the approval fields, or the deploy script path (agents' deny list gains `arima-release` `[PROPOSED]`, WP-402).

## 5. Processing steps

**F06a Stabilization (6.5), WP-401**
1. Code freeze: tech-lead verdict, then **host script** `arima-release rc` tags `vX.Y.Z-rc.N` (no agent holds push credentials, D-37; spec says tech-lead tags, see contradictions). After the tag the queue admits only BUG and INC items and `arima-merge` refuses `feat/` branches `[PROPOSED]`.
2. In parallel: regression, integration, cross-browser and cross-device (qa); load and stress against NFR targets (devops + qa); dynamic scan of **staging only** (security); accessibility audit (ux + qa). Each produces its report artifact (`test-reports`, `security-report`, performance report).
3. Pentest if the profile says so (`human_pentest`: none, recommended, required); human-run.
4. UAT scripts are generated from acceptance criteria (orchestrator); humans run them on staging; results recorded as Test Cases of type UAT plus a Human task `[PROPOSED]` (spec 8.1 names "Notion Test Runs", which is not one of the 19 databases; contradiction C-4).
5. Daily defect triage by severity (7.7): S1/S2 block, S3 needs an accepted workaround, S4 does not block.
6. Go/No-Go meeting (7.3, WP-302): each agent returns `verdict.result` `go` or `no_go` with evidence (`03-contracts.md` 3.3). A `no_go` is shown, never overridden by the orchestrator.
7. `arima-gate G3` evaluates G3 mechanically, then the orchestrator opens the page (exit 40 if criteria unmet, reserved code).

G3 criteria (6.5) and how each is checked: 0 open S1/S2 (script over mirror); every open S3 has an accepted workaround (field present, human-set); RTM coverage per `rtm_coverage_at_g3` (`none` / `must_requirements` / `all_requirements`, script); performance targets met (report values against NFR targets, script reads a structured result `[PROPOSED]`); no open critical/high finding without accepted risk (script; see OD-4); UAT signed (human, G3 approver); runbook and rollback plan exist and pass template validation `[BUILT]`.

**F06b Release (6.6), WP-402** (`/arima:release <version>`)
1. devops writes the release plan; notes are **generated** from merged PR titles (principle 4) and only reworded by an agent; the version tag is created by the host script. Release record = Releases row with `Status: Candidate`.
2. Orchestrator sets `Status: Awaiting approval` through the engine (Status writes are engine-only `[BUILT]` rule) and posts an Urgent-page @mention (D-23, 12.3). **Stop: wait for the human.** If the migration flag is set, the same wait covers `prod_data_migration` (F06h).
3. Human sets `Prod deploy approval = Approved` on the release page.
4. `arima-release deploy <version>` (host, after approval): R1 to R6 below, then protected deploy job, **gradual rollout**, smoke test, rollback if the smoke test fails.
5. In parallel: user guide, FAQ, release notes published (ba + orchestrator); support knowledge base and escalation matrix (devops).
6. Exit checklist: production smoke passed; release record complete; no rollback within 24 hours (checked by the next daily runs).

Deploy rules `[PROPOSED]` in code, frozen by WP-402, each with a test that tries to break it:
- R1 No override: no flag, environment variable, config key or file disables the check. The parser rejects unknown flags; a test greps the bundle for any bypass token and a mutation test removes the check.
- R2 Read the approval live from Notion at the moment of deploy, never from the mirror. Notion unreachable or unreadable means refuse (same fail-closed rule as D-39).
- R3 `Prod deploy approval == Approved` and the approver is a listed approver through `checkApprover()`; a placeholder pass is logged as `method: placeholder`.
- R4 The release row names the version and the RC commit; the script deploys exactly that commit; a different tag or later commit needs a new approval (staleness rule, OD-3).
- R5 G3 is Approved, no open S1/S2, no open critical finding without accepted risk.
- R6 `hardstop.hit` event with `prod_deploy` on every refusal; `deploy.staging` is not reused for production, a new event `deploy.production` is added `[PROPOSED]`.
- Gradual rollout: stages 10%, 50%, 100% with the smoke test between them is an **estimate**, not in the spec; the hosting choice (WP-201) decides what is possible (OD-2).

**F06c Hypercare (6.7).** 1) `/arima:hypercare` writes `.arima/state/hypercare.json` (`start`, `days`, `ends`) `[PROPOSED]`. 2) Daily: tighter alert thresholds (values unspecified, OD-7), incident triage (devops), hotfixes via F06d. 3) Final ops manual and runbooks (devops). 4) At the end: hypercare report, closure report, lessons, then `arima-gate G4`. G4 criteria: no open P1/P2; availability at or above the SLO (default 99.5%, D-31) for 7 consecutive days; operations docs complete; closure report accepted (human sponsor).

**F06d Incident and hotfix (7.8).** 1) INC id from `arima-ids next INC`; Incidents row with priority P1 (down, data loss, breach), P2 (major function broken), P3 (workaround), P4 (minor). 2) devops triages and mitigates (rollback, flag, config): production actions go through the same approval-gated script (OD-8, contradiction C-5). 3) A developer works on `hotfix/INC-NNN-slug`; "expedited" means P1/P2 priority in the queue and no milestone or review-queue limit; **review, QA, CI, human PR approval and merge-script conditions are not relaxed** `[PROPOSED]`. 4) Production deploy is still the F06b hard stop, sent as an urgent @mention. 5) P1/P2: blameless postmortem (template sections `[BUILT]`: summary, impact, timeline, root cause, contributing factors, what went well, action items, no-blame statement) within 5 working days; actions become backlog stories linked through `Incidents.Actions`.

**F06e Change request (7.9).** 1) `arima-ids next CR`; row `Submitted`. 2) ba writes the impact analysis (affected REQs, stories, tests, complexity, cost, schedule, risk); status `Impact analysis`. 3) Approval: PO if budget and deadline are unchanged, else sponsor; regulated adds sponsor sign-off (`change_requests` rule); solo-lite is informal. Row to `Pending decision`; `Decision` and `Approver` are human-only `[BUILT]`. 4) On Approved the baseline version increments (baseline-G1 v1.1) and new or changed stories enter the backlog; the frozen copy is written by the baseline script (WP-331), never by an agent. 5) ba updates SRS and RTM links; the change ships in a normal release.

**F06f Retro and lessons (7.11).** At milestone end: orchestrator computes the inputs (ledger metrics, rework reasons, findings, vetoes) by script; agents propose LES records (`Scope`: `project` or `upstream`); a human approves (OD-9); approved project lessons are written by a script to `.arima/overrides/<role>.md` or `.arima/overrides/<LES-id>.json` and rendered by the packet builder into `## Conditions` `[PROPOSED]`; upstream lessons become a scrubbed proposal file for a human to open as a PR to the ARIMA repo (agents hold no push credential, and the repo is public so client data must be stripped).

**F06g Recurring jobs (7.10).** A pure function `due(job, lastRun, today)` over `.arima/state/recurring.json` `[PROPOSED]` decides which jobs the plan of the day adds at priority 7.

| Job | Cadence | Owner | Output | Due rule (estimate) |
| --- | --- | --- | --- | --- |
| Dependency and security updates | weekly | devops + security | update PRs, SBOM | 7 days after last run |
| SLO and cost report | monthly | orchestrator | report page | first run of a new calendar month |
| Backup restore test | quarterly | devops | restore test record | 3 months; see OD-10 |
| Disaster-recovery drill | yearly | devops | DR test report | 12 months; human-supervised |
| Platform deprecation check | monthly | tech-lead | adaptive maintenance stories | new calendar month |
| Tech-debt allocation | every milestone | tech-lead + po | about 15 to 20% of capacity | at `/arima:plan` |
| Analytics and feedback review | monthly | po + ux | new backlog items | new calendar month; feedback text is untrusted |

## 6. Outputs and side effects

| Output | Location or system | Format | Written by | Validated by |
| --- | --- | --- | --- | --- |
| Releases, Incidents, Change Requests, Lessons, Gates, Bugs, Documents rows; Urgent-page @mentions (D-23) | Notion, through the outbox; `Status` only by the engine; never a delete | outbox entries `[BUILT]` | agents propose, orchestrator pushes | outbox schema, human-only refusal |
| Runbooks, ops manual, baseline increment, release notes, SBOM | repo `docs/ops/`, `docs/spec/baseline-G1/`, GitHub release (10.4) | Markdown, catalog templates | devops, ba; baseline by script (WP-331) | template validator `[BUILT]` |
| RC tag and version tag | git | tags `vX.Y.Z-rc.N`, `vX.Y.Z` | host script only | `arima-release` tests |
| `overrides/`, `state/hypercare.json`, `state/recurring.json` | `.arima/` on `arima-state` | JSON, Markdown `[PROPOSED]` | scripts only | schemas (WP-403) |
| Events: `gate.opened`, `gate.decided`, `hardstop.hit`, `item.status`, `run.*` `[BUILT]`; `deploy.production`, `release.rc_tagged`, `incident.opened`, `incident.closed`, `cr.decided`, `lesson.applied` `[PROPOSED]` | `.arima/events.jsonl` | one `ArimaEvent` per line | scripts, hooks | `event.schema.json` |
| Ledger rows | `.arima/ledger.jsonl` | one per run, always; phase 5 to 8, item `INC-`/`CR-`/`MS-`/`G3` | `arima-run-agent` | `ledger.schema.json` `[BUILT]` |

## 7. Exit codes

Registry `[BUILT]` codes are reused (0, 2, 12, 13, 14 as `arima-preflight`; `arima-gate` 40 reserved). New codes are **PROPOSED** and are added to `03-contracts.md` section 8 in the same change that builds each script.

| Code | Meaning | Registry status |
| --- | --- | --- |
| `arima-release` 0, 2 | ok; usage (including any unknown flag) | PROPOSED (0 and 2 follow the registry pattern) |
| `arima-release` 12, 14 | kill switch on; environment or credential missing | `[BUILT]` meaning (preflight) |
| `arima-release` 40 | G3 criteria unmet (rc, release) | reserved by `arima-gate` |
| `arima-release` 50 / 51 / 52 | production approval absent or not Approved / approver not listed / data-migration approval absent | PROPOSED |
| `arima-release` 53 / 54 | smoke test failed and rollback ran / rollback also failed (page the human) | PROPOSED |
| `arima-incident` 0, 2, 60 | ok; usage; postmortem overdue (`check`) | PROPOSED |
| `arima-cr` 0, 2, 61 | ok; usage; baseline bump refused (no approved decision by an approver) | PROPOSED |
| `arima-lessons` 0, 2, 62, 6 | ok; usage; lesson not approved by a human; content contains a secret | PROPOSED (6 as `arima-init`) |
| `arima-hypercare` 0, 2, 40 | ok; usage (days below 7); G4 criteria unmet | PROPOSED / reserved |

## 8. Conditions and rules

| Rule | Enforced by | Status |
| --- | --- | --- |
| IF target is production THEN approval on release page is required, no override | `arima-release deploy` R1 to R6; `deploy.test.ts` | `[SPEC]` WP-402 |
| IF migration files are flagged in the PR THEN a separate approval on the release page is also required | F06h; `hardstops-v04.test.ts` | `[SPEC]` WP-404 |
| IF a critical/high finding is open without an accepted-risk record THEN `arima-merge` (code 30) and release (code 40) refuse | WP-404 | `[SPEC]` |
| IF a dependency licence is not on the approved list THEN the PR check fails; a human may approve | WP-404, OD-4 | `[SPEC]` |
| IF a new paid service or account appears THEN raise a Question with cost and alternatives, never assume (7.5) | WP-404 | `[SPEC]` |
| IF profile is solo-lite THEN G4 is not a gate and CRs are informal; regulated adds required pentest, PDF evidence export, legal at G1 and G3 | profile files `[BUILT]`, gate code WP-330 | `[BUILT]` data |
| IF the daily budget or project budget is exhausted THEN no recurring job or hypercare run starts | preflight `[BUILT]` | `[BUILT]` |
| Postmortem due 5 working days (weekdays only, as D-32) after the incident is Resolved (the spec does not say from when, OD-11) | `arima-incident check` | `[PROPOSED]` |
| Hard-stop ids are fixed; none of this feature may add or remove one | `hardstops.ts`, `hardstop-ids.test.ts` | `[BUILT]` |

Hard-stop details (F06h, WP-404; spec 11.1, ids from `hardstops.ts`):

| Id | Detected by | Action | Resolved by | Gap found |
| --- | --- | --- | --- | --- |
| `prod_data_migration` | migration paths and PR label | require approval on release page | human release approver | Releases has one approval property, no migration one; add `Data migration` checkbox and a human-only `Data migration approval` (schema change, bump `template_schema_version`) |
| `new_paid_service` | declared services manifest diff `[PROPOSED]` | Question to sponsor, work paused | sponsor | the spec names "dependency and infra review" but no data source |
| `licence` | dependency audit in CI | PR blocked | tech-lead alternative, or human approval | no approved-licence list exists in `arima.yaml` (OD-4) |
| `critical_finding` | security scans | merge and release blocked | fix or human-accepted risk | `Risks.Status` has value `Accepted` but it is **not** human-only in `notion/schema.ts`, so an agent could set it; add `humanOnlyValues: ['Accepted']` |

## 9. Failure handling

Columns: failure; result recorded (event, ledger, exit code); state left behind; who is told. Safe to re-run: `plan`, `notes`, `check`, `report`; `deploy` is safe to re-run because R1 to R6 are re-evaluated every time; a half-finished rollout is resumed only after a fresh approval read.

| Failure | Result recorded, state left, who is told |
| --- | --- |
| Smoke test fails during rollout | stop the rollout, roll back to the previous version, exit 53, event `deploy.production` with result `rolled_back`, an INC P1 is opened, urgent mention; rollback failure is exit 54 and a page to the human |
| Notion unreachable at deploy time | refuse (R2), exit 50, `hardstop.hit prod_deploy`, nothing deployed, digest alert |
| Run fails twice, third failed attempt, budget cap | as spec 7.12: Blocked plus Question, ledger row, never a silent retry |
| Output fails validation (report, template, secret scan) | run result `fail`, output discarded, counts as a run failure (not an `attempt`) |
| Postmortem overdue | exit 60 from `check`, digest alert (red health) and a Human task to the PO; never auto-closes the INC |
| Approval withdrawn after deploy started | the script re-reads R2 between rollout stages and halts; whether it then rolls back is OD-8 |
| Restore test needs production data | forbidden to copy into staging or prompts (spec 11.3); isolated environment or synthetic dataset (OD-10) |

## 10. Tests and verification

- Unit: `deploy.test.ts` (every refusal path R1 to R6, unknown flag, Notion error, stale approval, placeholder approver), `hardstops-v04.test.ts` (each of four hard stops has a test that tries to break it), `incident.test.ts` (working-day arithmetic), `cr.test.ts` (approver rule, baseline bump only after human decision), `recurring.test.ts` (due table), `lessons.test.ts` (override render is additive only and secret-scanned), an `arima-gate G3` table test.
- Mutation checks (manual, recorded in the review file): remove R2, R3 and R4 one by one; delete the unknown-flag rejection; make `Risks.Status` agent-writable; each must fail a test.
- Eval E-R1 (stub agents then real, WP-410, spec 15.3 item 4): release, simulated incident and CR on the eval project; production deploy refused without approval, then succeeds after a human sets it. See F10.
- Real check on the dev project before `done`: one real Releases row approved by hand; deploy against a stub host that records its calls; one real postmortem page.
- Judge **J4** at the end of Stage 4 (`docs/process/JUDGE.md`): asked to bypass the production gate by every route (flag, env, mirror edit, stale approval, agent-written Notion property).

## 11. Dependencies

WP-350 (v0.3 eval) before WP-401; WP-401 and WP-213 before WP-402; WP-402 and WP-302 before WP-403; WP-402 before WP-404 and WP-405; WP-403 and WP-404 before WP-410 (`work-packages.yaml`). Contracts needed frozen: gate decision record and `checkApprover()` (WP-330), baseline freeze (WP-331), RTM (WP-340), meeting engine (WP-302), merge script code 30 (WP-112). Agents: devops (WP-213), tech-lead (WP-212), security (WP-313), qa (WP-211), ba (WP-310).

## 12. Status and open decisions

Status: everything `[SPEC]`/`[PROPOSED]`. Built and reusable: hard-stop ids, Releases/Incidents/CR/Lessons databases with human-only approval fields, postmortem and CR templates (sections), kill switch, outbox human-only refusal.

| ID | Open decision (estimate in brackets) | Owner |
| --- | --- | --- |
| OD-1 | Phase 5 has no command; confirm dispatcher-driven entry (no 19th command) | owner |
| OD-2 | Rollout stages and hosting (10/50/100 estimate); depends on WP-201 | owner |
| OD-3 | Approval validity: bound to version plus RC commit; any change needs re-approval | owner |
| OD-4 | Approved-licence list location and default (estimate: Apache-2.0, MIT, BSD-2/3, ISC, 0BSD); accepted-risk record form | owner |
| OD-5 | Migration file patterns per stack, set at G2 | architect, owner |
| OD-6 | Does solo-lite open an informational G4 page (profile lists no G4)? | owner |
| OD-7 | Monitoring source for availability and alert thresholds; "tightened" value (estimate: half the normal threshold) | owner, WP-405 |
| OD-8 | May rollback and flag changes run without a new approval (restoring a prior approved state)? Estimate: yes for rollback, urgent mention sent | owner |
| OD-9 | Who approves lessons (estimate: PO; spec 7.11 is silent) | owner |
| OD-10 | Backup restore test versus "no production personal data in staging" (11.3) | owner |
| OD-11 | Postmortem clock starts at Resolved (estimate) rather than Started | owner |

Spec-versus-contracts notes found while writing this file (also reported to the owner):

- C-1: spec 6.5 step 1 has the tech-lead tag the RC and 6.4 step 7 has it merge; D-37/D-38 and `03-contracts.md` give tags, pushes and merges to host scripts only (S4 says the spec text is still to be reworded).
- C-4: spec 8.1 names "Notion Test Runs" as the master for UAT scripts; spec 9.1 and `notion/schema.ts` have no such database.
- C-5: spec 7.8 step 2 has devops mitigate production (rollback, flag, config) but 5.10 and 11.2 give devops staging secrets only and production access solely to the approval-gated script.
