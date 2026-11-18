# Spec issues for the owner to decide

These are places where the master spec contradicts itself, cannot be implemented as written, or is silent on something the build needs. They came from building v0.1 and from the judge's review (`docs/process/reviews/2026-11-18-pre-stage0.md`). **Nothing here has been changed in the spec.** Each issue has a proposed resolution; tell me which to accept, and I will write the ADR and amend the spec.

Status key: **Open** (needs your decision), **Blocking** (a build step cannot be finished safely until decided).

---

## S1. Gate approver identity cannot be checked as the spec says (Blocking, needed before gates are built)

- **Spec:** §7.4 step 5 and §4.2: "accept the decision only if the Notion editor of the decision field is a person listed as approver".
- **Problem:** Notion's API gives `last_edited_by` for a whole page, not for one property. ARIMA's own writes (the audit stamp, evidence-pack edits) would also change that value to the integration. And any Notion member or guest who can edit the page could set the decision field.
- **Proposed resolution:**
  1. A gate page has a Decision property (human-only) and a **Decided by** person property (human-only).
  2. After a gate is set to "Ready for review", ARIMA **never edits that page again** until a decision is recorded, so the page's last editor is the person who set the decision.
  3. A decision counts only if the page's `last_edited_by` is a listed approver AND the Decided by person (if filled) equals that person.
  4. Notion's own permissions are used as a second layer: only approvers get edit access to gate pages; others get comment access.
  5. Verify the mechanism against real Notion in step S0.3, before any gate code is written.

## S2. The "11 hard stops" are not the same list everywhere (Open)

- **Spec:** §11.1 lists 11; §4.1's `autonomy.hard_stops` lists five separate gate ids plus six others, with no ids for story budget, licence, critical finding or kill switch; §7.12 adds "missing credential" as a hard stop but it is not in §11.1.
- **Proposed resolution:** The hard stops are fixed in code, not configurable. Define one canonical list of ids (gates, prod_deploy, secrets_change, budget_exceeded, story_budget, notion_delete, prod_data_migration, new_paid_service, licence, critical_finding, kill_switch, missing_credential). Keep `autonomy.hard_stops` as documentation only (the validator already warns when the list is shortened), or remove it at the next schema version.

## S3. Budget defaults contradict "run caps below story budget" (Open)

- **Spec:** §13.5 "set run caps below the story budget"; §4.1/Q-20 defaults are per-run cap $2, story budgets S $1, M $3, L $6; D-08 says one run each for development, review and QA.
- **Evidence:** a run costs at least about $0.15 to $0.24 even for a trivial prompt (measured). An S story at $1 can afford about four runs; an M story at $3 is likely exhausted by development plus review.
- **Proposed resolution:** keep the numbers as "estimated consumption" defaults, but (1) state the floor cost per run in the spec, (2) set the per-run cap to the smaller of $2 and the remaining story budget at dispatch, (3) recalibrate the S/M/L budgets after the first real milestone from the estimate-accuracy metric, as §7.1 already intends.

## S4. Who is allowed to merge is described five ways (Open)

- **Spec:** §5.2 orchestrator must not merge; §5.6 tech-lead "waits for your approval and is then merged automatically"; §10.3 "ARIMA merges automatically"; §11.2 "tech-lead merges after human approval"; D-29 a hook blocks pushes to main.
- **Proposed resolution:** exactly one actor merges: a single ARIMA merge script, run by the orchestrator's session, that refuses unless CI is green, QA passed and the human's approving review exists. No agent has `gh pr merge`, `git push` to the default branch, or `gh api` writes (the role lists no longer grant these, and the guard blocks the literal forms; the second review showed the guard alone can be bypassed, so the real barrier is GitHub branch protection plus the rule below that agents never hold push credentials, S16). Reword §5.2, §5.6, §10.3 and §11.2 to say "the merge script".

## S5. `/arima:init` cannot duplicate the Notion template as §9.3 says (Open, pending S0.3)

- **Spec:** §9.3 "`/arima:init` duplicates the template and records every database ID".
- **Today:** init verifies and maps a workspace that already exists (built by `arima-notion bootstrap`, or duplicated by hand). Whether Notion's API can duplicate a page has not been confirmed from the docs or tried yet.
- **Proposed resolution:** after S0.3 confirms what the API allows, amend §9.3 to say what really happens (probably: the owner duplicates a published template, or runs `bootstrap`; init verifies and maps it).

## S6. Windows-first versus WSL 2 (Open)

- **Spec:** D-15 and §4.4 say ARIMA runs inside WSL 2, partly because sandboxed command execution works there and not on native Windows. `CLAUDE.md` says the same.
- **Today:** the owner asked for Windows-first. The code, INSTALL and README follow that. The schema still allows `shell: wsl2 | native` and the example config says `wsl2`.
- **Consequence to accept knowingly:** on native Windows there is **no OS sandbox** around agent commands. Safety then rests on tool allow-lists, hooks and the scrubbed environment, which can be bypassed by code the agent is allowed to run (for example the project's own `npm run` scripts).
- **Proposed resolution:** native Windows is supported for interactive use and development; **unattended scheduled runs should use WSL 2 or Linux** until another sandbox exists. Amend D-15, set the example config accordingly, and say this in INSTALL.

## S7. "Notion MCP" wording still in the spec (Open, minor)

- §3.2 and §5.2 still say "Notion MCP"; ADR-0003 (accepted) and §9.4 say the public API with ARIMA's scripts. Amend the two places.

## S8. Stale or inconsistent text in §0 and §16 (Open, minor)

- §0 says 3 questions remain open; §16.1 shows Q-04, Q-20 and Q-21 open, Q-05 missing, and Q-01 "Decided" inside the open table. Q-07 still reads "email plus Notion notifications" although D-23 amended it. Clean up.

## S9. The ID-in-commit rule collides with normal commits (Blocking for step 1.4)

- **Spec:** §2 "every commit message and PR title MUST include a US, BUG, INC or CR ID (enforced by hook)".
- **Collides with:** `chore/` and `docs/` branches (§10.2), dependency-update pull requests, release commits, and ARIMA's own `chore(state): run r-...` commits on `arima-state`.
- **Proposed resolution:** the rule applies to commits and PR titles on `feat/`, `fix/` and `hotfix/` branches; `chore/` and `docs/` branches, dependency PRs and `arima-state` commits are exempt but must still carry a run ID or an ADR/task ID.

## S10. Phase 3 exit needs a deploy script that is built two stages later (Open)

- **Spec:** §6.3 exit requires "ARIMA's merge guard and approval-gated deploy script active (D-29)"; the build plan makes `/arima:setup` v0.2 but the deploy script v0.4.
- **Proposed resolution:** ship a **stub deploy script** in v0.2 that refuses to deploy to production under any condition and only deploys to staging, with its hard stop tested; the real approval-gated production path arrives in v0.4. Amend the exit checklist to "approval-gated deploy script present (production path disabled until v0.4)".

## S11. `stacks/` versus D-12 (Open)

- **Spec:** D-12 says no fixed default stack, the architect proposes per project; §1 principle 12, §4.1 (`stacks:`), §5.5, §6.3 and §15.1 (`stacks/default-web`, `default-backend`) all assume default stacks. Q-04 (hosting) is also open.
- **Why it matters now:** the v0.2 walking skeleton needs a stack and a staging host before the architect agent exists (v0.3).
- **Proposed resolution:** for v0.2 the owner picks one stack and one staging host for the sample project and records it as an ADR; v0.3's architect proposes stacks per project; `stacks/` holds at most one reference stack template used by the v0.2 eval.

## S12. The Notion "Portfolio" public page versus client confidentiality (Open)

- **Spec:** §9.2 Portfolio is "a read-only public page with the overview, digests and selected documents"; §9.2 also says the Client portal excludes the decision log, cost log and agent questions, but digests include cost.
- **Proposed resolution:** Portfolio is off by default for client projects and never includes digests; the state branch is also refused on public repositories (already enforced).

## S13. Items that are not a single kind cannot be Notion relations (ADR-0004, Proposed)

- Decisions, Questions, Human tasks, Risks and Cost log refer to an "Item" that can be a story, gate, change request or bug. Notion relations point to one database, so these are ID text. Accept ADR-0004, or tell me to add one relation per target type in a template version 2.

## S14. Solo-lite and the charter (Open, minor)

- §4.3 enforces only G1 and G3 in solo-lite, yet §6.0 phase 0 and §8.1's "S" column treat the charter as not required. Confirm: "no G0 gate page" does **not** mean "no budget plan", and `init` should still write the brief and budget plan in solo-lite (it does today).

## S15. Seat usage for unattended runs (Open, owner research)

- §4.4 relies on two support articles to say that `claude -p` signed in with a Team seat draws on the plan's limits. Nobody has verified that unattended scheduled headless use of a seat is permitted by the terms, or how the limit behaves with three parallel developers. Q-21 (seat versus API key) is deferred to v0.4 but the seat is used from v0.2. Please confirm against Anthropic's current terms before v0.2's unattended runs.

## S16. Agents should never hold push credentials (Proposed, from judge #2)

- **Spec:** §10.3 and D-29 describe a hook that blocks pushes to the default branch; §5 lets the developer role run `git push` and the machine account open pull requests.
- **Problem:** a hook and a tool list are advisory for roles that can run project scripts (see S6). If the agent's environment holds a push credential, any script it runs can use it.
- **Proposed resolution:** agents work in a worktree with **no remote credentials at all**. A host script, run by the orchestrator's session and not by an agent, pushes the feature branch and opens the pull request, and is the only holder of the machine token. Combined with S4 (one merge script) and branch protection, no agent can reach the default branch even by writing its own script. This also fits the Docker sandbox design (D-36), where the container has no network route to GitHub.

## S17. The QA role has `npx playwright` (Proposed, from judge #2)

- **Spec:** §5.4 gives QA Playwright. **Today:** the role list allows `Bash(npx playwright *)`, while the guides say no `npx` is allowed to any role. `npx` can fetch and run arbitrary packages.
- **Proposed resolution:** keep Playwright, but run it through a pinned local binary (`node_modules/.bin/playwright`, installed by `npm ci` from a lock file) and drop `npx`; say so in the guides. Until then the guides state the exception. Decide together with S16, since both are about what a role may execute.

---

## Decisions already made that this list builds on

D-12, D-13 to D-15, D-17, D-21, D-23, D-29, D-30, D-33, ADR-0001 to ADR-0003 (accepted).
