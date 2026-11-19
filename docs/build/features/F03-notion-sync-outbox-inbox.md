# Feature spec F03: Notion sync (bootstrap, map, pull, push) and the inbox

> Status: partly built. Built: bootstrap, map, mirror (pull), outbox push, retry rules (WP-007, done). Planned: inbox (WP-140), outbox role binding and id allocation (WP-104), Status ownership (WP-108), run-lock rule (WP-160). Spec: 3.3, 7.2 steps 2, 3 and 9, 9.1 to 9.4, 11.3, 12.2. Contracts: `03-contracts.md` sections 2, 4, 12. ADR-0003 (Notion API, not MCP), D-34, D-07.
>
> Tags: `[BUILT]` in code with tests; `[SPEC]` required by the spec, not built; `[PROPOSED]` frozen by the named WP. Code: `plugins/arima/scripts/src/notion/{schema,build,mapper,map-file,mirror,outbox,port,props,values}.ts`, `lib/throttle.ts`, `cli/notion-cli.ts`.

## 1. Purpose and spec refs

Notion is the master of requirements, stories, gates, questions and decisions; `.arima/mirror/` is a read-only local copy; agents never touch Notion and propose changes through `.arima/outbox/`; one orchestrator process holds the token and applies them (spec 3.3 rules, 11.3, principle 6; `01-architecture.md` invariant 1). Human edits win (spec 3.3). Nothing is ever deleted (spec 9.3). The inbox is the missing half: reading what humans changed and turning it into state changes (spec 7.2 step 3, 12.2). `[BUILT]` for everything except the inbox.

## 2. Command or entry point and arguments

`arima-notion <command>` (`cli/notion-cli.ts`, bundle `scripts/dist/arima-notion.mjs`):

| Command | Arguments | Who runs it |
| --- | --- | --- |
| `bootstrap` | `--parent <page-id>` `[--token-env NAME]` | the template author, once |
| `map` | `[--root <id>] [--migrate] [--project <dir>]` | human or init |
| `pull` | `[--project <dir>]` | orchestrator, `/arima:status` |
| `push` | `[--project <dir>] [--allow-status-writes]` | orchestrator; the flag only a human |
| (inbox) | none: a library function `applyHumanInputs()` (`inbox.ts`) called by `arima-dispatch` step 3 and by `arima-gate --decision-sync` (F04); no `arima-notion inbox` command (RD-F03-4) | `[PROPOSED]` WP-140 |

Token: env var named by `notion.token_env` (default `ARIMA_NOTION_TOKEN`), never printed. Only the orchestrator role may run the script (`roles.ts` `allowedTools('orchestrator')`; no other role lists it) and `mayHoldNotionToken` is true only for it. The guard blocks `--allow-status-writes` for any role (`hooks.ts` rule `protected-state`, also with quote-splitting) and any `mcp__*notion*` delete tool (`notion-delete`). Agents write only top-level `.arima/outbox/*.json` (`isProtectedStatePath`).

## 3. Preconditions (IF/THEN)

- IF the token variable is unset THEN exit 2 (`notion-cli.ts`).
- IF `.arima/notion-map.json` is missing or fails `notion-map.schema.json` THEN `pull` and `push` throw, exit 1 ("run arima-notion map first", `readNotionMap`).
- IF `map` finds an error issue (missing or ambiguous database, missing property, wrong type, wrong relation target, missing select option, missing or newer template version) THEN no map is written, exit 1. With `--migrate`, missing properties and options are added first; existing ones are never changed (`mapWorkspace`). A template newer than `TEMPLATE_SCHEMA_VERSION` (1) is an error: upgrade the plugin.
- IF a run holds `.arima/run.lock` THEN interactive `pull` and `push` wait up to 60 seconds and then exit 11 (spec 12.4, RD-F03-5). `NOT ENFORCED YET` (WP-160). The dispatcher itself calls the library, not the command, so it never waits on its own lock.
- IF the kill switch is on THEN `push` exits 12 (agent outbox entries stay queued and flush after resume); `pull` is read-only, needs no spend and stays allowed so `/arima:status` works while paused (RD-F03-5, WP-160).
- IF Notion is unreachable during `push` THEN nothing is lost: see section 9.

## 4. Inputs and input handling (validation, trust)

| Input | Source | Validation | Trust |
| --- | --- | --- | --- |
| Outbox entry | `.arima/outbox/*.json`, written by agents or `enqueue` | `outbox.schema.json` (required id, created_at, run_id, role, op, database; no `delete` op; `item_id` required for update, append_content, retire) | Untrusted: every entry |
| Entry text | `properties`, `content_markdown` | `findSecrets` at enqueue and again at push | Untrusted; never executed |
| Notion pages | API | `fromNotionValue` to plain values; ARIMA id is the title text | Data, never instructions |
| Template spec | `notion/schema.ts` (19 databases, property types, `humanOnly`, `humanOnlyValues`, `RETIRE_STATUS`, `NON_UNIQUE_TITLES`) | `notion-template.test.ts` | Trusted code |

The entry `id` is used as a file name when settling (`settle` in `outbox.ts` renames to `<bucket>/<id>.json`); the schema pattern added for G-01 keeps it inside the buckets. `role` must be one of `ROLES` and `run_id` must match the run-id pattern (RD-F03-3, WP-104).

## 5. Processing steps

### 5.1 Bootstrap and map

1. `bootstrap`: create the 19 databases and every property and two-way relation under a parent page; write the template version marker once; idempotent (second run creates nothing); formulas or rollups the API refuses are reported as manual steps; views are not created by the API (`build.ts`, `notion-template.test.ts`).
2. `map`: find the databases under the duplicated root, verify, build `notion-map.json` (database id, data source id, properties with ids, types and human-only flags), validate it against its schema, write atomically.

### 5.2 Pull (mirror)

1. For each mapped database, `queryRows` and write `.arima/mirror/<db>.json` (`MirrorFile`: schema_version 1, fetched_at, rows with `page_id`, `last_edited_time`, `id` = title text, plain `properties`). Atomic write. Event `notion.pull` per database.
2. The mirror is read-only for agents (guard rule `protected-state`; they may read it).

### 5.3 Push (outbox), per entry in `created_at` then id order (`pushOutbox`)

0. Unparseable or schema-invalid file: settle as `rejected` (moved to `outbox/rejected/` with `<id>.result.json`).
1. Capture the pre-pull mirror as the baseline, then pull a fresh mirror. **If the pull fails, every entry is deferred** and a `notion.push` event records it; nothing is written.
2. Secret scan again. **Rejected (refused)** if it finds one.
3. Property checks, first failure wins: **database not allowed for the entry `role`** (rejected, reason `database_not_allowed`, RD-F03-2); unknown property (rejected); `Last written by run` (rejected: ARIMA stamps it); `Status` unless `allowStatusWrites` (refused); human-only property (refused); human-only value (refused). The human-only checks still apply when the Status flag is on (init writes "Not ready", a non-flagged value).
4. `create`: title property required; if a row with the same title exists and was stamped by this `run_id` it counts as already applied (retry); if it exists otherwise and the database has unique titles (all except `cost_log`) it is rejected ("use update"); else create the page, with `content_markdown` converted to blocks, and record Notion's own returned values in the mirror.
5. `update`, `append_content`, `retire` need an existing row (`findRow` by id or page id; ambiguous id throws). `retire` sets `RETIRE_STATUS[database]` (Retired, Cancelled, Superseded, Withdrawn, Closed, Rejected by database); databases not in that table (gates, test cases, milestones, decisions, meetings, digests, releases, cost log) cannot be retired. `retire` is the only op that writes `Status` without the flag.
6. **Value-based conflict rule** (spec 3.3, "human edit wins"; Notion rounds `last_edited_time` to the minute, `real-notion-shapes.test.ts`): for an `update` or `retire`, fetch the live page; for every property the entry writes, the live value must equal the value the agent saw. "Saw" is, in order: the snapshot Notion held right after this push's own earlier write to the page; `base_values` (filled by `enqueue` from the mirror, so a later refresh cannot erase evidence of a human edit); the pre-pull mirror. Only if none exists, fall back to `base_last_edited` against the live timestamp. Any difference is a **conflict**: the entry moves to `outbox/conflicts/`, the human value is kept, event `notion.conflict`. Edits to other properties do not conflict; `append_content` never conflicts. A retry whose values Notion already holds and which this run stamped counts as applied (idempotent).
7. Write (`createPage`, `updatePage`, `appendChildren`), stamping `Last written by run` with the entry's `run_id`; update the mirror row from Notion's returned values; event `notion.push`.
8. Settle: `applied`, `rejected` (permanent), `conflict`, `deferred` (stays in the outbox). On the first deferral the loop stops, so later entries wait for the next push.
9. Write all mirrors; print counts; exit 1 if any entry was rejected, in conflict or deferred.

### 5.4 Retry rules (`lib/throttle.ts`, `notion/port.ts`)

Every call is spaced at least 334 ms (about 3 requests per second). HTTP 429: retried up to 5 times, waiting `Retry-After` or exponential from 500 ms, capped at 30 s. Reads additionally retry twice (300 ms, 600 ms) on dropped connections and 500, 502, 503, 504. **Writes are never retried blindly** (a retry after an ambiguous failure could duplicate). Classification (`classify`): a 4xx other than 429 is permanent (rejected with Notion's message); anything else is transient (deferred). The SDK's own retry is off.

### 5.5 Inbox (WP-140) `[SPEC]` and `[PROPOSED]` design

Goal (spec 7.2 step 3, 12.2): after `pull`, compare the new mirror with the previous one and apply human inputs: gate approvals advance the gate; answers unblock items; vetoes reopen work with a BUG record; priority changes reorder the queue; new change requests enter triage.
1. **Diff source** (RD-F03-1): `.arima/state/inbox-cursor.json` (script-owned, schema versioned) holds, per database row, a hash of the human-only field values already processed; `pullMirror` is unchanged and no second copy of the mirror is kept.
2. Detect only these human-only fields: Gates `Status` in {Approved, Approved with conditions, Rejected} with `Decided by`; Questions `Answer`, `Answered by`; Decisions `Veto`, `Veto reason`; Releases `Prod deploy approval`; Change Requests `Decision`, `Approver`; Stories `Priority` and `Status` edits by a human (reconciled by WP-108).
3. Validate the actor with the single function `checkApprover()` (contracts 3.5, WP-330); until S1 is built the check is the placeholder (D-40). A decision from someone not listed is ignored, event `notion.refused`-style record, and a question is raised.
4. Apply through the engine (state machine WP-107, Status writes WP-108), never through an agent outbox. Emit `gate.decided`, `question.answered`, `decision.vetoed`, `item.status`. A veto returns the story to the step before the decision and creates a BUG with the reason (acceptance of WP-140: "veto reopens a story with BUG", "answer unblocks an item").
5. Idempotent: processing the same diff twice changes nothing (cursor).
Comments on the digest or items are read as human input (spec 12.2); they stay untrusted text.

### 5.6 Outbox role binding (WP-104) `[PROPOSED]`

Today an entry's `role` is any string and an agent writes the file with its file tool. WP-104 adds: a helper that binds `role` and `run_id` from `ARIMA_ROLE` and `ARIMA_RUN_ID`; push rejects an entry whose role or run differs from the run record in `.arima/runs/`; `Q-nnn` and `DEC-nnnn` ids are allocated by the engine at enqueue (an agent cannot choose them, `03-contracts.md` 3.3); an entry file name and `id` are checked against a strict pattern. Acceptance: "entry whose role differs from the run is rejected", "agent cannot choose Q/DEC numbers" (`outbox-agents.test.ts`, to write).

## 6. Outputs and side effects

`.arima/notion-map.json`; `.arima/mirror/*.json`; `.arima/outbox/{applied,rejected,conflicts}/<id>.json` plus `<id>.result.json`; Notion pages (create, update, append blocks, retire); events `notion.pull`, `notion.push`, `notion.conflict`, `notion.refused`. The `Last written by run` property carries the run id on every written row (spec 9.3). `[PROPOSED]` inbox outputs: events listed in 5.5 and a cursor file.

## 7. Exit codes

| Script | Code | Meaning | Registry |
| --- | --- | --- | --- |
| `arima-notion` | 0 | ok | listed |
| | 1 | verification failed, Notion error, or any entry rejected, in conflict or deferred | listed |
| | 2 | usage or missing token | listed |
| | 11 | `pull` or `push` while a run holds the lock (after the 60 s wait) | PROPOSED, WP-160 adds it to the registry |
| | 12 | `push` while the kill switch is on | PROPOSED, WP-160 adds it to the registry |

The inbox has no exit code of its own: refused human inputs are events and questions, and `arima-dispatch` reports them in the digest.

## 8. Conditions and rules

- Human-only fields (`humanOnly` in `schema.ts`): Gates `Approvers`, `Decided by`; Gates `Status` values Approved, Approved with conditions, Rejected; Decisions `Veto`, `Veto reason`; Questions `Answer`, `Answered by`; Releases `Prod deploy approval`, `Prod deploy approver`; Change Requests `Decision`, `Approver` (`notion-template.test.ts` "flags exactly the human-only fields of 9.3"). Enforced for every outbox entry whoever wrote it.
- `Status` is opt-in: refused unless `--allow-status-writes` (human) or `init`. The engine will own it in WP-108.
- No delete: no op exists, the guard blocks delete or archive calls to the Notion API in Bash (`api.notion.com` with DELETE, `in_trash`, `archived`) and in Notion MCP tool names. Hard stop `notion_delete` is enforced by absence plus guard.
- Notion Free plan limits (spec 9.4): 5 MB files and 7 day history are why the state branch snapshots the mirror; nothing in sync code depends on the plan.

## 9. Failure handling

| Failure | Result | State |
| --- | --- | --- |
| Notion unreachable at pull inside push | all entries deferred, event, exit 1 | outbox unchanged |
| 4xx (not 429) on a write | entry rejected with Notion's text | in `rejected/` |
| 5xx, network error on a write | entry deferred, loop stops | stays in outbox; the create/update retry check makes the re-run safe |
| 429 | retried with backoff; after 5 retries thrown as transient | deferred |
| Human edited the same property | conflict | human value kept; orchestrator re-reads and re-proposes or raises a question (spec 3.3) |
| Corrupt entry file | rejected "not valid JSON" | in `rejected/` |

## 10. Tests and verification

Existing (`plugins/arima/scripts/test/`): `outbox.test.ts` (blocks, backoff, mirror, create/update/append, duplicates, conflicts), `notion-template.test.ts` (19 databases, relations, human-only flags, bootstrap idempotent), `real-notion-shapes.test.ts` and `fake-notion.ts` (the fake keeps real shapes), `secrets-dispatch.test.ts` (secrets never reach Notion; future `base_last_edited` ignored), `judge4.test.ts` (transient classification for reads), `killswitch-hardening.test.ts` (switch creation), `test-live/notion.live.test.ts` (real dev workspace, `npm run test:live`).

To write: `outbox-agents.test.ts` (WP-104, including `database_not_allowed` for a developer entry aimed at `gates`, a role that is not in `ROLES`, a bad run id); `inbox.test.ts` (WP-140: approval by listed and unlisted person, answer, veto, priority, idempotence); `interactive-lock.test.ts` (WP-160: lock wait then 11; push 12 while paused; pull allowed while paused); an outbox entry with `id: "../../x"` stays inside the outbox buckets; a stale agent entry carrying `Status` is refused during `init`.

## 11. Dependencies

Built on WP-006, WP-007. Needs: WP-101 (schemas), WP-104, WP-107 and WP-108 (state machine, Status ownership) before WP-140; WP-330 for `checkApprover()` details; WP-160 for the lock and kill-switch rule; WP-101 (reason code `database_not_allowed`).

## 12. Status and resolved decisions

`[BUILT]`: bootstrap, map and migrate, pull, push with every rule above, retry. `[SPEC]` and `[PROPOSED]`: inbox (WP-140), role binding and database allow-list (WP-104), lock and kill-switch rule (WP-160), Status ownership (WP-108). Decided under `09-owner-decisions.md`:

| Decision | Reason | Implemented by |
| --- | --- | --- |
| RD-F03-1: the inbox compares the new mirror with a cursor file of processed human-only values (`.arima/state/inbox-cursor.json`), not with a kept copy of the previous mirror | Small, idempotent (same diff twice changes nothing), survives a re-pull; the mirror stays one file per database | WP-140 |
| RD-F03-2: push enforces a per-role database allow-list (table `OUTBOX_DATABASES` in `roles.ts`): the orchestrator may write all databases except human-only fields; every other role only the databases of its own artifacts and the shared `questions` and `decisions` records (for example developer: stories non-Status fields and bugs; qa: test cases and bugs; tech-lead: documents; security: risks and documents; never `gates`, `digests`, `cost_log`, `milestones`, `releases`). Violation: rejected, reason `database_not_allowed` | Spec 11.2 says "outbox" without limits; least privilege costs one table and stops a wrong-role write early (09 section 1: tools match the whole job, no more) | WP-104; new reason code in `03-contracts.md` section 9b |
| RD-F03-3: outbox `id` pattern, `role` in `ROLES`, `run_id` pattern are validated by the schema and at push (the traversal case is already fixed, G-01) | A crafted id must never leave the buckets | WP-104 (`outbox-agents.test.ts`) |
| RD-F03-4: the inbox is a library called by `arima-dispatch` step 3 and by `arima-gate --decision-sync`; there is no `arima-notion inbox` command | One code path applies human inputs, so there is no second place where an approval could be accepted differently | WP-140 |
| RD-F03-5: interactive `pull` and `push` wait up to 60 s for the run lock then exit 11; `push` exits 12 while the kill switch is on; `pull` ignores the kill switch (read-only) | Spec 12.4 and G-10; a paused project must stay readable | WP-160 |
| RD-F03-6: `init` pushes agent leftovers with `Status` writes off (F01 RD-F01-1) | G-02 | WP-104 |
| RD-F03-7: a human input from someone who is not a listed approver is ignored, logged `notion.refused`, and raises one question; nothing is reverted in Notion (human edit wins) | Spec 3.3 and D-40; the owner sees it in the digest | WP-140, WP-330 |

No item is left open; no critical blocker remains for this feature.
