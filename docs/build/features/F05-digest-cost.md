# F05 Daily digest and cost roll-up

Tags: `[BUILT]` exists with tests, `[SPEC]` required by the spec, not built, `[PROPOSED]` introduced here. Spec numbers refer to `docs/spec/ARIMA-Master-Spec.md`. ESTIMATE marks a value the spec does not give; each is decided in section 12 (resolved decisions).

## 1. Purpose and spec refs

**Digest** (WP-130, spec 12.1, 12.3, 12.5, 7.2 step 10, 7.3 standup): one Notion page per day that lets the human decide in about 15 minutes. **Cost roll-up** (WP-131, spec 13.1 to 13.6): turns the ledger into per-story, per-role and per-phase cost, estimate accuracy, rework share and the Notion Cost log, and serves `/arima:cost`. Budget enforcement and threshold alerts are already built (spec 13.5 items 1 to 3, partly 4): see section 8. Both features are read-only computations over the ledger, events and mirror, followed by an outbox write. Principle: every number is computed by code; a model never counts or sums (`01-architecture.md` section 2).

## 2. Command or entry point and arguments

| Entry | Form | Status |
| --- | --- | --- |
| `/arima:digest [--date YYYY-MM-DD]` | skill over `arima-digest --project <d> [--date D] [--no-push]` | `[SPEC]` WP-130 (spec 14) |
| Daily run step 10 | dispatcher calls `buildDigest` then enqueues the page (F02) | `[SPEC]` WP-120/130 |
| `/arima:cost [--by role\|phase\|item]` | skill over `arima-cost --by role|phase|item [--milestone MS-nn] [--json]` (spec 14 lists `[--by role/phase/item]`) | `[SPEC]` WP-131 |
| Cost log sync | `arima-cost --sync` enqueues Cost log rows; also called by step 10 | `[SPEC]` WP-131 |
| `/arima:status` | prints budget, runs, board from the same sources | `[BUILT]` `status.ts` |

`--date` must be a past or current local date, else exit 2. `--by` accepts only `role`, `phase`, `item` (plus the default all-three summary). Digest and cost rebuilds are interactive commands: they wait for or refuse on a live run lock (spec 12.4, WP-160).

## 3. Preconditions (IF/THEN)

| IF | THEN | Enforced by |
| --- | --- | --- |
| Config invalid | Exit 10 | `validateProject` `[BUILT]` |
| Run lock held by another run and the call is interactive | Refuse with exit 11 (spec 12.4) | `interactive-lock.test.ts` (WP-160) |
| No ledger file | Digest still builds: zero spend, zero runs, health green; cost prints "no runs yet" | `digest.test.ts`, `cost.test.ts` |
| No Notion mirror | Digest builds with empty Awaiting/Blockers and a warning line (as `status.ts` does) `[BUILT]` pattern | `digest.test.ts` |
| Kill switch on | Digest and cost still run (read-only, no spend); they never dispatch | `digest.test.ts` |
| `--date` in the future | Exit 2 | `digest.test.ts` |
| Digest date already published | Rebuild updates the same page (`op: update`), never duplicates, never deletes | `digest.test.ts`, outbox duplicate check `[BUILT]` |

## 4. Inputs and input handling (validation, trust)

| Input | Source | Handling |
| --- | --- | --- |
| Ledger rows | `.arima/ledger.jsonl` | `readLedger`, schema `ledger.schema.json`; trusted (script-written). Rows with `cost_usd` negative or non-finite are rejected by the reader |
| Events | `.arima/events.jsonl` | `readEvents`; used for status-change times (`item.status`), hard stops, `unit.retried` `[PROPOSED]` |
| Mirror | `stories`, `gates`, `questions`, `decisions`, `incidents`, `change_requests`, `milestones` | **Untrusted text.** Titles and question text appear in the page as quoted data after secret scan; ids are links only |
| Config | `budget.*`, `schedule.digest_ready_by`, `schedule.timezone`, `team.yaml` SLA | Validated |
| Bills, human minutes (spec 13.1) | Manual or imported; Digests `Minutes spent` | Optional; absent means "not recorded", never zero |
| Clock | injected `now` | Local date uses `schedule.timezone` (RD-F05-6: `schedule.timezone`; `budgetStatus` is changed to take it, WP-131) |

Ledger quirk to honour: in a resumed session the CLI cost is cumulative; the stored `cost_usd` is already the difference (`buildLedgerRow`, spec 13.6) `[BUILT]`. Cost code must sum `cost_usd` as stored and never recompute from tokens.

## 5. Processing steps

### 5.1 Digest (pure `buildDigest(model inputs, now) -> DigestModel`, then `renderDigest`)

1. Resolve the digest date and the "since last digest" window (previous `digest.published` event, else 24 h) (code).
2. Collect: budget status for the date (`budgetStatus` `[BUILT]`), month-to-date spend, runs of the date, mirror rows, events in window (code).
3. Compute the eight sections below; sort by impact and cap each list at 10 (code).
4. Compute health with the rules in 8 (code).
5. Render with `templates/digest.md` (headings are the template's; the renderer fails on an unfilled or unused placeholder, `templates.ts` `[BUILT]`, `templates.test.ts`).
6. Secret-scan the page text; any hit aborts the push and prints the finding (`lib/secrets.ts` `[BUILT]`).
7. Enqueue an outbox entry (role orchestrator, `database: digests`, properties Date, Summary, Shipped, Awaiting you, Spend today, Month to date; `content_markdown` = page body); event `digest.published` `[PROPOSED]`. Human-only fields (Reviewed by, Minutes spent) are never written by ARIMA; `Reviewed by` and `Minutes spent` become human-only in the next template bump (RD-F05-7, WP-130).

| Section (spec 12.1 order) | Content and source | Order and cap |
| --- | --- | --- |
| 1 Headline | One sentence: phase (`PHASE_AFTER_GATE`, as `status.ts`), milestone points done/total, health colour. Templated sentence; **no model** (RD-F05-1) | 1 line |
| 2 Awaiting you | Gates Ready for review, blocking questions, production approvals, CRs, PRs awaiting approval with QA result and preview link; each with a link and wait time | gates, production approvals, blocking questions, PRs, CRs; longest wait first; 10 |
| 3 Shipped | Stories to PO Acceptance/Done/Released and fixes in window, with PR or release links | newest first; 10 |
| 4 Decisions made | Decisions rows since last digest with their Veto checkbox | newest first; 10 |
| 5 Blockers and risks | Blocked items with reason and age; new or changed risks | oldest first; 10 each |
| 6 Cost and time | Today vs `daily_cap`; month to date vs `project_cap`; top 3 items by cost; rework share; human wait hours | fixed shape |
| 7 Tomorrow's plan | Output of the queue planner in dry mode (F02 step 4) for the next run, no writes | 10 |
| 8 Run health | Runs started, succeeded, failed, retried (date) | counts |

Lists longer than 10 end with "and N more" plus a link to the Notion view (spec 12.1 length limit).

### 5.2 Cost roll-up (pure `rollup(ledger, filter)`)

1. Read ledger; filter by date, milestone, phase.
2. Group by item, role, phase (and day, model tier). Sums of `cost_usd`, `num_turns`, tokens, `duration_ms`; counts of runs; rework cost = sum where `is_rework`.
3. Per-story cost = sum of rows with that `item`; **must equal the ledger sum** (acceptance of WP-131). Orchestrator rows (`item: none`) are reported as overhead, not allocated.
4. Estimate accuracy = actual / `budget_usd` story budget by complexity S/M/L (spec 13.4); the budget per size is 1, 3, 6 est. USD (spec 7.1). Reported per size with n; below n = 3 flagged "too few" (RD-F05-3). Note: ledger `budget_usd` is the run cap, not the story budget; the story budget comes from the Stories row (RD-F05-4).
5. Other spec 13.4 metrics the first version computes from the ledger alone: rework share, cache efficiency (cache_read / (input + cache_read + cache_creation)), turns per run, run failure rate, first-pass QA rate (QA rows with attempt 1 and result pass over QA rows attempt 1). DORA, lead/cycle/queue times and flow efficiency (spec 13.3) need status events (WP-108) and are built by WP-132 (RD-F05-5).
6. Cost log rows: one per (date, role, phase, item): properties Date, Role, Phase, Runs, tokens, Cost USD, Agent minutes (sum duration / 60000), Rework (rework cost), Item (text id per ADR-0004), Milestone. Created via outbox; title key `date|role|phase|item` makes a re-sync an `update`, not a duplicate (RD-F05-8).
7. Print (human) or JSON (`--json`); the table states "estimated USD, consumption not spend on a seat plan" (spec 13.6).

## 6. Outputs and side effects

| Output | Where | Notes |
| --- | --- | --- |
| Digest page | Notion Digests (outbox) | Page name = date; update in place on rebuild |
| Digest local copy | `.arima/digests/YYYY-MM-DD.md` (RD-F05-9) | Included in the state-branch commit; durable beyond Notion Free page history (D-28 spirit) |
| Cost log rows | Notion Cost log (outbox) | Daily aggregates (spec 13) |
| Console | `/arima:cost` table; `/arima:digest` path and health | Ends on one next command |
| Events | `digest.published` `[PROPOSED]`; `budget.alert` `[BUILT]` | Budget alerts come from preflight today |
| Notifications | Health red: an @mention on the Urgent page (spec 12.3, D-23); no email, no other channel | `[SPEC]`, WP-130, WP-142 |
| Ledger/mirror | Never modified by these features | read-only test |

## 7. Exit codes

Registry (`03-contracts.md` section 8) has no entry for `arima-digest` or `arima-cost` yet; WP-130 and WP-131 add the rows below in the same change that builds each script (RD-F05-11):

| Script | Code | Meaning |
| --- | --- | --- |
| `arima-digest` | 0 | Built (and pushed unless `--no-push`) |
| `arima-digest` | 1 | Built, outbox not flushed or secret found in page (nothing pushed) |
| `arima-digest` | 2 | Usage (bad date) |
| `arima-digest` | 10 / 11 | Config invalid / run lock held (interactive) |
| `arima-cost` | 0 / 2 / 10 / 11 | Ok / usage / config invalid / lock held |
| `arima-cost` | 1 | Ledger unreadable or a row fails validation (message names the line) |

## 8. Conditions and rules

**Health rules (spec 12.1)** evaluated top down; the first match wins. Budget percentages use `budgetStatus` of the daily and project caps.

| IF | THEN health | Test |
| --- | --- | --- |
| A hard stop has waited more than 48 h; or an open P1/P2 incident; or any budget at or over 100% (`budgetStatus.ok` false) | red | `digest.test.ts` |
| Else any budget at or over 80% of cap; or a blocker older than 24 h | amber | `digest.test.ts` |
| Else (within budget, no blocker older than 24 h) | green | `digest.test.ts` |

"Hard stop waiting" means a gate, production approval, secrets or paid-service question awaiting a human (spec 11.1 table); PR approvals are not hard stops there and count as ordinary Awaiting you items (RD-F05-10). "Blocker age" = now minus the last `item.status` event to Blocked (fallback: mirror last edit, rounded to the minute).

| IF | THEN | Test |
| --- | --- | --- |
| Any list over 10 items | Show 10 by impact, "and N more", link | `digest.test.ts` |
| Spend crosses 50/80/100% of project or day (default thresholds) | `budget.alert` event once (project once; daily once per day) | `preflight.test.ts` `[BUILT]` |
| Story above 3 times the median cost for its size; or milestone rework share above 30% | Alert (spec 13.5 item 4) | `cost.test.ts`; NOT ENFORCED YET (only project/day alerts exist in `budget.ts`; built by WP-131, G-12) |
| Story budget exhausted | `hardstop.hit story_budget`, item Blocked (F02) | `story-budget.test.ts` (WP-105) |
| Spec says Digest "ready by `schedule.digest_ready_by`" and the run is attended | The digest is on demand until Gate U (no scheduler, D-41): it is written at step 10 of every run and by `/arima:digest`; "ready by" is guaranteed only after WP-230. The skill and the README say so; `digest_ready_by` is ignored until a scheduler exists (RD-F05-12) | `digest.test.ts` (the page states the build time) |
| Rebuild for a past date | Uses ledger rows of that date only; mirror data is current, so Awaiting you is flagged "as of rebuild time" | `digest.test.ts` |
| Rework share | Defined as `sum(cost where is_rework) / sum(cost)` for the period (RD-F05-2) | `cost.test.ts` |
| Human wait hours | Sum over items of time in PO Acceptance, Blocked-on-question and gates (spec 13.3), from `item.status` events; missing events yield "not available" | `cost.test.ts`; NOT ENFORCED YET (WP-108) |
| Profile | Same digest for all profiles; regulated and client-project add the evidence pack link per open gate | `digest.test.ts` |

## 9. Failure handling

| Failure | Response |
| --- | --- |
| Ledger line corrupt | Reader throws with line number; digest/cost exit 1, no partial numbers |
| Mirror missing or stale | Build with warning "mirror not fetched / older than N h"; Awaiting and Blockers marked incomplete; health computed from ledger only is flagged "partial" |
| Notion push deferred or rejected | Page kept locally under `.arima/digests/`; retried next run; exit 1 for the interactive command |
| Secret in a question or title | Page not pushed, finding printed, local copy withheld |
| Notion property rejected (human-only) | Entry rejected for that property only, rest applied (`outbox.ts` `[BUILT]`) |
| Clock or timezone ambiguity (date boundary mid-run) | A run's date is the start date; rows keep the date they were written with |

## 10. Tests and verification

Existing `[BUILT]` and reused: `preflight.test.ts` (budget alerts, exhaustion), `ledger-events.test.ts` (row building, resumed-session difference), `templates.test.ts` (renderer fails on unfilled placeholder), `dispatch-recheck.test.ts` (budget refusal), `outbox.test.ts`, `real-results.test.ts` (real CLI result shapes).

To write:

| Test file | Proves |
| --- | --- |
| `digest.test.ts` (WP-130) | Section order equals template headings; list cap 10 with overflow line; health table incl. boundaries (exactly 80%, exactly 100%, blocker at 24 h and 24 h 1 min, hard stop at 48 h); empty project; rebuild is idempotent (second push is an update); no ledger or mirror mutation; secret in input blocks push |
| `cost.test.ts` (WP-131) | Per-story sum equals ledger sum (property test over random ledgers); per role/phase partition sums to total; overhead row kept separate; estimate accuracy by size; rework share; Cost log rows idempotent; resumed-session rows not double counted |
| `budget.test.ts` additions | 3x-median and 30% rework alerts once implemented (currently not built) |
| `interactive-lock.test.ts` (WP-160) | Digest/cost refuse while a run holds the lock |
| Eval E-S1/E-B1 (WP-121, 220) | Digest and cost per story correct after five stories (acceptance of WP-220) |

Live check: one real push to the dev Notion workspace of a digest and a Cost log row before `done` (`05-verification.md`).

## 11. Dependencies

WP-130 depends on WP-003 `[BUILT]` and WP-120 (dispatcher, step 10). WP-131 depends on WP-003 and WP-105 (story budget). Digest content needs: WP-108 (status events, wait times), WP-140 (inbox), WP-301/330 (questions, gates), WP-112 (PR approval state), WP-109 (tomorrow's plan). Until those land the digest renders the sections it can and marks others "not available yet". Also WP-101 (events `digest.published`), WP-160 (lock).

## 12. Status and resolved decisions

Status: budget status, ledger, alerts at 50/80/100, `status.ts` summary `[BUILT]`; digest and cost roll-up `[SPEC]`. Decided under `09-owner-decisions.md`:

| Decision | Reason | Implemented by |
| --- | --- | --- |
| RD-F05-1: Headline and Summary are written by a code template, never by a model | A model must not count or phrase numbers (architecture section 2) | WP-130 |
| RD-F05-2: rework share = cost of `is_rework` rows over total cost; the run count is shown beside it | Cost is what the owner cares about | WP-131 (`cost.test.ts`) |
| RD-F05-3: estimate accuracy needs n >= 3 per size, else "too few" | Avoids false precision | WP-131 |
| RD-F05-4: the story budget lives on the Stories row (`Budget USD`); the ledger `budget_usd` stays the run cap | The ledger contract is frozen | WP-105, WP-131 |
| RD-F05-5: time measures and rework metrics are built in WP-132 (Stage 1); the five DORA metrics report "not yet measurable" until release and incident events exist (WP-402, WP-403) | Matches `work-packages.yaml` | WP-132 |
| RD-F05-6: the day boundary uses `schedule.timezone` | One clock for the digest, the daily cap and the owner | WP-131 (`budgetStatus` takes the zone) |
| RD-F05-7: Digests `Reviewed by` and `Minutes spent` become human-only (template version bump; `map --migrate` adds, never changes existing properties) | An agent must not mark the digest as reviewed | WP-130 |
| RD-F05-8: Cost log row key is `date\|role\|phase\|item` as the title, so a re-sync updates | No duplicates | WP-131 |
| RD-F05-9: local digest copy at `.arima/digests/YYYY-MM-DD.md`, included in the state commit | Durable beyond Notion Free page history | WP-130 |
| RD-F05-10: "hard stop waiting" for red health = gates, production approval, secrets, paid service, critical finding; PR approvals are ordinary items | Spec 11.1 table | WP-130 |
| RD-F05-11: exit codes `arima-digest` 0, 1, 2, 10, 11 and `arima-cost` 0, 1, 2, 10, 11 as in section 7, added to the registry by the packages | One registry | WP-130, WP-131; `03-contracts.md` section 8 |
| RD-F05-12: digest timing without a scheduler: on demand until Gate U, written at step 10 of every run and by `/arima:digest`; the page says when it was built | D-41; resolves C-6 and G-40 | WP-130 |
| RD-F05-13: month-to-date is shown next to lifetime spend versus `project_cap`; spec 12.1 is amended (C-1). Run health "retried" counts `unit.retried` events (C-2). `status.ts` counts `fail` and `error` as failed and `blocked` separately (C-3). The 3x-median and 30% rework alerts are built in `budget.ts` (C-4). Cost log keeps the `Item` text per ADR-0004 and spec 9.1 is amended (C-5) | Each was a spec or code mismatch with an obvious owner | WP-101 (event), WP-130, WP-131 (G-12) |

No item is left open; no critical blocker remains for this feature.
