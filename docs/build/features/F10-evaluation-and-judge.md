# Feature spec: Evaluation system (eval harness, live tier, judge, upgrade tests)

> Status: partly built. Built: v0.1 eval (`evals/v0.1/`), the live tier (`plugins/arima/scripts/test-live/`), the fixture scrubber, the independent-judge procedure and five saved reviews. Planned: the scenario harness, stub agents, deterministic graders, judge automation (WP-150, with WP-121), the migration test (WP-195), and the real-agent scenarios E-B1, E-D1, E-R1 (WP-220, WP-350, WP-410). Spec: 15.3, 15.4, 11.1, 13.5. Contracts: `03-contracts.md` sections 2, 5, 6, 8, 9. Verification policy: `05-verification.md` sections 1 to 5. Procedure: `docs/process/JUDGE.md`, `04-agent-build-protocol.md` steps 4, 6, 7, 8.
>
> Tags: `[BUILT]` exists with tests; `[SPEC]` required by the spec; `[PROPOSED]` introduced here, frozen by the package named. Honesty rule (`05-verification.md` top): built, tested and verified are different words; every result below says which it is.

## 1. Purpose and spec refs

Prove that ARIMA does what the spec says, at four distances from the real world. (1) **Tests** (unit, contract, guard battery) prove logic. (2) **Stub evals** run whole scenarios with deterministic fake agents, free and in CI (spec 15.4: "every change to ARIMA runs the evals before release"). (3) **Real-agent evals and the live tier** touch real Claude, Notion and GitHub, cost money or need tokens, and run by hand. (4) The **independent judge** is a fresh read-only agent that tries to break the work and finds gaps nobody planned. Spec 15.4 says `evals/` holds a sample brief and expected outcomes: required artifacts present and valid, gates reachable, RTM coverage computed, hard stops respected, ledger complete, cost within a set range. Principle 5 (no agent checks its own work) is the design rule: graders are code first, a verifier agent second, never the producing agent (`04-agent-build-protocol.md` rule 1).

## 2. Command or entry point and arguments

| Entry | Command | What it runs | Cost | In CI |
| --- | --- | --- | --- | --- |
| Stub evals `[BUILT]` | `npm run eval` = `vitest run --config vitest.evals.config.ts` (`include: evals/**/*.eval.ts`, `exclude: evals/agents/**` after WP-150, `testTimeout: 60000`, 180000 for E-S1 to E-S4) | v0.1 init eval, 8 tests | none | yes |
| Live tier `[BUILT]` | `ARIMA_LIVE=1 ARIMA_NOTION_TOKEN=... ARIMA_LIVE_PROJECT=<dev project dir> npm run test:live` (`vitest.live.config.ts`: `test-live/**/*.live.test.ts`, 120 s, `fileParallelism: false`); add `ARIMA_LIVE_RECORD=1` to refresh fixtures | real Notion on the dev workspace | tokens, no model | no; skipped unless all three variables are set |
| Real-agent evals `[PROPOSED]` | `npm run eval:agents` with its own `vitest.agents.config.ts` (`include: evals/agents/**/*.real.eval.ts`); WP-150 adds both (RD-F10-1) | `evals/agents/<role>/*.real.eval.ts`, E-B1, E-D1 (real), E-R1 (real) | real `claude -p`, about $0.15 to $0.25 per run minimum (handoff) | no |
| Judge `[PROPOSED]` | `npm run judge -- --checkpoint <J1..J5\|J-agent:<role>> --paths <file> --questions <file> [--max-budget-usd N]` (WP-150; default cap 5) | one read-only `claude -p` on a copy of the repo | estimate $1 to $5 per checkpoint, unmeasured | no |
| Upgrade test `[PROPOSED]` | part of `npm test` (`migration.test.ts`, WP-195) | previous-version fixtures | none | yes |

Environment read: `ARIMA_LIVE`, `ARIMA_LIVE_RECORD`, `ARIMA_LIVE_PROJECT`, `ARIMA_NOTION_TOKEN` (never printed). No role agent may run any of these; the judge runs with no Notion or GitHub token in its environment. Real-agent files live only under `evals/agents/` and the default eval config excludes that folder, so the glob clash is closed (RD-F10-1).

## 3. Preconditions (IF/THEN)

- IF a scenario needs a real system (Notion, GitHub, `claude -p`) THEN it lives in the live or real-agent tier, never in `npm run eval`. Enforced today only by file location (`test-live/` is excluded from `npm test`); for `evals/**` the exclusion of `evals/agents/**` is added by WP-150 and a test fails if a `*.real.eval.ts` file sits outside it (RD-F10-1).
- IF the live variables are not all set THEN the live tier is skipped, not failed (`describe.skipIf(!LIVE)` `[BUILT]`).
- IF a real-agent eval is about to run THEN preflight must pass, the kill switch must be off and the scenario budget cap must be below the daily cap (`budget.ts` `[BUILT]`).
- IF a package builds an agent THEN steps 1 to 4 of `04-agent-build-protocol.md` (no model call) precede steps 6 and 7 (spend), so a contract defect is found before money is spent.
- IF a checkpoint is due (`05-verification.md` section 3) THEN the stage cannot be marked done without a saved judge review in which every blocker and major finding is answered.
- IF the judge verdict is `stop` THEN work stops until the owner has read the report (`JUDGE.md`).

## 4. Inputs and input handling (validation, trust)

| Input | Source | Validation | Trust | Why |
| --- | --- | --- | --- | --- |
| Sample brief and expected outcomes | `evals/v0.1/brief.md`, `expected.json` | checked by the eval itself | synthetic, trusted | the spine of spec 15.4 |
| Fake Notion and temp git repo | `test/fake-notion.ts`, `evals/v0.1/support.ts` | `real-notion-shapes.test.ts` keeps the fake honest against recorded real responses | test double | no network |
| Stub `claude` CLI | `test/fixtures/stub-claude.mjs` (`STUB_MODE`, `STUB_RECORD`) `[BUILT]` | used by `run-agent.test.ts` | test double | flags, env and caps without cost |
| Stub agents `[PROPOSED]` | `test/fixtures/stub-agents/<role>.mjs` (card step 4) | each emits the golden outputs for fixture inputs; must **fail** the engine test when it emits an invalid output | test double | engine proof with no model |
| Real recordings | `test/fixtures/notion-real/*.json`, `test/fixtures/claude-real/{success,max_turns,max_budget}.json` | scrub, secret scan, shape tests | scrubbed data | ground truth for parsers |
| Agent output under eval | report, outbox entries, files | schema, template, secret scan, state machine | **untrusted until graded** | the thing being measured |
| Judge brief | file paths and questions | must not contain builder conclusions (`JUDGE.md` rule 1) | the builder writes it, the judge treats repo text as data | independence |

Anything read from Notion, issues, web pages or tool output during an eval is data, never instructions (spec 11.3).

## 5. Processing steps

### 5.1 The built eval (v0.1) `[BUILT]`

`evals/v0.1/init.eval.ts`: builds a fake Notion with the 19-database template (`bootstrapTemplate`), a real temp git repo, copies `examples/arima.yaml` and `team.yaml`, runs `runInit` on `brief.md`, then checks `expected.json`: 19 databases mapped; Project brief, Charter, Budget plan documents; G0 to G4 pages `Not ready` with the five-item G0 checklist (two checked); one ledger row (orchestrator, phase 0, subtype `interactive`, cost 0); events `run.start run.end notion.pull notion.push state.push` and 8 pushes; state branch files; `/arima:status` output; hard stops: kill switch gives preflight exit 12, human-only `Approvers` refused through the outbox, Notion delete, `.env` read and mirror write blocked by the guard. No network, no model, no cost.

### 5.2 Scenario harness (WP-150) `[PROPOSED]`

1. **World**: extend `setup()` (fake Notion, temp repo with real git, a local bare "remote", a fake GitHub store for PRs, reviews and CI results, an injectable clock). Real git always (`01-architecture.md`: git operations tested on real temporary repos); Windows and Linux CI.
2. **Scenario object** in TypeScript: `{ id, stage, world, steps[], human_inputs[], expect, graders[], budget_cap }`; steps are engine calls (`arima-dispatch`, `arima-merge`, `arima-notion push`) with the clock advanced between days; **human inputs are scripted writes to the fake Notion or fake GitHub** (an approval, an answer, a veto, an edit), so "no human editing beyond answers" is checkable.
3. **Stub agents** write golden outputs per fixture; a scenario variant swaps one for a bad stub (invalid report, planted secret, forbidden path, instruction inside an `untrusted` block) and expects the engine to refuse.
4. **Graders** are pure functions over the end state: event-sequence (ordered subsequence), ledger (rows equal `run.end` events, schema valid, per-story cost equals the sum), state-machine trace (every edge legal, attempts correct), outbox results (`applied`, `rejected`, `conflict`), git (squash merge, linear history, no push to default branch by anyone but the merge script, **no commit message, PR title or PR body contains an AI attribution line or a `Co-Authored-By` trailer naming Claude, D-48**), Notion duplicates, template validator `[BUILT]`, secret scan `[BUILT]`, side-effect diff (state before and after a refused action is identical), digest shape.
5. **Negative controls**: each refusal scenario also runs the same action in its allowed form and expects success, so a broken harness cannot pass by refusing everything (the pattern of `killtree.test.ts`).
6. **Verifier agent** (real tier only): a separate read-only agent receives a sample of claims and evidence and tries to disprove them; its verdict never replaces a grader.
7. **Judge automation**: see 5.5.

### 5.3 Acceptance scenarios (`05-verification.md` section 4)

**E-S1 five stories to Done with stub agents** (Stage 1; WP-121 builds the first version, WP-150 generalizes it). Inputs: five hand-written stories meeting the DoR (sizes S/M, criteria, REQ links, one UI story with screens), stub developer, qa, tech-lead and devops(staging) agents, stub host publish and merge scripts over a local bare remote, fake CI, scripted human PR approvals. Steps: day loop of `arima-dispatch` until the board is empty. Expected: `/arima:run` before the Phase 3 exit checklist is green is refused with exit 5 and the same run succeeds once it is green (negative control, D-46); every story walks Backlog, Ready, In Progress, In Review, In QA, PO Acceptance, Done along legal edges only (`03-contracts.md` section 9); `item.status` event per edge; one ledger row per run, per-story cost equals the ledger sum and the Notion Cost USD; `Status` changes written only with the engine flag (agent outbox `Status` writes rejected); merges only by `arima-merge` (the fake remote records who pushed); a digest from the template with lists capped at 10; a second dispatch of the same day creates no duplicates (idempotence). Graders: event-sequence, ledger, state trace, outbox, git, digest, duplicates.

**E-S2 failure loops** (Stage 1). Variants: (a) stub emits an invalid report: result `fail`, reason `report_invalid`, retry once, second failure gives Blocked plus Question (spec 7.12); (b) tech-lead stub returns `changes_requested` three times: third attempt gives Blocked and a Question, attempt counter 3; (c) fake CI fails once then passes: rerun once and continue; fails twice: BUG on the test; (d) stub reports cost above the story budget: Blocked with cost-so-far Question and `hardstop.hit` `story_budget`; (e) stub-claude `max_turns` mode: result `blocked`, item Blocked. Graders: state trace, attempt counts, Question fields (options with a recommendation, `blocking: yes`, no default on hard-stop matters), events, a ledger row for every failed or crashed run.

**E-S3 hard stops** (Stage 1; spec 11.1, ids from `hardstops.ts`). Variants: kill switch via Notion, via `PAUSE`, and with neither readable (preflight exit 12, no `run.start`); daily and project budget (exit 13); story budget; secret in agent output, in a brief, in an outbox entry, `.env` read, secrets-changing command; Notion delete tool; push or merge to the default branch, and `arima-merge` with CI, QA pass or the human review missing (code 30 each); `Status` write from an agent outbox; push of `.arima` to a public, unknown or non-GitHub remote; a commit carrying a `Co-Authored-By: Claude` trailer (refused by the hook, D-48). Expected: a `hardstop.hit` event with the right canonical id and an empty side-effect diff. Negative control per variant. Existing partial coverage `[BUILT]`: `hardstops.test.ts`, `guard-hardening.test.ts`, `killswitch-hardening.test.ts`, `state-privacy.test.ts`, and the v0.1 eval hard-stop block.

**E-S4 human edits win** (Stage 1). Steps: an agent enqueues an update with `base_values`; a human changes the same property in the fake Notion within the same minute; push. Expected: entry in `outbox/conflicts/`, the human's value kept in Notion and mirror, event `notion.conflict`, the orchestrator re-reads and re-proposes or raises a Question. Second part: a story in PO Acceptance receives a human veto with a reason; next run creates a BUG and moves the story to In Progress (spec 7.1 edge), digest shows it. Graders: outbox directories, mirror value, events, state trace, BUG record linked to the story.

**E-B1 five stories to staging with real agents** (Stage 2, WP-220; spec 15.3 v0.2). Attended (D-41); spec 15.3 is amended from "unattended" to "attended" (RD-F10-8). Inputs: throwaway repo and staging host chosen in WP-201, dev Notion workspace, five stories to the DoR, real roles, budgets per D-25. Steps: the human runs `/arima:run` and approves PRs. Expected: each story merged by `arima-merge`, the host rebuilds the local Docker staging from `main` (D-47) and the smoke and e2e tests pass against `http://localhost:<staging port>`, a `preview-<pr>` Compose project answers a smoke request before each item moves to In QA, digest and cost per story correct, no hard-stop failure, no guard bypass in `tool.blocked` and `tool.used` events, review-queue limit respected. Graders: the E-S1 set plus a staging probe; a verifier agent attempts to disprove the criteria-to-evidence map of two sampled stories. Cost: estimate five M stories at $3 plus overhead; the scenario cap is $30 (RD-F10-3). Judge J2 reads the result.

**E-D1 brief to G2** (Stage 3, WP-350; spec 15.3 v0.3). Inputs: the sample brief, scripted answers to questions only; profiles client-project and solo-lite. Steps: `/arima:init`, `/arima:discover`, `/arima:design`; a stub variant runs in CI, a real variant attended. Expected: every artifact the profile requires is present and passes the template validator (`catalog.ts`, `required_in`); every Must requirement has a story; every NFR has a target and verification method; question batches at most 10; G1 and G2 pages Ready for review with evidence packs; DPIA when personal data is flagged; **no human write to any document artifact** (history shows only `Answer`, `Answered by` and gate fields). Graders: catalog completeness, validator, RTM script (WP-340), question counts, human-write audit, "every REQ traces to the brief or an answered Question" (unsupported requirement means invention).

**E-R1 release, incident and change request** (Stage 4, WP-410; spec 15.3 v0.4). Steps: `/arima:stabilize` (Phase 5) with stubs, then G3 approved by a listed approver; `/arima:release` with (a) no approval: refused, exit 50, `hardstop.hit prod_deploy`, the stub Docker wrapper (standing in for the local daemon) records no call against the `production` project; (b) approval set through an agent outbox or by a non-approver: refused; (c) an unknown flag such as `--force`: usage error; (d) approval by the human: backup, health-gated replacement per service, smoke pass; a failing smoke test triggers automatic rollback (exit 53); `rollback` by the human restores the previous tags without a new approval; the migration variant needs its own approval; a hypercare request with `--days 6` is refused. Then an injected alert: INC P1, plan-of-the-day puts it first, `hotfix/INC-nnn`, production hard stop again, postmortem by day 5 with the template sections (clock advanced). Then a CR: impact analysis, PO approves when budget is unchanged and sponsor otherwise, baseline v1.1 written, stories enter the backlog; baseline refused without approval. Then a retro: an approved lesson appears in the next packet's Conditions. Graders: Docker-call log, events, outbox results, postmortem validator, baseline folder, plan order, and the D-48 attribution check on every commit and PR body. Mutation control recorded in the review: delete the approval check and the scenario must fail. F06 specifies the behaviours.

### 5.4 The live tier `[BUILT]`

- **What it proves**: facts about real Notion that the fake imitates. Four tests plus one recorder: the dev workspace verifies against the 19-database template with `Coverage` a formula and `Test results` a rollup; `last_edited_time` is rounded to the minute so it cannot detect same-minute edits; the outbox detects an out-of-band same-minute edit by value; an agent update applies and the mirror keeps Notion's own values. It uses one probe row ("ARIMA live test row (safe to ignore)") in Documents and never deletes anything.
- **What it does not prove**: any real GitHub behaviour (a recorded check on `ARIMA-Test` exists in `docs/process/reviews/2026-11-18-real-world-checks-notion-github.md`, but no automated live test), real `claude -p` behaviour, or any agent quality.
- **Fixtures**: with `ARIMA_LIVE_RECORD=1` the recorder saves five Notion responses through `scrub()` into `test/fixtures/notion-real/`. `scrub()` (`test-live/scrub.ts`) maps every UUID to a stable placeholder, `workspace_name` to "Test Workspace", person names to "Test User", e-mail to `test@example.com`, avatars to null, URLs to a neutral one. Guards: `judge4.test.ts` tests the scrubber and scans every committed fixture (placeholder ids only, no workspace name); `real-notion-shapes.test.ts` feeds the fixtures through ARIMA code and checks the fake against them (drift test).
- **Claude result fixtures** (`test/fixtures/claude-real/`): recorded from real `claude -p --output-format json` runs on 2026-11-18, scrubbed by hand (session id replaced by a fixed value); `real-results.test.ts` runs the secret scanner over them and parses them with `parseClaudeResult`. There is **no script** for this scrub yet; WP-191 adds `scripts/dev/scrub-claude-result.ts` and its test (RD-F10-4).
- **Procedure to add a fixture**: run on the dev project only, load the token into one process and never print it, record, run `judge4.test.ts` and `real-notion-shapes.test.ts`, read the diff for names before committing. The ARIMA repo is public; one old fixture still holds a workspace name in git history (STATE.md "History").

### 5.5 The judge `[BUILT]` procedure, `[PROPOSED]` automation

Procedure (`docs/process/JUDGE.md`): called before a stage, after a real-world check, after a spec-affecting draft and at each stage end; checkpoints J0 to J5 and J-agent (`05-verification.md` section 3). The judge gets file paths and a question, never the builder's conclusions; it is read-only, confirms claims by reading, running tests or running the tool, and ranks specific findings. It returns the fixed report: `VERDICT` (proceed, proceed after fixes, stop), confidence, BLOCKERS, MAJOR, MINOR, GAPS IN THE PLAN, CLAIMS I COULD NOT CONFIRM, WHAT I CHECKED. The builder saves it as `docs/process/reviews/<date>-<checkpoint>.md` with a response per finding (fixed, ADR or task, or evidence the judge was wrong); a finding is never silently ignored; the owner may overrule in writing, recorded in the same file. Existing examples answer in a table `# | Finding | Response` (`2026-11-18-judge-3.md`). Mutations: the judge must try them (`05-verification.md`) while JUDGE.md says "never edits the repository"; the reviews reconcile this by working in an extracted copy (judge 3: "reviewed an extracted copy"), which automation makes the rule (`docs/process/JUDGE.md` is amended to say so, RD-F10-9). From checkpoint J2 on the automated judge replaces the manually launched one; a manual launch stays allowed (RD-F10-5).

Automation (WP-150): 1) create a temporary copy of the repo at a named commit; 2) render the prompt from `JUDGE.md` plus the paths and questions file (reject a questions file that states a conclusion, by a keyword check and a human read); 3) run one headless `claude -p` with `Read Grep Glob` and Bash limited to test commands inside the copy, `Edit`/`Write` denied outside the copy, no Notion or GitHub token, `--max-budget-usd`; 4) validate the report shape (all seven headings, verdict word valid); 5) save the file with a response-table skeleton, one row per blocker and major finding; 6) exit 0 for proceed, 1 for fixes needed, 20 for stop. A test (`build-docs.test.ts` extension) fails when a saved review has a blocker or major row with an empty response and the matching package is marked done. Answering stays human or builder work.

### 5.6 Upgrade and migration tests (WP-195, then WP-503) `[PROPOSED]`

1. Freeze **previous-version fixtures** under `test/fixtures/upgrade/v0.1/`: a project directory produced by running the v0.1.x `init` against the fake (so it is real output, synthetic content): `arima.yaml`, `team.yaml`, `.arima/events.jsonl`, `ledger.jsonl`, `notion-map.json` with its `template_schema_version`, `mirror/*.json`, an outbox entry, a run report.
2. Per fixture: config validates; every ledger row and event line parses and validates; `arima-notion map --migrate` upgrades an older template (fake with a missing property) and a second run changes nothing (idempotent); a file with a newer `schema_version` than the code knows is refused, nothing is written; after migration `/arima:status` and a dry-run dispatch work.
3. Control: add a required field to a schema without a migration and the test must fail.
4. Rule from `01-architecture.md` section 6: a new field written by ARIMA means schema first, bump `schema_version` if readers could break, a migration, and a test loading the previous version. Ledger rows, events, outbox entries and run reports carry **no** `schema_version` today (only `arima`, `team`, `profile`, `ids`, `notion-map` schemas do), so version detection for them is by shape today; WP-195 adds an optional `schema_version` (integer, absent means 1) written by every writer and read by every reader, and additive optional fields stay safe while removals and renames need a migration (RD-F10-2).

## 6. Outputs and side effects

| Output | Location | Format | Written by | Validated by |
| --- | --- | --- | --- | --- |
| Eval result | stdout, vitest report | pass/fail | vitest | exit code |
| Scenario run directory | temp dir, removed in `afterAll` | repo + `.arima/` | harness | graders |
| Real-agent result table | the agent card, section 10 | measured cost and pass rate | builder | card rule 6 (cost above 1.5 times estimate updates the card) |
| Fixtures | `test/fixtures/{notion-real,claude-real,upgrade}` | scrubbed JSON | recorder, scrub | `judge4.test.ts`, `real-results.test.ts`, `migration.test.ts` |
| Judge review | `docs/process/reviews/<date>-<checkpoint>.md` | report + response table | judge automation, then builder | review-completeness test `[PROPOSED]` |
| Events and ledger rows of the eval project | temp `.arima/` | JSONL | engine | graders |

Evals never write to the real Notion workspace except the live probe row, and never push to a real remote.

## 7. Exit codes

`npm run eval`, `test:live` and `npm test` return vitest's own codes (0 pass, non-zero fail); they are not ARIMA scripts and are not in the registry (`03-contracts.md` section 8). New script `arima-judge` (`[PROPOSED]`, add to the registry in the same change):

| Code | Meaning | Registry status |
| --- | --- | --- |
| 0 | Verdict proceed, report saved | PROPOSED |
| 1 | Verdict proceed after fixes, report saved | PROPOSED |
| 2 | Usage (missing paths or questions, unknown checkpoint) | PROPOSED |
| 3 | Judge run failed or report shape invalid; nothing saved as a verdict | PROPOSED |
| 20 | Verdict stop: builder halts until the owner has read it | PROPOSED |
| 12, 13 | Kill switch on, budget exhausted (as preflight) | `[BUILT]` meaning |

## 8. Conditions and rules

| Rule | Enforced by | Status |
| --- | --- | --- |
| Graders are deterministic code; a verifier agent never replaces one | scenario shape, review | `[PROPOSED]` |
| Each refusal scenario has a negative control | harness helper | `[PROPOSED]` |
| Test data is synthetic; fixtures hold only placeholders | `judge4.test.ts`, `real-results.test.ts`, secret scanner | `[BUILT]` |
| Regression guards in `05-verification.md` section 5 are never deleted or weakened without an ADR and the owner | review rule | `[BUILT]` rule |
| Mutation checks: flip each new rule on a copy and confirm a test fails; result recorded in the review | manual | `[BUILT]` practice |
| A package is `done` only when its acceptance criteria map to a test that can fail, five checks pass, eval suite passes | `05-verification.md` section 2 | `[SPEC]` |
| Profile and state matter to scenarios: E-D1 runs client-project and solo-lite (solo-lite enforces G1 and G3 only) | scenario data | `[PROPOSED]` |
| No unattended run in any eval (D-41); E-B1 and E-R1 real variants are attended | scenario design | `[SPEC]` |

## 9. Failure handling

| Failure | What it looks like | Result recorded | State left behind | Who is told |
| --- | --- | --- | --- | --- |
| Live variable missing | suite skipped | none | none | builder sees "skipped" and must not call it verified |
| Fake drifts from real Notion | `real-notion-shapes.test.ts` fails | test failure | fixtures unchanged | builder: refresh with the live tier |
| Scrubber misses a name | `judge4.test.ts` scan fails | test failure | fixture not committed | builder |
| Real-agent eval over cap | run result `blocked` | ledger row, card result | partial output discarded | owner if cap is raised |
| Judge returns an invalid report | exit 3 | nothing saved as a verdict | copy removed | builder re-runs |
| Judge says stop | exit 20 | review saved | STATE.md note | owner |
| Eval leaves temp dirs | `afterAll` cleanup | none | safe to delete | none |

Safe to re-run: all stub evals and the live tier (probe row is reused). Not free to re-run: real-agent evals and the judge.

## 10. Tests and verification

Existing: `init.eval.ts` (8), live tests (4 + recorder), `judge4.test.ts`, `real-notion-shapes.test.ts`, `real-results.test.ts`, `run-agent.test.ts` with the stub CLI, `build-docs.test.ts` (this document set against `work-packages.yaml`). Status at the last record: 728 tests, 8 evals, live tier green on 2026-11-18 (`STATE.md`). To write:

- `evals/stage1/e-s1.eval.ts` to `e-s4.eval.ts` with the variants above; a stub that emits an invalid output makes the engine test fail (card step 4).
- A harness self-test: a deliberately wrong grader input must fail the grader.
- `migration.test.ts` as in 5.6; `judge-report.test.ts` (shape validator accepts the saved reviews, rejects a missing heading).
- `build-docs.test.ts` check that every scenario named in `05-verification.md` section 4 has a file once its stage is done, and that no `*.real.eval.ts` sits outside `evals/agents/` (RD-F10-1); a GitHub live test `test-live/github.live.test.ts` (`ARIMA_LIVE_GITHUB=1`, repo `ARIMA-Test`, scrubbed fixtures) owned by WP-111 and WP-112 (RD-F10-6); `scrub-claude-result.test.ts` (WP-191).
- Real checks: the first judge automation run is compared by hand to a human-launched judge on the same commit. Windows and Linux CI apply to the harness (paths, git, temp dirs).

## 11. Dependencies

WP-121 stub agents and E-S1 before WP-150; WP-120 dispatcher before WP-121; WP-150 before every agent package (WP-210 onward) because card step 7 needs the harness; WP-195 after WP-003; WP-503 after WP-195; WP-220, WP-350, WP-410 are the E-B1, E-D1, E-R1 packages; WP-502 puts the full suite in CI; WP-502 and WP-505 need judge J5. Contracts: run packet and report (WP-101), state machine (WP-107), merge script (WP-112). Decisions: D-41, WP-201.

## 12. Status and resolved decisions

`[BUILT]`: v0.1 eval, live tier, scrubber and fixture guards, judge procedure and five reviews, stub CLI. `[SPEC]`: eval suite in CI before release (15.4), E-B1, E-D1, E-R1. `[PROPOSED]`: harness, stub agents, graders, negative controls, `eval:agents`, `arima-judge`, upgrade fixtures. Decided under `09-owner-decisions.md`:

| Decision | Reason | Implemented by |
| --- | --- | --- |
| RD-F10-1: real-agent evals are `evals/agents/<role>/*.real.eval.ts`, run by `npm run eval:agents` with `vitest.agents.config.ts`; `npm run eval` excludes `evals/agents/**`; deterministic stub evals stay in `evals/<scenario>/*.eval.ts` and run in CI. The `tests:` fields of the agent packages in `work-packages.yaml` (`evals/developer`, `evals/qa`, ...) are renamed to `evals/agents/<role>` | A real model call in CI costs money and is flaky (G-52) | WP-150; `work-packages.yaml` |
| RD-F10-2: ledger rows, events, outbox entries and run reports get an optional `schema_version` (integer, absent means 1) | `01-architecture.md` section 6 requires versioned contracts (G-13) | WP-195 |
| RD-F10-3: scenario caps: E-B1 $30, E-D1 real $40, E-R1 real $20 (estimates, revised by measurement); timeouts 180 s for stub scenarios on Windows CI, 60 s otherwise; every cap is below the daily cap | Spec 13.5; money is bounded before a run | WP-150, WP-220, WP-350, WP-410 |
| RD-F10-4: a script scrubs `claude -p` result fixtures (session id, paths, names) | The hand scrub is a leak risk in a public repo | WP-191 |
| RD-F10-5: judge automation default cap is $5 per checkpoint (`--max-budget-usd`); from J2 on it replaces the manual launch, which stays allowed | Same procedure, repeatable and recorded | WP-150 |
| RD-F10-6: a live GitHub tier is part of done for WP-111 and WP-112 | Real PR, review and merge behaviour must be seen once | WP-111, WP-112 |
| RD-F10-7: the evals use the same exit-code registry and turn-cap table as the engine (F02); a scenario that dispatches a kind with no cap fails | One source of truth | WP-150 |
| RD-F10-8: spec 15.3 v0.2 wording "unattended" is amended to "attended" (C-F10-1); D-41 stands | Consistency with D-41 | spec edit |
| RD-F10-9: `docs/process/JUDGE.md` says the judge mutates a copy in a temporary directory, never the repository (C-F10-2); review files are named `<date>-<checkpoint>.md` with J0 to J5 and J-agent ids (C-F10-4) | `05-verification.md` requires mutations | WP-150, docs |
| RD-F10-10: WP-121 owns the E-S1 stub scenario and WP-150 the harness (C-F10-3, G-51) | Already fixed in `work-packages.yaml` | none |
| RD-F10-11: all scenarios that touch hosting use the stub Docker wrapper and throwaway Compose project names (`production-eval`, `staging-eval`, `preview-eval-<pr>`); no eval touches the real `production` project | D-47 and the production hard stop | WP-150, WP-402 |

No item is left open; no critical blocker remains for this feature.
