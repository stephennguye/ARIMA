# Feature spec F01: `/arima:init`, `/arima:status`, `/arima:pause`

> Status: built (WP-008, done). Spec: 6.0, 8.2, 11.3, 14, 7.2 step 1. Contracts: `03-contracts.md` sections 2, 6, 8, 12. Decisions: D-34, D-39, S18, D-40, D-42. Code: `plugins/arima/scripts/src/{init,status,pause,brief,gates,templates,killswitch,preflight}.ts`, `cli/project-cli.ts`, `skills/{init,status,pause}/SKILL.md`.
>
> Tags: `[BUILT]` exists in code and has tests; `[SPEC]` required by the spec, not built; `[PROPOSED]` frozen by the named work package. This file describes behaviour as read from the code.

## 1. Purpose and spec refs

`init` takes a project brief and a duplicated Notion template and leaves a working workspace: mapped databases, the brief, a charter skeleton, a budget plan, one gate page per enforced gate, one ledger row, events, and `.arima/` committed to the `arima-state` branch (spec 6.0 steps 1, 2, 4, 5). `status` prints phase, gates, open questions, board, budget and run health from local data (spec 14). `pause` sets or clears the kill switch (spec 11.3). All three are human commands: roles are denied them (`guardBash`, rule `kill-switch`, `hooks.ts`; `arima-init|arima-pause` regex; `hardstops.test.ts` "kill switch and config files belong to humans"). `[BUILT]`

Not covered: steps 3 of spec 6.0 (feasibility, compliance screen) belong to later agents `[SPEC]`; `init` says so in its next steps (`init.ts`, `result.nextSteps`).

## 2. Command or entry point and arguments

| Skill | Script (bundle `scripts/dist/`) | Arguments | Notes |
| --- | --- | --- | --- |
| `/arima:init [brief.md]` | `arima-init.mjs` | `--brief <file>` (required), `--project <dir>`, `--root <notion-page-id>`, `--skip-state`, `--json` | `disable-model-invocation: true`; the skill finds or interviews for the brief and config, then runs the script (`skills/init/SKILL.md`) |
| `/arima:status` | `arima-status.mjs` | `--project <dir>`, `--json` | read-only; the skill may call `arima-notion pull` first |
| `/arima:pause [--resume] [reason]` | `arima-pause.mjs` | `--resume`, `--reason <text>`, `--project <dir>`, `--skip-notion`, `--no-state` | `disable-model-invocation: true` |

Environment: the Notion token is read from the variable named by `notion.token_env` (default `ARIMA_NOTION_TOKEN`) in `arima.yaml`; `init` requires it, `pause` uses it if present (`project-cli.ts`, `settingsOf`). A placeholder `notion.root_page_id` (starts with `<`) counts as unset.

## 3. Preconditions (IF/THEN)

- IF `--brief` is missing, the file does not exist, or the token variable is unset THEN `arima-init` exits 2 before any network call (`project-cli.ts`). Enforced by `init.test.ts` and `skills.test.ts`.
- IF the brief contains a secret-looking string THEN exit 6 before Notion is touched (`findSecrets`, `init.ts`; `secrets-dispatch.test.ts`).
- IF the brief lacks a required section or has an empty one THEN exit 3 listing the gaps (`brief.ts`, `BRIEF_SECTIONS`: Problem, Target users, Goals and KPIs, Must-have features, Out of scope, Constraints, Known risks). "None" counts as content; headings match loosely.
- IF `arima.yaml` or `team.yaml` is invalid THEN exit 10 with `file:line` messages (`validateProject`, `config.ts`).
- IF preflight fails THEN exit 11 (run locked), 12 (kill switch on), 13 (budget used up), 14 (missing environment variable) and no ledger row is written; `preflight.fail` events are recorded (`preflight.ts`; `init.test.ts` "refuses to run while the kill switch is on"). Preflight takes a `needs` argument (`github: boolean`); `init`, `status` and `pause` pass `github: false`, so `init` no longer exits 14 for a missing GitHub token (RD-F01-2, WP-101, G-03). Only commands that call GitHub (publish, merge, state push to a GitHub remote) require it.
- IF the Notion workspace does not match the template THEN exit 4 (error ledger row).
- `status` has one precondition: valid config, else exit 10. It needs no Notion, no lock, no token.
- `pause` has none: it works in a folder with no config or no git repo (the file switch needs neither).

## 4. Inputs and input handling (validation, trust)

| Input | Source | Validation | Trust | Why |
| --- | --- | --- | --- | --- |
| Brief markdown | file given by `--brief` | `findSecrets`, then `checkBrief` (H2 sections, HTML comments stripped) | Untrusted text; published to Notion as page content and later read by agents | Phase 0 input |
| `arima.yaml`, `team.yaml` | project root | JSON Schema + extra rules, line numbers (`config.ts`) | Trusted repo files, human-edited | Project key, profile, caps, roles |
| Notion workspace | API through the port | `mapWorkspace` checks 19 databases, property names and types, relation targets, select options | Notion content is data | Map file and mirror |
| Mirror files | `.arima/mirror/{gates,questions,stories}.json` | read as JSON | Data, written by `arima-notion pull` | `status` only |
| Ledger | `.arima/ledger.jsonl` | `readLedger` | Trusted (script-written) | Budget and run counts |
| Reason text | `--reason` | none beyond being written as the first line of `.arima/PAUSE` | Human input | Shown in preflight detail |

Rules: nothing from Notion or the brief is executed or followed as instruction; the init skill states this. The skill never asks for or prints a token (`skills.test.ts` "never asks for a secret").

## 5. Processing steps

### 5.1 `arima-init` (`runInit`, `init.ts`)

1. Read brief; secret scan. **STOP exit 6.** `checkBrief`. **STOP exit 3.**
2. `validateProject`. **STOP exit 10.**
3. `ensureNotionSwitch`: create the "Pause ARIMA" to-do UNCHECKED if missing; never changes an existing one (`killswitch.ts`). Errors are swallowed; preflight reports them.
4. `issueRunId`, then `runPreflight` with `acquireFor` (takes `.arima/run.lock`). **STOP exit 11-14.** Warnings (for example budget at an alert threshold) are carried to the output.
5. Event `run.start` (command `init`, phase 0).
6. `mapAndWrite`: verify the workspace, write `.arima/notion-map.json`. **STOP exit 4** when verification has errors (suggest `arima-notion map --migrate`).
7. `pullMirror`, then push any outbox entries left by an earlier interrupted run with `allowStatusWrites: false` (RD-F01-1). Only entries whose id starts with `init-` and whose `run_id` is a previous `init` run (checked against `.arima/runs/` and the ledger subtype `interactive`) are pushed with `allowStatusWrites: true` in step 9; any other leftover entry that writes `Status` is settled `rejected` (reason `notion_refused`).
8. Plan what is missing, by checking the mirror for the title: documents "Project brief" (the brief verbatim), "Charter" (template `charter`), "Budget plan" (template `budget-plan`); one gates row per enforced gate of the profile (`enforcedGates`), template `gate-page`, Status "Not ready". Existing rows are listed as `existed` and left alone. Each creation is an outbox entry with id `init-<runId>-NN`, role `orchestrator`.
9. `pushOutbox` for the entries created in step 8 (`allowStatusWrites: true`, `init-` ids only). **STOP exit 5** if any entry is rejected, in conflict or deferred.
10. Fill `nextSteps` (section 6) and set ok.
11. Always (finally): append a ledger row (`subtype: interactive`, cost 0, result `pass` or `error`), event `run.end`, release the lock.
12. If ok and not `--skip-state`: `pushState`. A commit or push failure makes the exit code **7** (work is done, state not saved; the skill says so and prints the retry command `arima-state push --run-id <id>`), RD-F01-5. No remote configured: committed locally, a warning, exit 0. A refused push (public, unknown or unchecked remote, F09) is also exit 7.

Templates (`templates.ts`, `renderTemplate`): a placeholder with no value, or a value with no placeholder, throws, so template and code cannot drift. `charter` takes name, key, client, profile, in_scope, out_of_scope, goals, roles (RACI from `team.yaml`), project_cap, constraints, risks; `budget-plan` takes the caps, per-size story budgets and alert percentages; `gate-page` takes gate, name, run_id, date, approvers, criteria (the checklist from `GATE_CRITERIA`; for G0 the two items "Brief complete" and "Budget plan" are pre-ticked).

### 5.2 `arima-status` (`buildStatus`, `status.ts`)

Validate config (**STOP exit 10**), then compute from the mirror and ledger: phase (the phase after the last consecutively approved enforced gate; "unknown" with a warning when no gates mirror exists), gate statuses, open questions (Status `Open`, blocking first, top 10), story board counts for the ten statuses, budget (`budgetStatus`: project and day, estimated USD), run counts (total, `error`, `paused`, last run id), `paused` (all three kill-switch sources through `checkKillSwitch` when the Notion token is set, with the source named; else the local PAUSE file only, printed as `paused (local file only)`), mirror age (RD-F01-4). Prints text or JSON.

### 5.3 `arima-pause` (`setKillSwitch`, `pause.ts`)

1. IF Notion is configured and not skipped THEN set or clear the "Pause ARIMA" to-do (`setNotionSwitch`, creating it on first use); an error is recorded as `unreachable`.
2. Write or remove `.arima/PAUSE` (first line the reason, then a timestamp).
3. Event `killswitch.on` or `killswitch.off` (actor `human`).
4. Unless `--no-state`: `pushState` so the PAUSE file travels on the state branch.

## 6. Outputs and side effects

| Output | Location | Written by | Notes |
| --- | --- | --- | --- |
| `notion-map.json`, `mirror/*.json` | `.arima/` | init (map, pull) | schema-checked map |
| Notion documents: Project brief, Charter, Budget plan | Documents database (Type, Phase 0, Owner role, Version 0.1, Status Draft, Master Notion) | outbox push | idempotent by title |
| Notion gate pages | Gates database (Gate, Phase, Status Not ready) | outbox push | solo-lite opens only G1 and G3 (`init.test.ts`) |
| Ledger row, events `run.start`, `run.end`, `notion.pull`, `notion.push`, `state.push` | `.arima/ledger.jsonl`, `events.jsonl` | scripts | one row per init run, even on failure after preflight |
| State commit `chore(state): run <id>` | `arima-state` branch | `pushState` | secret-scanned; pushed only to a private remote (F09) |
| `PAUSE` file, events `killswitch.on/off` | `.arima/PAUSE` | pause | the file is the only source `status` reads |

What a human must do next (printed by `init`): set **Approvers** on each gate page (agents cannot write it; `Approvers` is `human_only`, `notion/schema.ts`); review the charter skeleton and budget plan; note G0 stays Not ready until the feasibility note and compliance screen exist (later agents); run `/arima:status`. The skill adds: the run is saved on `arima-state`.

Idempotence: a second `init` creates nothing, writes a second ledger row (`init.test.ts` "safe to run again").

## 7. Exit codes

| Script | Code | Meaning | Registry (`03-contracts.md` section 8) |
| --- | --- | --- | --- |
| `arima-init` | 0 | ok | listed |
| | 7 | work done, state commit or push failed or refused | **PROPOSED**, added to the registry by WP-101 |
| | 2 | usage, missing brief, missing token | listed |
| | 3 | brief gaps | listed |
| | 4 | Notion workspace does not match the template | listed |
| | 5 | Notion writes failed (rejected, conflict, deferred) | listed |
| | 6 | brief contains a secret | listed |
| | 10-14 | config invalid, locked, kill switch, budget, environment | listed ("10-14 as preflight") |
| `arima-status` | 0 | ok | listed |
| | 10 | invalid config | listed |
| | 1 | any other error (`project-cli.ts:158`) | listed (added, G-20) |
| | 2 | unknown option (`bad()`) | listed (added, G-20) |
| `arima-pause` | 0 | ok and state saved (or `--no-state`) | listed |
| | 1 | state not saved, or resume could not clear Notion | listed |
| | 2 | usage | listed |

## 8. Conditions and rules

- Profile: gates created are `enforcedGates(profile)`; solo-lite G1 and G3 only (spec S14, `profiles.ts`). `nextSteps` still names `requiredApproverRoles`.
- Hard stops: `kill_switch` is read by preflight; `init` does not record `hardstop.hit` for it (only `arima-run-agent` does, `run-agent.ts:362`).
- Kill switch semantics (`checkKillSwitch`): ON if the PAUSE file exists, or the Notion to-do is checked, or the to-do is missing, or the state-branch PAUSE exists, or Notion is unreachable and the state branch cannot be read (D-39, S18). Pause succeeds if either local source could be set (fail closed). Resume is complete only when both are clear; if Notion could not be cleared it exits 1 with the instruction to untick it by hand.
- `init` writes `Status` through the outbox with `allowStatusWrites: true`; this is the sanctioned human-run path (comment in `outbox.ts`).

## 9. Failure handling

| Failure | Result | State left | Safe to re-run |
| --- | --- | --- | --- |
| Brief or config bad | exit 3, 6, 10; no ledger row, no lock | none | yes |
| Preflight fails | exit 11-14; `preflight.fail` event; no ledger row | none | yes |
| Map fails | exit 4; ledger row `error`; lock released | no map written | yes (try `map --migrate`) |
| Some pushes rejected or deferred | exit 5; ledger row `error` | applied rows exist | yes; existing rows are skipped, deferred entries retried (`init.test.ts` exit 5 test) |
| State commit or push fails or is refused | exit 7 and a plain message | `.arima/` uncommitted or local only | re-run `arima-state push --run-id <id>` |
| Notion down during `pause` | `unreachable`; PAUSE file still set | file switch on | yes |
| State push fails during `pause` | exit 1 plus a plain message that other machines will not see it | local switch changed | yes |

## 10. Tests and verification

Existing (`plugins/arima/scripts/test/`): `init.test.ts` (brief check, end to end with mocked Notion and real git, re-run, solo-lite, gaps, invalid config, kill switch, map failure, push failure and recovery, no git repo); `secrets-dispatch.test.ts` (exit 6); `preflight.test.ts` (all five checks and ordering); `killswitch-hardening.test.ts` (missing switch, remote PAUSE, resume); `dispatch-recheck.test.ts` (pause exit 1 when state not saved); `skills.test.ts` (init covers every exit code, pause explains both switches); `templates.test.ts`; `judge4.test.ts` (gate templates share sections).

To write:
1. `arima-status` exit 1 and 2 are exercised and added to the registry test (WP-101 `contracts.test.ts`).
2. `status` reports `paused` true, with the source, when only the Notion switch or the remote PAUSE is on, and prints `local file only` when no token is available (WP-120).
3. A leftover agent outbox entry that writes `Status` is rejected during `init`, while the `init-` entries still apply (WP-104).
5. `init` without a GitHub token variable passes preflight (WP-101); `init` exits 7 when the state push is refused (WP-101).
6. `init` records `hardstop.hit` with `kill_switch` when preflight exits 12 and `missing_credential` when it exits 14 (G-11, WP-120).
4. Real-workspace check: init against the dev Notion workspace is part of the live tier (`npm run test:live`).

## 11. Dependencies

WP-005, WP-007, WP-009 (done). Later: WP-101 (exit-code registry test, lighter preflight, exit 7), WP-104 (leftover-entry rule), WP-120 (status kill-switch source, `hardstop.hit` for init), WP-160 (interactive commands respect the run lock), WP-330 (G0 evidence pack content, approver check), WP-310/312/313 and WP-321 (the Phase 0 playbook that completes G0).

## 12. Status and resolved decisions

`[BUILT]`: all three commands, their skills and tests as described. `[SPEC]`: the Phase 0 playbook beyond the skeleton (feasibility note, compliance screen, G0 opened with a full evidence pack) is WP-321; until then `init` stops at skeleton pages and says so in `nextSteps`. Decided under `09-owner-decisions.md` (owner steers by commands; agents decide and log):

| Decision | Reason | Implemented by |
| --- | --- | --- |
| RD-F01-1: `init` first pushes leftover outbox entries with `Status` writes OFF; only entries it created itself (`init-` ids from a previous `init` run) are pushed with them ON | A stale agent entry must never be applied with human authority (G-02) | WP-104 (acceptance already lists G-02); test in `outbox-agents.test.ts` |
| RD-F01-2: preflight requires the GitHub token only for commands that call GitHub; `init`, `status`, `pause` do not | D-37 leaves the token with host push scripts only (G-03) | WP-101 |
| RD-F01-3: `arima-status` exit codes 1 (other error) and 2 (usage) are in the registry | Already fixed in `03-contracts.md` section 8 (G-20); the registry test keeps it so | WP-101 (`contracts.test.ts`) |
| RD-F01-4: `status.paused` is computed with `checkKillSwitch` (three sources) when a token exists, else from the local file and labelled so | Spec 11.3 defines three sources; a status that says "not paused" while Notion says paused misleads the owner (G-04) | WP-120 |
| RD-F01-5: `init` exits 7 when the work is done but the state branch was not saved or the push was refused; the skill reports it and the retry command | A silent exit 0 let the skill claim "saved"; `pause` already exits 1 for the same condition | WP-101 (code and registry), skill text in the same package |
| RD-F01-6: spec 14 wording stays ("`/arima:init` runs Phase 0 to G0"); the v0.1 `init` is its first slice and WP-321 extends it after the ba, architect and security agents exist; solo-lite still skips G0 but writes brief and budget plan (S14) | D-46: playbook commands run Phases 0 to 3; no spec change needed | WP-321 |
| RD-F01-7: `init` writes `hardstop.hit` for `kill_switch` and `missing_credential` | Only `arima-run-agent` recorded hard stops (G-11); the digest needs them | WP-120 |
| RD-F01-8: nothing in `init`, `status` or `pause` ever asks the owner for permission beyond the commands themselves; `init` prints next steps (set Approvers on gate pages) because Approvers are human-only | 09 section 1: the owner steers by commands | none (current behaviour) |

No item is left open. No critical blocker (09 section 1) remains for this feature.
