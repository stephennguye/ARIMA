# Real-world checks, 2026-11-18 (Stage 0, step S0.2)

What was run for real (not mocked), what it showed, and what changed because of it. Claude Code 2.1.326, Node 24, Windows 11, git bash. Throwaway project directories only; all removed afterwards. No token value appears anywhere in these notes or in the repository.

## Done

| Check | Result |
| --- | --- |
| Notion token | Valid. Bot "ARIMA" in workspace "Gà Bông's Notion" |
| Notion pages shared with the integration | **0.** Bootstrap, map, mirror, outbox and init against real Notion are therefore still NOT done (see "Waiting on the owner") |
| `arima-run-agent` smoke run (QA role, "reply OK") | Passed: exit 0, real result JSON parsed, one ledger row, `run.start`/`run.end` events, run report |
| Plugin loads in a live session (`--plugin-dir`) | Passed: agent `arima:orchestrator` and skills `arima:init`, `arima:status`, `arima:pause` all listed |
| Hooks in a live session | Passed: `Read .env` blocked with the exit-2 message and a `tool.blocked` event; an allowed `Write` logged as `tool.used`; `Stop` logged as `agent.stop` |
| Orchestrator agent obeys its own must-nots | Yes: refused a secret read and a write outside `.arima/` before any hook ran |
| **Headless role run that must succeed (judge blocker 7)** | Passed: orchestrator ran `node "D:/.../arima-config.mjs" validate` under `--allowedTools` and `dontAsk`; output "config valid". So the allow-list patterns **do match quoted commands with forward-slash Windows paths**, `--agent arima:orchestrator` resolves, and plugin hooks fire in the wrapper's headless run, with role and run ID recorded |
| **Headless run attempting five forbidden actions** | All five blocked, `team.yaml` untouched. Three were stopped by the guard hook (`gh pr merge`, `git push origin main`, `arima-pause --resume`); two (`Read .env`, `Write team.yaml`) were stopped earlier by the permission deny rules. Two independent layers, as intended |
| Real result JSON for success, turn cap and budget cap | Recorded as scrubbed fixtures (`test/fixtures/claude-real/`) and tested |
| **Guard launcher with Node missing (ADR-0005)** | Passed: with Node removed from `PATH`, a plain `Read` of an ordinary file was blocked with "ARIMA guard cannot run because Node.js was not found, so this action is blocked to be safe". So `command -v` works in Claude Code's real hook shell on Windows and the guard fails closed |

## What the real runs taught us

1. **Real error results carry `is_error: true`, an `errors` list and a `terminal_reason`** (`completed`, `max_turns`, `budget_exhausted`). My hand-written fixtures had `is_error: false` for the turn cap. The parser now keeps `errors` and `terminal_reason`, and the run report includes them. Subtype names (`error_max_turns`, `error_max_budget_usd`) were right.
2. **A run has a floor cost of about $0.15 to $0.24.** A "reply OK" run costs that much because of the context Claude Code loads (about 57k tokens with this machine's installed plugins and skills, about 30k with settings isolated). A run capped at $0.0001 still cost $0.167. So `--max-budget-usd` below about $0.20 cannot hold, and the spec's per-story budgets (S = $1) allow only a handful of runs. Later headless runs were cheaper (about $0.03 to $0.22) once the prompt cache was warm, so cost varies a lot. This feeds spec issue S3 and the Stage 1 budget calibration.
3. **Permission-rule denials leave no audit event.** When a deny rule stops a tool call, no hook fires, so there is no `tool.blocked` event. The docs list a `PermissionDenied` hook event; logging through it is now a planned step.
4. **A first Notion call failed with a connection reset, and the retry worked.** Notion reads need retry on transient network errors. Creates must not be retried blindly (a retry after an ambiguous failure could duplicate). This is a planned step.
5. **`@notionhq/client` does not import as a named export under plain Node ESM.** It works in ARIMA's bundled scripts (esbuild handles the interop). Any new plain-Node script must use the bundle or a default import.
6. **The wrapper did not load the plugin.** A headless run only had ARIMA's hooks and agents if the plugin happened to be installed for the user. It now passes `--plugin-dir` explicitly.

## Waiting on the owner

- Share a Notion page with the "ARIMA" integration (the API cannot create a top-level page). Then: bootstrap, map, init, mirror, outbox, human-edit timestamp granularity, rollup and formula acceptance, rate limits, and whether bot-created mentions send email (spec §12.3, D-23).
- A throwaway GitHub repo and machine account for the first real GitHub checks (judge gap 1).
