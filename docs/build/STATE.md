# STATE (living snapshot; update before ending every session)

Last updated: 2026-11-19. Verify these claims against git before relying on them (`00-handoff.md` section 1).

## Where the build is

- **Stage 0 (Foundations): built and verified**, except the owner close-out (WP-012).
- **Stage 1 (Platform kit): in progress.** WP-101 (contracts v1) is done on branch `feat/wp-101-contracts-v1`. Ready next: WP-102, WP-103, WP-104 (parallel in the plan; do them one at a time, in that order).
- Branch `feat/wp-101-contracts-v1` (cut from `chore/stage0-foundations`, PR #16 open against `main`). Never push to `main`.
- Last commit when this file was written: the one that added `docs/build/` (see `git log -1`). The commit before it: `1b21d93` (canonical hard-stop ids D-42, draft template alignment, MCP wording).
- Checks at that point: 758 unit/contract tests (including `build-docs.test.ts`, which keeps this folder consistent), 8 evals, lint, typecheck, format, `check:dist`, strict plugin validation (plugin and marketplace) all green. Live tier (5 tests) green against the dev Notion workspace on 2026-11-18.

## What exists (high level; details in `01-architecture.md`)

Config and profiles; IDs, events, ledger; headless run wrapper; preflight and 3-source kill switch; guard hooks and role tool lists; state branch; Notion layer (bootstrap, map, mirror, outbox, value-based conflicts); `init`, `status`, `pause`; orchestrator agent v0; 58-artifact catalog with 28 draft templates; live test tier; four judge reviews in `docs/process/reviews/`.

Not built: everything in Stages 1 to 5, including the eight other agents, the state machine, dispatcher, merge/publish scripts, digest, cost, gates, meetings, sandbox.

## Orientation

If you are new: `CONCEPT.md` first. ARIMA is a replica of a company software team (roles, gated phases, 58 owned artifacts, scheduled communications, measured cost and time) that builds a greenfield web app; the code in this repo is the machine that carries that team. The plan was re-checked against this concept on 2026-11-19: question and decision protocol moved to Stage 1 (WP-141), and packages were added for delivery metrics (WP-132), milestone review and retro (WP-217), QA authoring (WP-315) and the Phase 0 playbook (WP-321). `artifact-map.yaml` assigns every artifact to a builder.

## Decisions made on 2026-11-19 (see `09-owner-decisions.md`)

The owner steers by commands, answers only critical-blocker questions and reviews results; agents collaborate without asking permission. Tech-lead approves ADRs; baseline freezes on approval; `/arima:run` covers Phase 4 and operations only; hosting is local Docker Compose with GitHub Actions CI (reference stack in ADR-0007); no role holds a GitHub token (the host posts comments, pushes, merges, tags); no AI attribution in any commit or PR. All open questions in the agent cards and feature specs are resolved under these principles.

## Next action

1. **Approved by the owner on 2026-11-19:** the 28 template section lists and the 21 spec amendments (applied to the spec as version 0.5). The v0.1.1 tag has **not** been confirmed: do not create it unless the owner says so.
2. Builder: WP-102 (packet builder). Read `03-contracts.md` sections 3.1 and 3.2, and `features/F02-run-dispatcher.md`. Then WP-103 (report collector; `checkReport()` in `src/report.ts` already holds the kind rules) and WP-104.
3. WP-101 is done (2026-11-19): schemas `agent-report`, `question`, `finding`, `decision`, `work-unit`; 23 new event types; `reason` on the ledger row; `kinds.ts`, `reasons.ts`, `report.ts`; G-03 (preflight `needs.github`, `--no-github`); `arima-init` exit 7; `arima-ids` added to the registry; `contracts.test.ts` keeps the contract lists and the exit-code registry equal to the code. All checks were green on this branch (845 tests, 31 files).
4. WP-201 is done (ADR-0007: reference stack, local Docker).

## Open owner decisions

| Item | Question | Blocks |
| --- | --- | --- |
| v0.1.1 tag | Tag now, or wait? | Nothing |
| S15 / Gate U | Seat terms for unattended runs; Docker token | WP-230 |
| History | Rewrite git history to remove a workspace name from an old fixture (commit `b5831ea`)? Needs a force-push to a public repo. | nothing |

## Things left in the owner's accounts (do not be surprised)

GitHub `ARIMA-Test`: branch protection on `main` (1 review, admins enforced), a closed probe PR #1 and probe branches. Notion dev workspace: probe gate `G-PROBE`, probe view "S0.3 probe view" in the Documents database, and a reusable row "ARIMA live test row (safe to ignore)" used by the live tier.

## Known traps

See `00-handoff.md` section 4 (backslashes in shell-generated code, scratch in `tmp/`, one-process token loading, run cost floor).
