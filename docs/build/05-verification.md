# 05 Verification: what "done" means

Honesty rule: "built", "tested" and "verified" mean different things and are never interchanged. **Built** = exists. **Tested** = automated tests pass, against mocks or stubs. **Verified** = exercised against the real system (real Notion, real GitHub, real `claude -p`) and the result recorded. A status line says which one it is.

## 1. Test layers

| Layer | What it proves | Where | Runs in CI |
| --- | --- | --- | --- |
| Unit | Pure logic: state machine, queue, validators, renderers, scanners | `plugins/arima/scripts/test/*.test.ts` | yes (Windows + Linux, Node 22 and 24) |
| Contract | Every schema accepts its valid examples and rejects its invalid ones; fixtures recorded from the real systems feed real code | `test/*` with `test/fixtures/` (incl. `notion-real/`, `claude-real/`) | yes |
| Guard battery | Forbidden actions are blocked, per role, including bypass forms (quote splitting, `$()`, case, traversal) | `guard-hardening.test.ts`, `hardstops.test.ts` | yes |
| Mutation checks | The tests notice a broken rule: before closing a package, flip each new rule on a copy and confirm a test fails | by hand per package; results in the review file | no (manual, recorded) |
| Engine integration | Dispatcher + report collector + outbox + state machine with **stub agents** on real temporary git repos and a fake Notion | `test/*` (Stage 1) | yes |
| Eval (stub) | End-to-end scenarios with stub agents, graded by validators | `evals/**/*.eval.ts` (`npm run eval`) | yes |
| Eval (real agent) | One agent against its scenario set on the dev project; deterministic graders first, a verifier agent second | `evals/<role>/` (`npm run eval:agents`, manual) | no (costs money) |
| Live tier | The real Notion/GitHub behaviours the fakes imitate; refreshes the scrubbed fixtures | `test-live/` (`npm run test:live`) | no (needs tokens) |
| Independent judge | A fresh read-only agent tries to break the work and finds gaps nobody planned | `docs/process/JUDGE.md` | no (manual, at checkpoints) |

## 2. Definition of done by component type

A work package is `done` only when every applicable line holds.

**Any package**
- Acceptance criteria in `work-packages.yaml` each map to a test or recorded check that can fail.
- `npm run lint`, `typecheck`, `test`, `build` + `check:dist`, `format:check`, strict plugin validation (plugin and marketplace) pass; eval suite passes.
- Docs updated in the same change: the card, `03-contracts.md` if a boundary moved, the guides if behaviour changed, `CHANGELOG`.
- `STATE.md` and the package status updated; no `TBD` left in the cards it touched.

**Script / engine feature**
- Exit codes documented in `03-contracts.md` and each tested; works on Windows and Linux.
- Reads and writes only through the safe helpers; idempotent on retry; no secret in any output (tested with a planted secret).
- Hard-stop interaction tested (kill switch on, budget used up, unknown remote).

**Agent**
- All eight steps of `04-agent-build-protocol.md` complete; the card's results table filled with measured cost and pass rates.
- Tool list equals `allowedTools(role)`; the forbidden-action battery for the role passes.
- Adversarial fixtures pass: planted instruction in untrusted text is ignored and reported; missing evidence fails validation; a secret in output is refused.

**Skill (command)**
- Thin: logic in a tested script; every exit code mapped to a user message; ends with one next command; `disable-model-invocation` correct; structure test passes.

**Hook**
- Fixture payloads for every block and allow; executed through the real launcher; latency within budget; fails closed inside a project; quiet outside.

**Template / catalog**
- Required sections listed in the catalog; validator fails a document missing one; rendering code fails on unfilled or unused placeholders; owner has approved sections that are not in spec 8.2 (until then marked DRAFT).

**Notion change**
- Schema data, `template_schema_version` bump, migration, `docs/NOTION-TEMPLATE.md`, tested against the fake **and** the dev workspace (live tier).

## 3. Judge checkpoints (independence rules in `docs/process/JUDGE.md`)

| Checkpoint | When | Scope |
| --- | --- | --- |
| J0 | After Stage 0 (done: four reviews) | Foundations and safety envelope |
| J1 | End of Stage 1 | Contracts, engine, state machine, hard stops, stub E2E |
| J-agent | End of each agent (step 8) | That agent's card, tests, bypass attempts, mutations |
| J2 | End of Stage 2 | Build loop end to end, attended; Gate U readiness evidence |
| J3 | End of Stage 3 | Discovery/design artifacts, gates, question protocol, S1 decision |
| J4 | End of Stage 4 | Release path, production hard stop, incident and CR flows |
| J5 | Before v1.0 | Everything; shipped payload security review |

Rules: the judge gets file paths and questions, never the builder's conclusions; it is read-only; it must try mutations and bypasses, not only read; the builder answers every finding in the saved review file (fix, ADR/task, or evidence that the finding is wrong); "stop" means work stops until the owner has read the report.

## 4. Acceptance scenarios (the eval spine, built in WP-150, extended per stage)

| Scenario | Stage | Asserts |
| --- | --- | --- |
| E-S1 five stories to Done with stub agents | 1 | State machine, events, ledger rows, digest, per-story cost, engine-only Status writes, merge only via `arima-merge` |
| E-S2 failure loops | 1 | Retry once then Blocked; third failed review → Blocked + question; flaky CI rerun once; budget cap → Blocked |
| E-S3 hard stops | 1 | Kill switch, daily/project/story budget, secrets, Notion delete, default-branch push/merge, Status write all refused and logged |
| E-S4 human edits win | 1 | Outbox conflict by value; human veto reopens a story |
| E-B1 five stories to staging with real agents (attended) | 2 | Spec 15.3 v0.2 criterion |
| E-D1 brief to G2 | 3 | Every artifact the profile requires present and valid; no human edit beyond answers |
| E-R1 release + incident + CR | 4 | Spec 15.3 v0.4 criterion; production deploy refused without approval |

## 5. Regression guards that must never be removed

The tests named in `hardstops.test.ts`, `guard-hardening.test.ts`, `dispatch-recheck.test.ts`, `killtree.test.ts` (with its control case), `hardstop-ids.test.ts`, `judge4.test.ts` (scrubber and fixtures), `catalog.test.ts`, `packaging.test.ts` and `build-docs.test.ts` encode lessons from real bypasses and drift. Deleting or weakening one needs an ADR and the owner's agreement.
