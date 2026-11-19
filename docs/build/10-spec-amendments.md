# 10 Spec amendments awaiting the owner's approval (WP-013)

The master spec may change only with the owner's approval. The decisions D-43 to D-49 and the card and feature resolutions make these edits necessary; **none has been applied yet**. Approve the list (or strike items), then one session applies them to `docs/spec/ARIMA-Master-Spec.md` and the matching ADRs and records the result in the spec's version table.

| # | Spec section | Change | Why (decision) |
| --- | --- | --- | --- |
| 1 | 3.2, 5.2 | The orchestrator dispatches by script, not by an in-session Agent tool; "the orchestrator holds the Notion token" means the host process | Card resolution (orchestrator) |
| 2 | 5.1 | QA has no Phase 6 activity (production smoke test is DevOps's); architect and security also act in Phases 0 and 1 | 6.0 and 6.1 govern |
| 3 | 5.3 | The BA recommends priorities; the engine applies the recommended order as a logged decision after the veto window; the PO's edit wins | D-43 |
| 4 | 5.4 | UX serves the prototype through a host script; design-QA verdicts are posted by the host as PR comments | D-49 |
| 5 | 5.6, 6.4 step 7, 6.5 step 1, 10.3, 11.2 | The tech-lead posts a comment review (never approves or merges); `arima-merge` merges; `arima-release` tags the release candidate and versions | D-30, D-37, D-38, D-49 |
| 6 | 5.10, 11.2 | DevOps works with GitHub, Git, GitHub Actions and Docker (no cloud CLI); secrets row becomes "none, names only" | D-47 |
| 7 | 6.1 step 8, 7.4, 3.3 | A baseline is frozen when its gate is approved; a pre-gate snapshot is kept as evidence-pack input | D-45 |
| 8 | 7.4 step 5 | "accepted only if the decider is a named approver" (the per-property editor check is deferred, D-40) | S1 |
| 9 | 6.3 step 1, 6.6 step 3, 10.1, 10.4, 11.1 | Environments are Docker Compose projects on the owner's machine (preview, staging, production); no deploy workflows in Actions; production only through the approval-gated local script `arima-release` | D-47, D-29 |
| 10 | 7.8 step 2 | DevOps proposes the rollback; the owner runs it through the gated script (P1/P2 request by urgent @mention) | D-47 |
| 11 | 7.11 | Project lessons are approved by the tech-lead; the owner may veto | D-43, D-44 |
| 12 | 8.1 | UAT master is Documents rows (there is no Test Runs database) | Card resolution |
| 13 | 9.1 | Cost log `Item` is ID text (ADR-0004) | S13 |
| 14 | 11.1 | "Sixteen hard stops" (the canonical list in code) | D-42 |
| 15 | 11.2 | Align the permissions matrix to the roles: no GitHub tokens, orchestrator does not run builds, security uses `arima-scan` | D-49 |
| 16 | 12.1 | The digest is built on demand until Gate U; month-to-date spend is shown beside lifetime spend (the project cap is lifetime) | D-41 |
| 17 | 14 | Add `/arima:stabilize` (Phase 5) making 19 commands; `/arima:run` covers Phase 4 and operations; `/arima:init` runs Phase 0 to G0 | D-46 |
| 18 | 15.3 | v0.2 acceptance is attended | D-41 |
| 19 | 4.1, 15.1 | Reference stack `stacks/default-web` supersedes "no default stack" (D-12) for the sample project; add config keys `review.architecture_paths`, `github.allow_unchecked_remote`, `licence.allowed`, `environments.max_previews`, `budget.role_caps` | D-47, ADR-0007 |
| 20 | 4.4 | The host is the owner's machine with WSL 2 or native Windows plus Docker; a sandbox for unattended runs | D-36, D-37 |
| 21 | 7.1 | `Done → Released` actor is the engine on a recorded production deploy | Card resolution (devops) |

Also to amend (not spec): ADR-0006 (sandbox uses a per-run clone instead of a mounted worktree; no Docker socket in any role container; egress through an allow-list proxy); `plugins/arima/agents/orchestrator.md` (drop the `init`/`pause` claims, match `allowedTools`); `docs/process/JUDGE.md` (judge works on a copy; done).
