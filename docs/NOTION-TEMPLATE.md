# The ARIMA Notion template

ARIMA keeps project management in Notion: 19 linked databases under one root page (spec §9). `arima-notion bootstrap` builds them, `arima-notion map` verifies them and records their IDs, `arima-notion pull` mirrors them to `.arima/mirror/`, and `arima-notion push` applies agents' proposed changes. The template is versioned by a line on the root page, `ARIMA template schema_version: 1`.

## Rules the template enforces

- **Nothing is ever deleted.** ARIMA has no delete operation. Obsolete items get a status of Retired, Cancelled, Superseded, Withdrawn, Closed or Rejected.
- **Only the orchestrator writes to Notion**, through the outbox. Other agents only propose changes.
- **Human-only fields** (below) are never written by an agent; a proposal that touches one is refused.
- **Human edits win.** If you edit a page after an agent last read it, the agent's pending change is not applied and the orchestrator re-reads it or asks you.
- Every write stamps the run ID into **Last written by run** on the row, for audit. (Notion cannot hide a property from the API; hide the column in your views.)
- Agents never look databases up by name. `.arima/notion-map.json` records every database and property ID.

## Building it

```
node "<plugin>/scripts/dist/arima-notion.mjs" bootstrap --parent <page id>
node "<plugin>/scripts/dist/arima-notion.mjs" map --root <page id> --project <app repo>
```

`bootstrap` can be repeated safely. `map --migrate` adds properties that are missing (for example after a plugin upgrade) but never changes or removes an existing one, and never edits select options; a missing option is reported as a warning.

## Databases

| Database | Title property | Notes |
| --- | --- | --- |
| Gates | Gate | G0 to G4; Status Not ready / Ready for review / Approved / Approved with conditions / Rejected |
| Requirements | ID | Type, Priority (MoSCoW), Status, Baseline version, Test results (rollup), Coverage (formula) |
| Epics | ID | Links to requirements, stories and milestones |
| Stories | ID | Status follows the ticket state machine (spec §7.1); Complexity S/M/L; Budget USD; Cost USD (rollup of the Cost log) |
| Test Cases | ID | Type, Automated, Last result, Last run, Test path |
| Bugs | ID | Severity S1-S4, Priority, Status, evidence |
| Milestones | ID | Budget USD and Cost USD (rollup) |
| Documents | Title | Type, Phase, Owner role, Version, Status, Master (Notion or GitHub), Link |
| Decisions | ID | Autonomous decisions, each with a veto checkbox |
| Questions | ID | Blocking, Default, Expires, Answer |
| Meetings | ID | Type, participants, decisions, action items |
| Digests | Date | One per day |
| Releases | Version | Production deploy approval and approver |
| Incidents | ID | Priority P1-P4, timeline, postmortem link |
| Change Requests | ID | Impact, cost estimate, Decision, Approver |
| Risks | ID | Probability, Impact, Score (formula) |
| Lessons | ID | Retro outcomes |
| Cost log | Date | Daily aggregates by role and phase |
| Human tasks | Task | Work handed to a person, with a due date |

Relations are two-way, so the requirements-stories-test cases-bugs chain is a live RTM. Notion cannot relate one property to several databases, so the "Item" reference on Decisions, Questions, Human tasks, Risks and Cost log is the ARIMA ID as text (ADR-0004).

## Human-only fields

No agent may write these. You set them in Notion.

| Database | Property | Note |
| --- | --- | --- |
| Gates | Approvers | Who may approve this gate |
| Gates | Decided by | |
| Gates | Status | Only the values Approved, Approved with conditions and Rejected; agents may set Not ready and Ready for review |
| Digests | Reviewed by, Minutes spent | You fill them in after reading the digest |
| Decisions | Veto, Veto reason | |
| Questions | Answer, Answered by | |
| Releases | Prod deploy approval, Prod deploy approver | |
| Change Requests | Decision, Approver | |

A gate decision counts only when the person who set it is listed in Approvers.

## Steps `bootstrap` may leave to you

Notion's API does not always accept formulas and rollups. If `bootstrap` reports any, add them by hand in the database's property settings:

| Database | Property | Type | Definition |
| --- | --- | --- | --- |
| Requirements | Test results | Rollup | Relation Test Cases, property Last result, show original |
| Requirements | Coverage | Formula | `if(contains(prop("Test results"), "Pass"), "Covered", "Not covered")` |
| Stories | Cost USD | Rollup | Relation Cost log, property Cost USD, sum |
| Milestones | Cost USD | Rollup | Relation Cost log, property Cost USD, sum |
| Risks | Score | Formula | `prop("Probability") * prop("Impact")` |

A formula that reads a rollup of a select property sees text, so the Coverage formula uses `contains(...)`; an earlier version of this template used a list-style test on the rollup, which the real API does not accept for this rollup. A workspace built with the old formula needs that one property edited by hand (`arima-notion map` does not change an existing property).

Then run `arima-notion map` again.

## Views

Run `arima-notion views` once: it creates these through the Notion API, skips any view that already has the name, and never changes or deletes one (spec §9.2, WP-142). They are what you look at day to day. The table says what each one is; adjust a view in Notion as you like, ARIMA will not touch it again.

| View | Database | Setup |
| --- | --- | --- |
| Board | Stories | Board layout grouped by Status, Cancelled hidden, sorted by Priority; add a Milestone filter for the current milestone yourself |
| Approval inbox | Gates, Questions, Releases, Change Requests, Decisions | One view of this name in each database: Gates Status is Ready for review; Questions Status is Open and Blocking is checked; Releases Status is Awaiting approval; Change Requests Decision is Pending; Decisions Date in the past week (the API has no "past day"), newest first. Put the linked views on one page if you want one inbox |
| RTM | Requirements | Table showing Stories, Test Cases and Coverage |
| Milestone burn | Milestones and Stories | Table with Budget USD and Cost USD per milestone; on Stories, sorted by Cost USD |
| Open bugs | Bugs | Status is Open, In progress or Fixed; sorted by Severity |
| Portfolio | (page) | By hand: a public page with the overview, digests and selected documents (not created by ARIMA) |

For client projects, share only a **Client portal** page with client guests: gate pages awaiting them, approved documents, milestone reviews, UAT runs and release notes. Keep the decision log, cost log, ledger and agent questions off it.

## Notion Free plan limits

Up to 10 guests, 5 MB per file, 7 days of page history, and block limits once a workspace has two or more members. ARIMA keeps large evidence in GitHub, commits a daily snapshot of the mirror to the `arima-state` branch as long-term history, and needs the Plus plan if more than one person is a Notion member of the workspace.
