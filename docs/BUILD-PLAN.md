# ARIMA build plan

Five increments (spec §15.3). v0.1 is broken into tasks with acceptance criteria; later increments are outlined and get detailed when the previous one ships. Tick a task only when every acceptance criterion holds, tests pass and `claude plugin validate ./plugins/arima` passes.

Spec references use §N (e.g. §4.1 = spec section 4.1).

---

## v0.1 Foundations

**Goal:** `/arima:init` turns a brief into a working, mapped Notion workspace and project config; every run leaves a ledger row and events. No agents build product code yet.

**Done when:** on a fresh sample project, `/arima:init` with `examples/brief.md` validates config, maps the Notion workspace, writes the brief and charter skeleton to Notion, opens the G0 page, and `.arima/` on the `arima-state` branch holds a valid ledger row and event log. `/arima:status` and `/arima:pause` work.

### T-01 Tooling and CI for this repo
- [x] `package.json` at repo root (workspace) with TypeScript strict, ESM, Node 22 engines, Vitest, ESLint, Prettier, esbuild.
- [x] Source in `plugins/arima/scripts/src/`, bundles in `plugins/arima/scripts/dist/` (ADR-0001). `npm run build` bundles each entry point.
- [x] GitHub Actions workflow for this repo: install, lint, typecheck, test, build, fail if `dist/` differs from a fresh build.
- **Accept:** `npm test` and `npm run build` pass on a clean clone in WSL 2; CI is green.
- **Notes (done 2026-11-18):**
  - Root `package.json` declares the workspace `plugins/arima/scripts`; `npm run build` bundles every `src/bin/*.ts` to `dist/<name>.mjs` (esbuild pinned exactly for reproducible output; `.gitattributes` forces LF).
  - `npm run check:dist` rebuilds and fails on any `dist/` diff; CI runs it on ubuntu and windows, Node 22 and 24.
  - Developed on native Windows with Node 24 (WSL not used); code and scripts avoid Windows-only paths.
  - Version rule: never push to `main`. `.githooks/pre-push` (enabled by `npm install` via `prepare`) blocks it locally and GitHub branch protection blocks it remotely.
  - `npm audit` reports a high ReDoS in dev-only `picomatch` (transitive of vitest/typescript-eslint); not shipped in bundles. Revisit when upstream releases a fix.
  - Runtime deps (`@notionhq/client`, `ajv`, `ajv-formats`, `yaml`) are added in the tasks that first use them.

### T-02 Config schemas and validator (§4.1, §4.2, §4.4)
- [x] Review and complete `schemas/arima.schema.json` and `schemas/team.schema.json` (drafts provided).
- [x] CLI `arima-config validate [--project <dir>]`: loads `arima.yaml` + `team.yaml`, validates schemas, then cross-field rules:
  - every gate approver role in the active profile maps to a `human` role (§4.2);
  - `developer.count` ≤ `parallelism.max_developer_agents`;
  - every `person:` reference exists in `people`;
  - `runtime.allow_usage_credits: true` requires a note in the digest config (warn only).
- [x] Clear, line-referenced error messages; non-zero exit on failure.
- **Accept:** unit tests cover each schema error and each cross-field rule; `examples/` validates clean.
- **Notes (done 2026-11-17):**
  - Strict Ajv mode exposed a draft-schema defect (properties without type); fixed in arima.schema.json.
  - Errors are file:line-referenced via the YAML AST (lib/yaml-source.ts); Ajv oneOf noise is collapsed to one error per role.
  - Cross-field rules need the profile loader, so T-03 was built first. usage-credits rule warns only; there is no digest-config field yet, so the message points at Q-22.
  - CLI exit codes: 0 valid, 1 invalid, 2 usage; --json for machine output.

### T-03 Profiles (§4.3)
- [x] Loader for `profiles/*.yaml` (drafts provided) resolving gates, approvers, required artifacts and rules for the configured profile.
- **Accept:** tests prove client-project requires G0–G4 and solo-lite only G1, G3; regulated requires pentest and DPIA always.
- **Notes (done 2026-11-17):**
  - Built before T-02 because T-02's approver rule needs the profile loader (order swap).
  - Added profile.schema.json; loader in scripts/src/profiles.ts validates each profile at load. Shared helpers: lib/paths.ts (plugin root, works from src and dist), lib/schema.ts (Ajv 2020 + formats), lib/yaml-source.ts (JSON pointer to line number).

### T-04 ID issuer (§2)
- [x] `arima-ids next <PREFIX>` issues the next ID (REQ-014, US-112, DEC-0120, …) with the zero-padding from §2; counters in `.arima/state/ids.json`; file lock; never reuses an ID.
- **Accept:** concurrent-issue test (parallel processes) yields unique, gap-free IDs; unknown prefix rejected.
- **Notes (done 2026-11-17):**
  - Added schemas/ids.schema.json so ids.json is validated like all other ARIMA JSON; a corrupt counter file is an error, never reset (reset could reissue an ID).
  - lib/filelock.ts (O_EXCL lock file with stale-lock break; retries EPERM for Windows) and lib/atomic-file.ts are reused by the ledger, event log and outbox.
  - Counter prefixes only: MTG, G, v and r IDs are not counters (spec §2) and are rejected. Width is a minimum, so REQ-1000 is valid.
  - Concurrency tested in-process (40 calls) and across 6 real processes x 6 calls.

### T-05 Event log and ledger (§13.2, §11.3 Audit)
- [x] Append-only writers for `.arima/events.jsonl` and `.arima/ledger.jsonl`, validated against `schemas/event.schema.json` and `schemas/ledger.schema.json`.
- [x] Parser that turns a `claude -p --output-format json` result into a ledger row; for resumed sessions stores the cost difference from the previous result of that session (§13.6).
- **Accept:** fixture-based tests for success, error_max_turns, error_max_budget_usd and resumed-session results.
- **Notes (done 2026-11-17):**
  - events.ts and ledger.ts are append-only (no update/delete API); every line is validated against its schema and scanned for credential-shaped strings (lib/secrets.ts, reused by the T-13 guard).
  - parseClaudeResult accepts both a single result object and a message array. Fixtures are hand-written from the documented result shape; the first real-CLI shape check happens in the T-06 smoke run.
  - Resumed sessions: cost stored as total minus what earlier rows of the same session_id already hold, clamped at 0. Tokens and durations are stored as reported (spec only defines the cost rule).
  - Added runid.ts issuing r-YYYYMMDD-HHMM-NN with a per-day counter under lock (needed by T-06); local host time.
  - error_max_turns and error_max_budget_usd map to result blocked (spec 7.12); callers may override the outcome (e.g. QA fail).

### T-06 Agent-run wrapper (§3.2, §13.3, §13.5)
- [x] `arima-run-agent --role <r> --item <id> --budget <usd> --max-turns <n> --prompt-file <f> [--cwd <worktree>]` invokes `claude -p` with `--output-format json`, `--max-budget-usd`, the turn cap and the role's tool allow-list; sets `OTEL_RESOURCE_ATTRIBUTES` (`arima.project`, `arima.phase`, `arima.item`, `arima.role`, `arima.run_id`); writes the ledger row and start/end events.
- [x] Detects a seat usage-limit stop and records it as a pause, not a failure (§4.4).
- **Accept:** tested with a stub `claude` executable on PATH; one manual smoke run against the real CLI documented in the task notes.
- **Notes (done 2026-11-17):**
  - Tested with a stub CLI (test/fixtures/stub-claude.mjs, selected via ARIMA_CLAUDE_BIN or the claudeBin option; a node .mjs stub is run through node so it works on Windows without a .cmd shim). 28 tests cover caps, tools, OTEL attributes, rework, resume cost diff, usage-limit pause, timeout, spawn failure, garbage output and the per-run cap guard.
  - MANUAL SMOKE RUN NOT DONE (needs your go, it spends a little seat usage). To do it: copy examples/arima.yaml and examples/team.yaml into a scratch dir, put 'Reply with the single word OK.' in p.md, then run: node plugins/arima/scripts/dist/arima-run-agent.mjs --role qa --item none --budget 0.1 --max-turns 2 --prompt-file p.md --project <scratch dir>. Expect exit 0, one ledger row and run.start/run.end events. This also confirms the real result JSON shape the parser assumes.
  - Verified without a model call: claude 2.1.326 accepts --max-turns (hidden from --help), --max-budget-usd, --permission-mode dontAsk, --allowedTools/--disallowedTools, --agent, --resume, --output-format json.
  - Run results: exit 0 pass, 1 failed/error, 2 usage or invalid config, 3 blocked by turn or budget cap, 75 paused at usage limit (recorded as result paused, event run.paused, never run.end).
  - Least privilege: only the orchestrator keeps the Notion token in its environment; only developer, tech-lead and devops keep the GitHub machine token; no role may use any Notion MCP tool. Tool rules use Claude Code permission syntax such as Bash(git *); confirm the exact matching in the smoke run.
  - Prompt goes in on stdin (no argument-length or quoting problems on Windows). The wrapper passes --agent arima:<role> only if agents/<role>.md exists (none until T-11).
  - Extra flags beyond the plan: --project, --phase (default 4), --attempt, --milestone, --rework-reason, --session, --agent.

### T-07 Preflight, lock and kill switch (§7.2 step 1, §11.1)
- [x] `arima-preflight`: config valid, no other run holds `.arima/run.lock`, kill switch off (Notion root-page checkbox, or `PAUSE` file on the state branch when Notion is unreachable), budget remaining > 0, required env vars present.
- **Accept:** each failing condition returns a distinct exit code and an event; tests for each.
- **Notes (done 2026-11-17):**
  - Kill switch design: a standalone Notion root page has no checkbox property, so the 'Pause ARIMA' switch is a to_do block on the root page (text exactly 'Pause ARIMA'), read and toggled through blocks.children.list / blocks.update; /arima:pause (T-12) will create it on first use. Either the Notion switch or .arima/PAUSE being on pauses ARIMA (fail closed); if Notion is unreachable the PAUSE file alone decides and the result carries a warning (spec §11.3, §7.12).
  - Added notion/port.ts: a narrow NotionPort (list/update/append to-do blocks) over a structurally-typed SDK client. The SDK exposes blocks.delete; the port does not, so delete is impossible by construction. T-09/T-10 extend this port. lib/throttle.ts (~3 req/s) is ready for them; the SDK already retries 429 (configured to 5 retries).
  - Run lock: .arima/run.lock holds pid, run id, host and start time; it is stale if its process is gone (same host) or older than max_run_minutes + 30. arima-preflight --acquire <run-id> takes it after all checks pass; 'release --run-id' frees it only for its owner.
  - Exit codes: 0 ok, 2 usage, 10 config, 11 lock, 12 kill switch, 13 budget, 14 env. Checks run in a fixed order; every failure is a preflight.fail event; exit code is the first failure's. Env check reports variable names only.
  - Beyond the plan: budget threshold alerts (50/80/100%) are emitted once as budget.alert events from preflight (spec §13.5) - daily ones once per day.
  - Not verified against real Notion (mocked SDK only); the real check happens with the T-09 manual run.

### T-08 State branch persistence (§3.2 Local state, D-09)
- [ ] `arima-state pull|push`: maintains `.arima/` on the orphan branch `arima-state` via a dedicated git worktree; never touches `main`; push is a single commit per run with the run ID in the message.
- **Accept:** integration test in a temp git repo: pull → modify → push → fresh clone pull restores state.

### T-09 Notion template bootstrap and mapping (§9.1–9.4)
- [ ] `arima-notion bootstrap --parent <page-id>`: creates the 19 databases with every property and relation from §9.1 under a page (used once to build the public template).
- [ ] `arima-notion map --root <page-id>`: finds the databases under a duplicated template, verifies every required property exists with the right type, writes `.arima/notion-map.json` (validated by `schemas/notion-map.schema.json`, to be written in this task). Missing properties are reported; `--migrate` adds them.
- [ ] Human-only fields (§9.3) flagged in the map so the sync layer can refuse writes to them.
- **Accept:** tests against a mocked Notion client; one manual run against a real workspace recorded in task notes. Views (§9.2) are documented for manual setup in `docs/NOTION-TEMPLATE.md` if the API cannot create them.

### T-10 Notion sync: mirror and outbox (§3.3)
- [ ] `arima-notion pull`: mirrors all mapped databases to `.arima/mirror/<db>.json` (read-only for agents).
- [ ] Outbox: agents write proposed changes as files in `.arima/outbox/` (validated by `schemas/outbox.schema.json`); `arima-notion push` applies them, refuses human-only fields, stamps "Last written by run", detects conflicting human edits (last edited time) and keeps the human edit, retries on 429, throttles to ~3 req/s.
- [ ] No delete operation exists in the code path.
- **Accept:** tests for apply, human-only refusal, conflict detection and retry; delete is impossible by construction.

### T-11 Orchestrator agent, minimal (§5.2)
- [ ] `agents/orchestrator.md` with mission, tools, must-nots and escalation rules from §5.2, trimmed to v0.1 abilities (init, status, pause).
- **Accept:** `claude plugin validate` passes; agent loads in an interactive session.

### T-12 Skills: `/arima:init`, `/arima:status`, `/arima:pause` (§6.0, §14)
- [ ] `skills/init/SKILL.md`: checks the brief against `templates/project-brief.md` and asks for gaps; runs `arima-config validate`; asks for the duplicated template root page ID and runs `arima-notion map`; writes brief, charter skeleton and budget plan via the outbox; creates the G0 page with an evidence-pack checklist; commits state.
- [ ] `skills/status/SKILL.md`: prints phase, gates, open questions, budget used vs caps from mirror + ledger.
- [ ] `skills/pause/SKILL.md`: sets/clears the kill switch (Notion checkbox and `PAUSE` file).
- **Accept:** the v0.1 "Done when" scenario passes end to end on the sample project.

### T-13 Hooks, minimal (§11)
- [ ] `hooks/hooks.json`: PostToolUse and Stop/SubagentStop handlers append events; PreToolUse guard blocks reading or editing secret files (`.env*`, key files, `ARIMA_*` token files) and any Notion delete tool.
- **Accept:** hook tests with fixture payloads; blocked actions produce an event and a clear message.

### T-14 Docs and evals skeleton
- [ ] `docs/INSTALL.md` (WSL 2 setup, env vars, Notion integration, duplicating the template), `docs/NOTION-TEMPLATE.md`.
- [ ] `evals/v0.1/`: sample brief + script that runs init against a mocked Notion and checks expected outputs.
- **Accept:** a new user can follow INSTALL.md to a working `/arima:status`.

---

## v0.2 Build loop (web) — outline

Ticket state machine (§7.1) with guards; developer, tech-lead and qa agents (§5.6–5.8); git worktrees per developer run; machine-account PRs (D-30) and the merge guard hook requiring your approving review (D-29); review queue limit (D-21); daily run `/arima:run` for Phase 4 (§7.2); daily digest (§12.1); Windows Task Scheduler setup script (§4.4). **Done when:** 5 stories go from Ready to staging unattended, each with a digest entry and cost per story.

## v0.3 Discovery and design — outline

ba, ux, architect and security agents (§5.3–5.5, 5.9); all templates (§8.2); meeting protocol (§7.3); gates G0–G2 with evidence packs (§7.4, D-28); question protocol (§7.5); RTM view; client guests and Client portal (D-17). **Done when:** a brief reaches G2 with every required artifact and no human editing of agent output beyond answers.

## v0.4 Release and operations — outline

Phases 5–8 (§6.5–6.8); G3–G4; approval-gated production deploy script (D-29); incidents and hotfix (§7.8); change requests (§7.9); recurring jobs (§7.10); retros and lessons (§7.11); OpenTelemetry option (§13); decide Q-21. **Done when:** the eval project completes a release, a simulated incident and a CR.

## v1.0 Stable — outline

Showcase project end to end; eval suite in CI; schema migrations; marketplace install in under 30 minutes; complete docs; semantic versioning.
