# F04 Gates, questions, human tasks and meetings

Tags: `[BUILT]` exists with tests, `[SPEC]` required by the spec, not built, `[PROPOSED]` introduced here. Spec numbers refer to `docs/spec/ARIMA-Master-Spec.md`. ESTIMATE marks a value the spec does not give; each is decided in section 12 (resolved decisions). This card covers four engine features that share one rule: a human decision enters ARIMA only through a Notion field that code checks.

## 1. Purpose and spec refs

- **Gate protocol** (WP-330, WP-331): spec 7.4, 6.0 to 6.7 exit criteria, 4.3 (evidence pack per profile), 12.2, D-28, D-40, S1. Baseline freeze: 3.3, 7.9, D-45 (freeze on approval, pre-gate snapshot kept as evidence input). ADR approval: D-44 (the tech-lead sets the status). Notifications are Notion @mentions only (D-23).
- **Question protocol** (WP-301): spec 7.5, 5 (agents escalate by question), 12.1 (batching in the digest), `autonomy.question_policy` (4.1).
- **Human tasks** (WP-301): spec 7.6, 4.2 (`human_task_sla_hours`), 12.3, D-32.
- **Meeting engine** (WP-302): spec 7.3, 14 (`/arima:meeting`), 5 (budget cap per meeting).

Already built and reused: `gates.ts` (`GATE_PHASE`, `GATE_CRITERIA`, `PHASE_AFTER_GATE`) `[BUILT]`; `profiles.ts` `enforcedGates` `[BUILT]`; Notion databases Gates, Questions, Decisions, Meetings, Human tasks and their human-only properties `[BUILT]` (`notion/schema.ts`); events `gate.opened gate.decided question.raised question.answered decision.made decision.vetoed` `[BUILT]`; `status.ts` reads gate and question mirrors `[BUILT]`.

## 2. Command or entry point and arguments

| Entry | Form | Status |
| --- | --- | --- |
| `/arima:gate <G0-G4>` | skill over `arima-gate --gate G2 [--open] [--check-only] [--decision-sync] [--export]` (`--export` writes the evidence bundle, RD-F04-3) | `[SPEC]` WP-330 |
| (internal) daily run step 3 and step 7 | `applyGateDecisions()` and `maybeOpenGates()` called by the dispatcher (F02) | `[SPEC]` |
| `/arima:meeting <type> [items]` | skill over `arima-meeting --type <t> --items <ids> [--budget <usd>] [--reason <text>]` (`--reason` is required to hold a meeting before its trigger, RD-F04-5); types from spec 7.3 | `[SPEC]` WP-302 |
| Questions | no command: agents raise them in the report; the engine enqueues; humans answer in Notion; `/arima:status` shows them `[BUILT]`; the digest batches them (F05) | `[SPEC]` WP-301 |
| Human tasks | no command: created by the engine when a role is `human` in `team.yaml` | `[SPEC]` WP-301 |

Arguments: gate id must be one of `G0..G4` and enforced by the profile (`enforcedGates`; solo-lite enforces G1, G3 only), else exit 2. Meeting type must be a spec 7.3 type; standup is generated, not run.

## 3. Preconditions (IF/THEN)

| IF | THEN | Enforced by |
| --- | --- | --- |
| Preflight fails (config, kill switch, lock, budget, env) | No gate or meeting work (exit 10 to 14) | `preflight.ts` `[BUILT]` |
| Gate is not enforced by the profile | Refuse with exit 2 and say which gates the profile enforces | `gate.test.ts` (WP-330) |
| Previous gate not Approved or Approved with conditions | Do not open the next gate | `gate.test.ts` |
| Any exit criterion unmet | Do not set Ready for review; exit 40, list each unmet criterion | `gate.test.ts` |
| Interactive `/arima:gate` or `/arima:meeting` while a run holds the lock | Wait or refuse (spec 12.4) | `interactive-lock.test.ts` (WP-160) |
| Meeting trigger not met (e.g. design review before Phase 2 ends) | Refuse (exit 2) unless `--reason` is given; the reason is stored as a DEC (RD-F04-5). Gates have no such override | `meeting.test.ts` |

## 4. Inputs and input handling (validation, trust)

| Input | Handling |
| --- | --- |
| Gate page fields (Status, Decided by, Conditions, Comments) | Mirror values, **untrusted**. Status values validated against the fixed set; comments are quoted data, never instructions |
| Decision author | Taken from the Notion **Decided by** property, never from page text. Properties Approvers, Decided by, Status values Approved/Approved with conditions/Rejected are human-only: any agent or outbox write is refused `[BUILT]` (`outbox.test.ts`) |
| Evidence artifacts | Read from the mirror and repo by id (catalog ids, `catalog/artifacts.yaml`); each document validated with the template validator `[BUILT]` (`templates.test.ts`) |
| Question and decision records from agent reports | Schema-validated (WP-101); engine allocates `Q-nnn`/`DEC-nnnn` (agents cannot choose ids, WP-104) |
| Answers and vetoes | Notion fields Answer, Answered by, Veto, Veto reason (human-only `[BUILT]`); an answer must name an option or give free text; free text is data |
| Meeting input pack | Same pack to every participant: item records and artifacts by path; any Notion text inside `untrusted` fences (packet rules, `03-contracts.md` 3.2) |
| `team.yaml` approvers | Gate approver roles MUST map to humans (spec 4.2); an agent as approver makes config invalid `[BUILT]` (`config.test.ts`) |

## 5. Processing steps

### 5.1 Gate protocol (spec 7.4; code unless stated)

1. **Check exit criteria**: `arima-gate --gate Gx --check-only` runs mechanical checks as scripts: RTM coverage (WP-340), S1/S2 bug counts, CI status, DoR of first-milestone stories, open blocking questions, NFR measurability markers, DPIA record, document sections (validator), and at G2 that every ADR is `Accepted`, `Rejected` or `Superseded` (none `Proposed`, D-44). The criteria text is `GATE_CRITERIA` `[BUILT]`; each criterion maps to one named check function returning `{criterion, ok, evidence}`. A criterion that needs judgment (for example "no unmitigated high threat") is checked by code for the presence and status of the record and by a human at decision time; the check never claims to evaluate the content.
2. **Assemble the evidence pack** (code writes, a model may draft prose): links to every required artifact (from the profile), check results, open risks, known issues, the agents' recommendation. The recommendation is a report `verdict` from a gate-recommendation run (`03-contracts.md` 3.3), advisory only. Evidence lives on the Notion gate page only (D-28); regulated additionally exports the evidence bundle (spec 4.3; RD-F04-3: HTML plus Markdown under `docs/evidence/Gx/`, PDF by the human with Print to PDF, no new dependency).
3. **Open the gate**: outbox write of the pack and `Status: Ready for review`; the engine writes the `Status` with the human flag path; event `gate.opened`; @mention approvers. Page content is frozen from this moment: the engine records the last-edited value of the page and a hash of the pack. At the same moment the host script saves a **pre-gate snapshot** of the documents under evaluation to `docs/spec/snapshots/Gx-pre/` (D-45); it is evidence-pack input, not the baseline.
4. **Wait for a human** (no model): the gate stays open across runs; other independent work continues.
5. **Accept the decision** (next daily run, step 3): read Status, Decided by, Conditions, Comments from the mirror. Call `checkApprover(gate, decidedBy, team)` (single seam, D-40). Not ok: ignore the decision, revert nothing, log `notion.refused` plus one question to the sponsor (exit 41 for the interactive command; the daily run continues).
6. **Verify the page was not edited after Ready for review**: if the pack content changed after step 3 other than by the engine, refuse the decision and set the gate back to Ready for review with a note (rule from WP-330 acceptance). Comparison is by content hash and property values, not timestamps (Notion rounds to the minute, `00-handoff.md` section 4).
7. **Apply**: Approved: freeze the baseline (5.2), lock the page, start `PHASE_AFTER_GATE`; Approved with conditions: also create one task per condition with a due date of `human_task_sla_hours` weekday hours (RD-F04-8); Rejected: comments become action items and the phase continues. Event `gate.decided`; decision record stored as in `03-contracts.md` 3.5 `{gate, status, decided_by, decided_on, conditions[], approver_check}`.

### `checkApprover()` seam (D-40, S1 deferred)

One exported function in one module; no other code compares approvers. Placeholder (`method: "placeholder"`): ok only when the Decided-by person id is listed as approver for that gate in `team.yaml`. Limit, stated in the record: Notion does not expose who edited a given property, so this proves *a listed person is named*, not *that person made the edit* (S1). Real mechanism (`method: "last_edited_by"`, probe gate `G-PROBE` exists) replaces only this function body. Tests must fail if a second comparison site appears (grep test).

### 5.2 Baseline freeze (WP-331; spec 3.3, 7.9)

The baseline is frozen **on approval** (D-45, resolves spec 6.1 step 8 against 7.4 and 3.3, G-38): at open the host saves the snapshot (5.1 step 3); when `gate.decided` is Approved or Approved with conditions for G1 or G2 (and later gates per profile) the engine copies the approved documents to `docs/spec/baseline-Gx/` in the app repo (version `baseline-G1 v1.0`). The commit goes on branch `chore/baseline-Gx` through the host publish script; `arima-merge` merges that branch when CI is green and the gate decision record is Approved (the gate decision stands in for QA pass and PR review on this one branch pattern, RD-F04-9). A pre-merge check and the daily sync refuse any change to a frozen document or its Notion page that is not linked to an approved CR (then version increments, e.g. v1.1, spec 7.9). Silent edit: item refused, `hardstop`-style question to the PO. Before WP-403 (full CR flow) the refusal is the whole behavior.

### 5.3 Question protocol (spec 7.5)

1. An agent proposes a question in its report: question, options with recommendation, blocking, default, expiry, item, topic, and `hard_stop` (a canonical id of `hardstops.ts` when the matter is one; new optional field in `03-contracts.md` 3.4, RD-F04-4). Absent `default` is mandatory on hard-stop matters. Under `autonomy.question_policy: assume_and_log` (the default, 09 section 1) an agent asks only when the matter is a hard stop or a critical blocker (a missing credential or account, money or a paid service, a legal or privacy matter, an irreversible or production action, two contradicting requirements after one consult round); everything else it decides and logs.
2. Engine validates, allocates `Q-nnn`, enqueues a Questions row; event `question.raised`.
3. **Blocking** (or `question_policy: block_story`): linked item to Blocked via the state machine; reason recorded.
4. **Non-blocking under `assume_and_log`**: item continues with the recommendation; engine writes a `DEC-nnnn` Decisions row with Veto checkbox; event `decision.made`. Under `block_story` every question blocks.
5. **Never assume hard-stop matters**: a question is a hard-stop matter when (a) the report sets `hard_stop` to a canonical id (gates, prod deploy, secrets, budget, story budget, paid service, licence, critical finding, migration, credential), or (b) the engine itself raised it from a detector (budget, missing credential, licence audit, paid-service manifest diff, critical finding, gate or release approval) or from a unit of kind `gate-pack` or release. Such a question is forced blocking and its `default` is stripped, whatever the agent or the policy says (RD-F04-4).
6. **Batching**: grouped by topic, highest impact first, at most 10 shown per digest; the rest are listed by count with a view link. Impact order: blocking before non-blocking, then hard-stop topic, then age (RD-F04-2).
7. **Answer** (daily run step 3): Answer and Answered by set by a human; engine unblocks the item (Blocked to previous status), event `question.answered`. A veto on a decision creates an undo task and returns the story one step (spec 12.2), event `decision.vetoed`.
8. **Expiry** (RD-F04-6): past `expires` a hard-stop question stays blocked and is escalated once with a Notion @mention on the Urgent page; a blocking question that is not a hard-stop matter takes its `default` (the recommended option), the engine writes a DEC with a veto box and unblocks the item; a non-blocking one keeps its assumption and is flagged in the digest.

### 5.4 Human tasks (spec 7.6)

For a role of type `human`, the engine creates a Human tasks row: assignee, role, template link, links to inputs, due date = now plus `human_task_sla_hours` counted in **weekday** hours (D-32). Reminder at the SLA (Notion @mention), escalation to the sponsor at twice the SLA; ARIMA sends no email (D-23); the notification channel is the Notion @mention and the Urgent page only (RD-F04-7). On the person marking it Done the engine checks the expected output exists and validates (template sections) before the item moves; missing output reopens the task with the reason. Waiting time counts as human wait (spec 4.2, 13.3).

### 5.5 Meeting engine (spec 7.3)

1. Orchestrator (code) assembles one input pack and one question list, identical for all participants, and checks the meeting budget: cap = `min(2 x per_run_cap x participants, remaining daily cap)`, at most 10 participants, 20 turns per participant run (RD-F04-6, F02 turn-cap table).
2. **Round 1**: one headless run per participant (D-08), each without seeing the others; each returns an assessment report.
3. **Round 2** (only if disagreement): each participant answers only the listed points of disagreement; maximum two rounds in total.
4. **Close**: facilitator writes minutes: decisions (DEC), open issues, action items with owner and id; minutes validated against the template. Unresolved disagreements become questions for a human (step 5.3). Row in Meetings (cost, participants, action items); event `meeting.held` `[PROPOSED]`.
5. Mechanism: sequential runs by default; agent teams only when enabled (spec 7.3). Agents write no files; they return reports.

## 6. Outputs and side effects

Notion: Gates (Status via engine, evidence pack), Questions, Decisions, Human tasks, Meetings, Documents. Files: `docs/spec/baseline-Gx/` (host script commit), `.arima/runs/*.report.json` per meeting run. Events: `gate.opened gate.decided question.raised question.answered decision.made decision.vetoed notion.refused hardstop.hit` `[BUILT]`; `meeting.held` `[PROPOSED]` (WP-101). Ledger: one row per meeting participant run, `item` = the MTG id or `none` (spec 13.2), so meeting cost is visible. Notion never deleted: superseded records are retired (spec 9.3).

## 7. Exit codes

Registry reserves `arima-gate` 0 and 40 (criteria unmet). New codes are PROPOSED until WP-330/302 fix them and add them to `03-contracts.md` section 8 in the same change.

| Script | Code | Meaning | Status |
| --- | --- | --- | --- |
| `arima-gate` | 0 | Checks pass or gate opened/decision applied | `[SPEC]` reserved |
| `arima-gate` | 2 | Usage or gate not enforced by profile | `[PROPOSED]`, registered by WP-330 |
| `arima-gate` | 40 | Criteria unmet | `[SPEC]` reserved |
| `arima-gate` | 41 | Decision refused: not a listed approver | `[PROPOSED]` |
| `arima-gate` | 42 | Decision refused: page edited after Ready for review | `[PROPOSED]` |
| `arima-gate` | 43 | Baseline edit refused (no CR) | `[PROPOSED]`, registered by WP-331 |
| `arima-gate` | 10 to 14 | As preflight | `[BUILT]` pattern |
| `arima-meeting` | 0 / 2 | Held / usage or trigger not met without `--reason` | `[PROPOSED]`, registered by WP-302 |
| `arima-meeting` | 3 | Meeting budget cap hit, partial minutes saved, question raised | `[PROPOSED]` (matches "blocked by cap") |
| `arima-meeting` | 10 to 14 | As preflight | `[BUILT]` pattern |

## 8. Conditions and rules

| IF (state) | THEN | Test |
| --- | --- | --- |
| Profile solo-lite | Only G1 and G3 gates exist; charter not a gate artifact but brief and budget plan are written (S14) | `profiles.test.ts` `[BUILT]` (gate list); `gate.test.ts` |
| Profile regulated | Gates G0-G4 plus named compliance sign-off; evidence PDF export; DPIA always; 2 independent reviewers | `gate.test.ts` |
| Decision set by a person not in approvers | Ignored, `notion.refused`, question raised | `gate.test.ts` (placeholder path) |
| Gate page changed after Ready for review | Decision refused (exit 42) | `gate.test.ts` |
| An agent tries to write Status or Decided by | Refused | `outbox.test.ts` `[BUILT]` |
| Approver role mapped to an agent in `team.yaml` | Config invalid | `config.test.ts` `[BUILT]` |
| Gate Approved | Baseline frozen, page locked, next phase starts | `baseline.test.ts` (WP-331) |
| Edit to frozen document without CR | Refused | `baseline.test.ts` |
| Gate rejected | Comments become action items; phase continues | `gate.test.ts` |
| Blocking question open | Linked item Blocked; G1 criterion "no open blocking questions" fails | `questions.test.ts`, `gate.test.ts` |
| `assume_and_log` and question touches a hard-stop id | Forced blocking, no default | `questions.test.ts` |
| More than 10 questions pending | Digest shows 10 by impact, rest counted | `questions.test.ts`, `digest.test.ts` (F05) |
| Task unfinished at 24 weekday hours / 48 weekday hours | Reminder / escalation to sponsor | `questions.test.ts` (clock injected) |
| Question expires | Hard-stop: stays blocked, one escalation; other: default applies with a DEC | `questions.test.ts` |
| Gate approved | Pre-gate snapshot already saved at open; frozen baseline written on approval; the `chore/baseline-Gx` PR merges on CI green plus the decision record | `baseline.test.ts`, `merge.test.ts` (F08) |
| Meeting reaches round 2 with disagreement left | Unresolved points become questions | `meeting.test.ts` |
| Meeting spend reaches its cap | Stop, minutes of what exists, question with cost so far | `meeting.test.ts` |

## 9. Failure handling

| Failure | Response |
| --- | --- |
| Evidence artifact missing or fails template validation | Gate not opened; unmet criteria listed (exit 40) |
| Notion unreachable when opening | Outbox deferred; gate not marked open until applied |
| Mirror stale when a decision is read | Re-pull; if still stale, wait for the next run (never accept from stale data) |
| Participant run errors | Retry once (F02 rules); second failure: that participant's assessment missing, noted in minutes, question raised |
| Run hits budget cap in a meeting | Result `blocked`; partial minutes; question |
| `checkApprover()` throws | Decision not accepted; error event; fail closed |

## 10. Tests and verification

Existing: `profiles.test.ts`, `outbox.test.ts`, `config.test.ts`, `templates.test.ts`, `catalog.test.ts`, `real-notion-shapes.test.ts`, `notion-template.test.ts`. To write: `gate.test.ts` (WP-330: each criterion check, evidence pack, approver placeholder, edited-after-ready, mutation of `GATE_CRITERIA` breaks it, single-seam grep test), `baseline.test.ts` (WP-331), `questions.test.ts` (WP-301: cap 10, never-assume, reminder 24 and escalation 48 weekday hours, expiry), `meeting.test.ts` (WP-302: independent round 1, max two rounds, minutes with owned actions, budget cap), `inbox.test.ts` (WP-140: answer unblocks, veto reopens with BUG). Live check on the dev workspace with probe gate `G-PROBE` before WP-330 is `done` (`00-handoff.md` section 2).

## 11. Dependencies

WP-330 depends on WP-301, 009; WP-331 on WP-330 and WP-112 (the baseline PR is merged by `arima-merge`; dependency added to `work-packages.yaml`); WP-301 on WP-141, 220; WP-302 on WP-103, 301; WP-340 (RTM) feeds the G3 check; WP-401 to 403 add Phase 5-8 gate content. Also WP-101 (question, decision, gate records), WP-104 (id allocation), WP-107/108 (state machine, `Status`), WP-160 (lock).

## 12. Status and resolved decisions

Status: gate criteria data, profile gate sets, Notion schema and human-only refusals `[BUILT]`; everything procedural `[SPEC]` or `[PROPOSED]`. Decided under `09-owner-decisions.md`:

| Decision | Reason | Implemented by |
| --- | --- | --- |
| RD-F04-1: the gate approver check stays the placeholder behind the single function `checkApprover()` (D-40); the decision record states `method: placeholder` and that it proves a listed person is named, not who edited; S1 reopens only if the owner asks | Notion cannot report the editor of a property; one seam makes the later real check a one-place change; spec 7.4 step 5 is amended to "a named approver" (C-2) so text and code agree | WP-330 (grep test for a second comparison site) |
| RD-F04-2: question impact order is blocking, then hard-stop topic, then age; at most 10 per digest | Highest consequence first | WP-141, WP-130 |
| RD-F04-3: regulated evidence export = a self-contained HTML plus Markdown bundle at `docs/evidence/Gx/` written by the host script; the human prints a PDF from the browser if one is wanted; no new dependency; G3 content is added by WP-401 | CLAUDE.md: ask before any new runtime dependency; the evidence is complete without a PDF library | WP-330 (`--export`), WP-401 |
| RD-F04-4: hard-stop matters are recognised by an explicit `hard_stop` field on the question (agent-set) and by engine-raised detectors and unit kinds; either forces blocking and strips the default (C-3) | The engine cannot parse intent from prose; agents must not be the only guard | WP-101 (schema field; Questions `Hard stop` select in the next template bump), WP-141 (`questions.test.ts`) |
| RD-F04-5: a meeting before its trigger needs `--reason` and records a DEC; a gate cannot be opened early (criteria are mechanical; an approver may still approve with conditions after it opens) | Owner steering without weakening a hard stop | WP-302, WP-330 |
| RD-F04-6: question expiry: hard-stop questions stay blocked and escalate once by Urgent @mention; other blocking questions take their default with a DEC; meeting cap = `min(2 x per_run_cap x participants, remaining daily cap)`, 10 participants at most, 20 turns each | Assume-and-log by default; the spec gives no meeting number | WP-141, WP-302 |
| RD-F04-7: notifications are Notion @mentions (items awaiting a person, Urgent page); no email or other channel | D-23; the owner works in Notion | WP-142, WP-301 |
| RD-F04-8: reminders and condition due dates count weekday hours (reminder at 24, escalation to the sponsor at 48); `work-packages.yaml` WP-301 already says weekday | Spec 7.6 and D-32 (C-1) | WP-301 |
| RD-F04-9: baseline freeze on approval (D-45); the pre-gate snapshot is saved at open under `docs/spec/snapshots/Gx-pre/`; the baseline is committed by the host script on `chore/baseline-Gx` and merged by `arima-merge` on CI green plus an Approved gate decision (the decision replaces QA pass and PR review for this branch pattern); WP-331 gains the dependency WP-112 | Resolves G-38; the gate approval is the human approval | WP-331, WP-112 |
| RD-F04-10: a solo-lite gate still builds an evidence pack (one code path; C-4) | Simplest rule | WP-330 |
| RD-F04-11: `arima-gate` exit codes 0, 2, 40 (criteria unmet), 41 (not a listed approver), 42 (page edited after Ready for review), 43 (baseline edit refused), 10 to 14; `arima-meeting` 0, 2, 3 (cap), 10 to 14 | One registry entry each, added by the packages named | WP-330, WP-331, WP-302; `03-contracts.md` section 8 |
| RD-F04-12: the tech-lead sets ADR status (D-44); G2 requires no ADR in `Proposed`; the architect and tech-lead settle a dispute in one consult round, the tech-lead rules, and a DEC with a veto box records it | Agents resolve their own disputes (09 section 1) | WP-320 (`adr-review` unit), WP-212, grant in `roles.ts` for `docs/architecture/adr/**` |

No item is left open; no critical blocker remains for this feature.
