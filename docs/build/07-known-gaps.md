# 07 Known gaps and contradictions

Found while writing the agent cards and feature specs (each writer read the spec, the code and the contracts independently). **None of these is hidden in the cards**: each card or feature file lists the items that touch it under "Open decisions". This register is the single list, with a disposition. Dispositions: **Fixed** (done in this change), **WP-nnn** (a work package owns it; the package's acceptance now includes it), **Spec** (needs a spec or spec-issue edit; owner decision where marked), **Owner** (owner decision), **Noted** (accepted as is, documented).

## A. Code defects and risks in what is already built

| ID | Finding | Disposition |
| --- | --- | --- |
| G-01 | Outbox entry `id` becomes a file name; the schema had no pattern, so a crafted id could move a file outside the outbox buckets | **Fixed**: id pattern in `outbox.schema.json` plus a test |
| G-02 | `init` pushes leftover outbox entries with `allowStatusWrites: true`, so a stale agent entry carrying `Status` would be applied by a human-run init (`init.ts`) | WP-104: init must pass the opt-in only for entries it created itself (ids prefixed `init-`) |
| G-03 | `preflight` requires `github.machine_token_env`, so `arima-init` exits 14 without a GitHub token although init makes no GitHub call | WP-101: require the GitHub token only for commands that use GitHub |
| G-04 | `status` reads the local `PAUSE` file only (spec 11.3 defines three sources); kill switch is checked before spawn, not during a running agent | WP-120: status uses the shared kill-switch function; spec 11.1 wording "exits immediately" to be clarified |
| G-05 | `roles.ts` still lets developer and devops `git push`, developer `gh pr create`, and gives developer, tech-lead, devops the GitHub token, contradicting D-37/S16 | WP-111 (drop push and token from roles; host publishes) |
| G-06 | `roles.ts` lets the orchestrator write `events.jsonl`, `ledger.jsonl`, `mirror/` by hand (`Write(./.arima/**)`), contrary to contract section 2 | WP-103: narrow the orchestrator's write scope to what it truly needs; guard already protects these for non-orchestrator roles |
| G-07 | `Write(./.arima/outbox/**)` lets an agent write into `applied/`, `rejected/`, `conflicts/` subfolders, not only top-level `*.json` | WP-104: guard rule or role pattern limited to top-level files; test |
| G-08 | The orchestrator agent file claims `init` and `pause` abilities, but `roles.ts` and the guard deny `arima-init` and `arima-pause` to any role run; its front-matter `tools` does not equal `allowedTools` | WP-102 (agent file cleanup in the orchestrator rework) |
| G-09 | Secret allow-list honoured only by the state push, not by outbox or init; a non-GitHub remote is pushed with no privacy check; developer `Edit`/`Write` have no path scope beyond cwd | WP-104 (allow-list in outbox), WP-190 (confinement); non-GitHub remotes: **Owner** decision |
| G-10 | `arima-notion pull/push` ignore the kill switch and run lock | WP-160 |
| G-11 | Only `kill_switch` and `budget_exceeded` are ever written as `hardstop.hit`; `missing_credential` (exit 14) is not recorded | WP-120 |
| G-12 | `status.ts` counts only result `error` as failed (ignores `fail`, `blocked`); the 3x-median and 30%-rework alerts of spec 13.5 do not exist in `budget.ts` | WP-130, WP-131 |
| G-13 | Ledger, events, outbox and run-report files carry no `schema_version`, though `01-architecture.md` section 6 requires versioned contracts | WP-195 (add and migrate) |
| G-14 | ADR-0006 mounts only the worktree, but a linked worktree's `.git` file points into the main `.git`, so `git commit` inside the container fails | WP-190 (design decision recorded as OD-F09-1) |

## B. Contract (`03-contracts.md`) corrections and gaps

| ID | Finding | Disposition |
| --- | --- | --- |
| G-20 | `arima-status` exit codes incomplete (also 1 and 2) | **Fixed** in contracts |
| G-21 | Work-unit `kind` list lacks orchestrator and QA kinds (digest, meeting, gate-pack, retro, regression, perf-test, a11y-test) | **Fixed** in contracts (proposed additions) |
| G-22 | Agent-report `verdict` and `criteria_map` rules do not fit QA's test-write mode, the architect's PR review, ux design-QA, or authoring kinds of security | **Fixed** in contracts: both are required only for the kinds named, optional elsewhere; ux and architect may return a `verdict` for review kinds |
| G-23 | Only Q and DEC ids are engine-allocated, but QA needs TC and BUG, BA needs REQ/US, architect ADR/NFR | **Fixed** in contracts: the engine allocates every id; agents propose records without ids, drafts use placeholders `NEW-1..n` that the engine rewrites |
| G-24 | Exit code 3 means "blocked" for `arima-run-agent` but "nothing to do" for the planned `arima-dispatch` | **Fixed**: dispatcher reserves 4 for "nothing to do" |
| G-25 | Two failure counters exist: retry-once (7.12: second run failure) and attempt counting (7.1: third failed review or QA) | **Fixed** in contracts section 9: separate counters, both documented |
| G-26 | No finding id prefix in spec section 2; no Findings database in the 19; bug severity S1-S4 not mapped to finding severities | Spec / **Owner**: propose `FND-nnn` kept in the run report only (no Notion database) until the owner decides |
| G-27 | `Risks.Status` "Accepted" is not human-only, so an agent could satisfy the `critical_finding` hard stop; `Releases` has one approval property but two approvals (deploy, data migration) | WP-404 (make Accepted human-only; add property in a template version bump) |
| G-28 | Unit `kind` `deploy-staging`: spec 7.1 has devops deploy after merge, 10.4 says staging deploys automatically on merge | Spec: pick automatic deploy by CI after merge; devops verifies (recorded in the devops card) |

## C. Spec contradictions and silences (for the owner, via spec issues)

| ID | Finding | Disposition |
| --- | --- | --- |
| G-30 | Spec 5.6, 6.4 step 7, 6.5, 11.2 have the tech-lead merging and tagging; D-37/D-38 give merge, tag and push to host scripts only | Spec (S4 text still to be reworded) |
| G-31 | `roles.ts`: tech-lead `gh pr review *` permits `--approve`, against D-30 (agent posts comment reviews only) | WP-212 (restrict to `--comment`) |
| G-32 | Spec 5.4 gives ux PR comments and serving the prototype; `roles.ts` gives neither. 6.4 step 6 makes a design-QA verdict an output | WP-311 |
| G-33 | Spec 5.3: ba does not set priorities, but nothing blocks `Priority` writes | WP-310 (human-only `Priority` for agents, template bump) |
| G-34 | Catalog `backlog` sections omit the spec 8.2 user-story fields (ID, title, linked REQs, complexity, test-case links); Stories has no Screens property though the DoR requires screens; solo-lite does not require wireframes but the DoR needs screens | WP-106 (DoR source of truth), template bump later |
| G-35 | Documents `Type` enum has no entry for wireframes, prototype, security report, pentest report | Template bump (WP-310/311/313) |
| G-36 | Spec 8.1 names a "Notion Test Runs" database for UAT; the 19 databases have none | **Owner**: use Documents rows, or add a database |
| G-37 | Spec 11.2 grants "run builds and tests" to orchestrator, ux, security, devops; `roles.ts` grants none | Spec / WP per role |
| G-38 | Spec 6.1 step 8 freezes the baseline before opening G1; 7.4 and 3.3 freeze on approval | Spec: freeze on approval (WP-331) |
| G-39 | `/arima:setup` (WP-214, Stage 2) precedes gate code (Stage 3); solo-lite has no G2 yet 6.3 requires G2 approved | Owner: accept "entry = owner confirms design" for the v0.2 eval |
| G-40 | Spec 12.1 "digest ready by 07:00" presumes a scheduler; D-41 forbids one until Gate U | Noted: attended digest on demand |
| G-41 | Hypercare minimum: G4 needs 7 consecutive days at SLO but `--days N` may be below 7 | WP-403 (refuse N < 7) |
| G-42 | Spec 15.3 says v0.2 is "unattended"; D-41 makes the v0.2 eval attended | Noted (02-stages) |
| G-43 | Spec 11.1 says "11 hard stops"; code has 16 | Spec text to say sixteen (D-42) |
| G-44 | Catalog `dpia` is flagged required for client-project without the "if personal data" condition (profiles have it) | Catalog fix with WP-312/313 |
| G-45 | Spec 5.1 phases for architect and security omit Phase 0/1 duties (feasibility note, compliance screen) | Noted in cards |

## D. Plan and process corrections

| ID | Finding | Disposition |
| --- | --- | --- |
| G-50 | WP-120 omitted dependencies WP-108 and WP-140 (spec 7.2 steps 3 and 9) | **Fixed** in `work-packages.yaml` |
| G-51 | WP-121 and WP-150 both claimed E-S1 | **Fixed**: WP-121 owns the stub scenario, WP-150 owns the harness |
| G-52 | `npm run eval` globs `evals/**/*.eval.ts` so real-agent evals would run in CI; `eval:agents` not in package.json | **Fixed** in WP-150 acceptance (separate config and script) |
| G-53 | `JUDGE.md` says read-only, but verification requires mutation attempts | **Fixed**: judge mutates a **copy** in a temp directory (stated in `05-verification.md` and JUDGE.md) |
| G-54 | `/arima:assign` had no work package | **Fixed**: WP-232 added |
| G-55 | WP-312 and WP-313 cite too few spec sections (Phase 0, 6.5, 7.9 duties; per-PR security triage uncovered) | **Fixed**: citations widened; per-PR scan triage added as WP-314 |
