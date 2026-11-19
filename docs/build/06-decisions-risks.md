# 06 Decisions, spec issues and risks

The full decision log is spec section 16.2; the full spec-issue text is `docs/process/spec-issues.md`. This file is the **index with consequences for the build**, plus the risk register. Update the status column in the same change that settles an item.

## 1. Decisions that shape the build

| ID | Decision | Consequence for the build |
| --- | --- | --- |
| D-07 | Only the orchestrator writes to Notion; agents use the outbox | Outbox is a frozen contract; role binding (WP-104) |
| D-08 | One headless run per work unit | Work-unit descriptor, one ledger row per run |
| D-12 | No fixed default stack; architect proposes per project | The v0.2 eval needs one stack chosen by the owner (WP-201) |
| D-16 | Stories auto-accepted on QA pass; humans veto at the milestone review | `PO Acceptance → Done` is automatic; veto path in WP-140 |
| D-21 | Human approves every PR; ARIMA merges; new work pauses at N PRs awaiting you | `arima-merge`, review-queue limit |
| D-29 | GitHub Free assumed: merge approval by hook, production approval in own deploy script | Note: the owner's account accepted branch protection on a private repo (checked live); keep the script-based guard regardless |
| D-34 | Notion via the public API, not MCP (supersedes D-02) | No Notion MCP tools for any role; scripts only |
| D-35 | Solo-first; team features deferred (client portal, guests, multi-person approvers) | Build for one owner holding human roles; keep `team.yaml` generality but do not build portal or guest flows |
| D-36 | Docker sandbox where available; otherwise CLI with advisory layers | Sandbox is a Stage 1 safety package (WP-190) |
| D-37 | Unattended runs use the Docker sandbox with no push credentials; a host script pushes and opens PRs | WP-111, WP-190 |
| D-38 | One merge script is the only merger | WP-112 |
| D-39 | Unreadable kill switch (Notion and state branch) means paused | Built; dispatcher inherits it |
| D-40 | Gate approver identity is a placeholder first | `checkApprover()` single seam (WP-330) |
| D-41 | No unattended runs for now; attended runs first | Gate U before the scheduler (WP-230) |
| D-42 | Hard-stop ids are one canonical list in code | `hardstops.ts` is the registry |
| D-43 | The owner steers by commands, answers critical-blocker questions only, reviews results; agents collaborate without permission and assume-and-log | `09-owner-decisions.md` |
| D-44 | The tech-lead approves ADRs | WP-212, WP-312 |
| D-45 | Baseline frozen on approval | WP-331 |
| D-46 | `/arima:run` covers Phase 4 and operations only | WP-120 |
| D-47 | Local Docker hosting; GitHub, Actions, Git, Docker only | WP-213, WP-218, WP-402, ADR-0007 |
| D-48 | No AI attribution anywhere | WP-113 |
| D-49 | No agent role holds a GitHub credential; the host posts, pushes, merges, tags | WP-111 |

## 2. ADRs

| ADR | Title | Status |
| --- | --- | --- |
| 0001 | Implementation language (TypeScript, Node 22, esbuild bundles, Vitest) | Accepted |
| 0002 | Repo layout (marketplace root, plugin in `plugins/arima/`, templates outside `skills/`) | Accepted |
| 0003 | Notion via public API and scripts, not MCP | Accepted |
| 0004 | Polymorphic item references are ID text, not relations | Proposed (owner accepted S13) |
| 0005 | The guard fails closed inside an ARIMA project | Proposed (needs owner confirmation) |
| 0006 | `runtime.sandbox: docker | none` | Accepted in principle (D-37); design only |
| 0007 | Reference stack and local hosting | Accepted |
| 0008 | The devops role reaches Docker only through `arima-env` | Accepted (owner, 2026-11-20) |

New ADRs this plan will need: ticket-state-machine ownership of `Status` (WP-108), run-packet/agent-report contract (WP-101), merge and publish scripts (WP-111/112), stack and staging host (WP-201), gate approver mechanism if reopened (WP-330).

## 3. Spec issues (status after the owner's answers of 2026-11-18)

| Issue | Topic | Status | Build impact |
| --- | --- | --- | --- |
| S1 | Gate approver identity cannot be read per property | **Deferred**: placeholder (D-40); mechanism proposed; probe gate `G-PROBE` exists in the dev Notion | `checkApprover()` seam (WP-330) |
| S2 | Hard-stop id list | **Accepted** (D-42), built | none |
| S3 | Budget defaults vs measured cost floor | **Accepted** | WP-105: cap = min(per_run_cap, remaining story budget); recalibrate after first milestone |
| S4 | Who may merge | **Accepted**: one merge script | WP-112; spec text of 5.2, 5.6, 10.3, 11.2 still to be reworded |
| S5 | `init` cannot duplicate the template | **Accepted**: init verifies/maps; owner duplicates or runs bootstrap; views creatable | spec 9.3 wording to amend; optional views creation in a later package |
| S6 | Windows vs WSL 2 | **Accepted**: native Windows for attended use; Docker or WSL 2 for unattended | WP-190 |
| S7, S8 | Stale wording | S7 **done**; S8 partly (counts) | docs |
| S9 | ID-in-commit rule collisions | **Accepted** | WP-113 |
| S10 | Phase 3 exit needs a deploy script | **Accepted**: stub deploy script in v0.2, refuses production | WP-213, WP-402 |
| S11 | `stacks/` vs D-12 | **Resolved**: ADR-0007 reference stack and local Docker | WP-201 (done) |
| S12 | Public Portfolio page vs client confidentiality | **Accepted**: off by default | no portal in Stage 1-3 (D-35) |
| S13 | Polymorphic items | **Accepted** (ADR-0004) | none |
| S14 | Solo-lite charter | **Accepted**: brief and budget plan still written | profile checks |
| S15 | Seat terms for unattended use | **Open**: no unattended runs for now (D-41) | Gate U |
| S16 | Agents never hold push credentials | **Accepted** (D-37) | WP-111 |
| S17 | QA role has `npx playwright` | **Resolved**: no role has npx; Playwright is a pinned dev dependency run via `npm run e2e` | WP-211 |
| S18 | Dispatch when the kill switch cannot be read | **Accepted**, built (D-39) | none |

## 3b. Design questions found by the concept review: all resolved on 2026-11-19 (see `09-owner-decisions.md`; table kept for the reasoning)

| Question | Needed by | Proposal |
| --- | --- | --- |
| Who approves an ADR and flips its status, when the spec makes the tech-lead the approver but the tech-lead cannot write and the architect may only write `Proposed`? | WP-312 | The engine flips status to `Accepted` when the tech-lead verdict is `approve` and the PO has not vetoed; recorded as a decision |
| Baseline freeze timing: spec 6.1 step 8 freezes before opening G1, 7.4 and 3.3 freeze on approval | WP-331 | Freeze on approval; a pre-G1 snapshot is kept as the evidence pack input |
| Does `/arima:run` cover phases 1 to 8, or are discover, design and setup separate playbooks? | WP-320, WP-215 | Separate playbook commands for phases 0 to 3 and Phase 5, `/arima:run` for Phase 4 and operations; `run` refuses to start Phase 4 before the Phase 3 exit |
| Open decisions listed inside the agent cards (architect Q-A1 to Q-A7, ba section 12) | the agent's package | Each card's open decisions are answered by the owner or by an ADR **before** step 1 of its build protocol |

## 4. Risk register

| ID | Risk | Likelihood / impact | Trigger to watch | Mitigation | Owner |
| --- | --- | --- | --- | --- | --- |
| R-01 | Role agents bypass the local guards by running project scripts (developer, QA) | High / High | Any guard bypass in a judge review | No push credentials (WP-111), branch protection, Docker sandbox (WP-190); until then guides say advisory | Safety track |
| R-02 | Agent output is plausible but wrong (hallucinated evidence, false "met") | High / High | Eval grader failure; reviewer finding | Evidence rule + validators; separate reviewer/QA; verifier agent; evals with adversarial fixtures | Each agent card |
| R-03 | Prompt injection through Notion/issue/web text | Medium / High | Planted-instruction fixture fails | `untrusted` blocks, data-only rule, no write tools on the web path, outbox validation | Packet builder (WP-102) |
| R-04 | Cost per run exceeds estimates; seat limits hit with several parallel developers | High / Medium | Ledger vs budget; `paused` results | Cost floor known ($0.15-0.25), story budgets recalibrated, parallelism 1 at first, hermetic runs (WP-191) | WP-105, WP-191 |
| R-05 | Notion API behaviour differs from the fake | Medium / Medium | Live tier or shape-drift test fails | Live tier before each Notion change; scrubbed fixtures | WP-010 pattern |
| R-06 | Unattended use of a seat is not permitted or billed differently | Medium / High | Terms review | Attended-first (D-41); API key option; Gate U | Owner |
| R-07 | Scope creep: nine agents and eighteen commands is more than any single Anthropic plugin | High / Medium | Plugin size, review time | Vertical slices, small files, structure tests, defer team features (D-35) | Stages |
| R-08 | Spec gaps and contradictions found late | Medium / Medium | Judge findings | ADR-first rule; `build-docs.test.ts` drift checks | Docs track |
| R-09 | Windows-specific failures (paths, process trees, line endings) | Medium / Medium | CI Windows job red; local failure | Windows CI matrix; real tests for tree kill and worktrees | WP-110 |
| R-10 | A session loses context and repeats or contradicts earlier work | High / Medium | Divergence between `STATE.md` and git | This doc set, `STATE.md` protocol, `work-packages.yaml` check | Handoff |
| R-11 | Mock-only verification mistaken for real verification | Medium / High | A package marked done with no real check | Honesty rule in `05-verification.md`; live tier; judge | Verification |
| R-12 | Secrets or the owner's workspace names leaking into the public repo | Low / High | Scrubber test, secret scan | Scrubbed fixtures test, secret scanner, never record workspace names | Handoff rules |
