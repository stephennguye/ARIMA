# 02 Stages: from scaffolding to deep features

This is the build order. It treats ARIMA as software: first the **scaffolding** (contracts, deterministic engine, safety envelope, evaluation harness) is built and proven with **stub agents**, so the architecture is exercised end to end before any real model judgment is added; then each **agent and feature is built in depth** through one fixed procedure (`04-agent-build-protocol.md`), in the order the process needs them. The task-level register is `work-packages.yaml`; this file explains the order, the conditions and the exit criteria.

## 1. Why this order

1. **Contracts before code that crosses them.** Every later stage plugs into the run packet, the agent report, the outbox, the state machine and the event log. Freezing them first (Stage 1) is what makes later agents independently buildable by separate sessions.
2. **Engine before agents.** Everything computable (state transitions, queue order, budget checks, merging, digest, cost, gate checks) is deterministic code with exhaustive tests. A stub agent that writes known outputs lets the whole daily run be proven with no model cost and no flakiness.
3. **Safety before autonomy.** The safety envelope is done in Stage 0; its remaining gap (sandbox, push credentials) is closed before any unattended run (Gate U).
4. **Depth by vertical slice, in dependency order.** Developer, QA and tech-lead come first because Phase 4 (the build loop) is the product's core and the only phase whose outputs are mechanically checkable (tests, CI, merge). Discovery and design agents come next because they need the question protocol, meetings and gates. Release and operations come last because they need everything.
5. **Every stage ends with something a human can run and a judge can attack**, not with a list of files.

## 2. Stage map

```
Stage 0 Foundations (done)
   │
   ▼
Stage 1 Platform kit ─────────────────────────────┐   (engine + contracts + stub-agent harness)
   │                                               │
   ▼                                               │
Stage 2 Build loop (v0.2) ── developer, qa, tech-lead, devops-lite
   │            └── Gate U (unattended readiness) ── scheduler
   ▼
Stage 3 Discovery and design (v0.3) ── question protocol, meetings, gates, ba, ux, architect, security
   ▼
Stage 4 Release and operations (v0.4) ── phases 5-8, incidents, CRs, recurring jobs, remaining hard stops
   ▼
Stage 5 Stable (v1.0) ── showcase project, eval in CI, migrations, install check, naming
```

Cross-cutting tracks run alongside: **Safety** (sandbox, branch protection, credential separation), **Evaluation** (harness, fixtures, judge), **Docs** (guides, README, changelog), **Owner decisions** (`06-decisions-risks.md`).

## 3. Stage 0: Foundations (v0.1.x) `[BUILT]`

**Goal:** a trustworthy base. **State:** done except WP-012 (close-out).

Delivered: repo, TypeScript tooling, bundled scripts, CI on Windows and Linux with pinned actions and strict plugin validation; config schemas, validator, three profiles; IDs, event log, run ledger, run ids; the headless run wrapper (caps, env allow-list, process-tree kill); preflight, kill switch (Notion + `PAUSE` + remote state branch, fails closed), run lock; the safety envelope (role tool lists, guard hook with fail-closed launcher, secret scanner with allow-list, public/unknown-remote refusal, Status-write refusal, dispatch re-check); the `arima-state` branch; the Notion layer (19-database template, bootstrap, map, mirror, outbox with human-only refusal and value-based conflicts, read retry); `init`, `status`, `pause` and the orchestrator agent (v0); the 58-artifact catalog with draft templates, validator and profile checks; the live test tier with scrubbed fixtures; four independent judge reviews.

**Close-out (WP-012):** the owner approves or edits the 28 draft section lists; tag v0.1.1 after the owner confirms.

## 4. Stage 1: Platform kit

**Goal:** the engine and its contracts, proven end to end with stub agents. No real agent exists yet.

**Entry:** Stage 0 done; contracts of `03-contracts.md` reviewed.

| Order | Work packages | What is built |
| --- | --- | --- |
| 1 | WP-101 | Contracts v1: schemas for agent report, run packet, question, finding, decision; event additions; exit-code registry test |
| 2 (parallel) | WP-102, WP-103, WP-104 | Packet builder; report collector inside the run wrapper (validate, store, map failures, retry-once); outbox role binding and id allocation |
| 2 (parallel) | WP-105, WP-106, WP-107 | Story budget and run-cap rule; item model and DoR check; the ticket state machine (pure) |
| 3 | WP-108, WP-109, WP-140 | Engine-owned `Status` writes; plan-the-day queue; applying human inputs from the mirror |
| 3 (parallel) | WP-110, WP-111, WP-112, WP-113 | Worktree manager; host publish script (push + PR); merge script; PR template and ID-in-commit hook |
| 4 | WP-120, WP-121 | Dispatcher and `/arima:run --dry-run`; stub agents |
| 5 (parallel) | WP-130, WP-131, WP-150, WP-160, WP-191, WP-195 | Digest; cost roll-up; eval harness; interactive-lock rule; hermetic-run decision; migration test |
| any time | WP-190 | Docker sandbox runtime (needed for Gate U, not for Stage 2 exit) |

**Conditions that govern the stage**

- IF a package changes a frozen contract THEN write the ADR first (`01-architecture.md` section 6).
- IF a package introduces a script THEN its exit codes are added to the registry in the same change.
- IF a package writes to Notion THEN it goes through the outbox, and `Status` only through the engine (WP-108).
- IF a package touches git operations THEN it is tested on real temporary repositories, on Windows and Linux CI.
- Stub agents are the only "agents" in Stage 1; no `claude -p` call beyond one smoke run per package that needs it.

**Exit criteria (all must hold)**

1. On a throwaway repo and the dev Notion workspace, `arima-dispatch --dry-run` and a stub-agent run take five hand-written stories **Backlog → Done**, producing correct events, one ledger row per unit, a digest, per-story cost, Notion `Status` changes written only by the engine, and a merge only by `arima-merge`.
2. The state machine is exhaustively tested from the spec table (every legal edge passes, every other pair is refused, attempt counting and the third-failure Blocked rule), and a mutation of the table breaks a test.
3. Every hard stop that is enforceable in Stage 1 has a test that tries to break it (kill switch, budget, story budget, Notion delete, secrets, merge/push to default branch, Status write).
4. The five repo checks, strict plugin validation and the eval suite pass; the live tier passes against the dev workspace.
5. Judge checkpoint **J1** (end of Stage 1) report saved, every finding answered.

## 5. Stage 2: Build loop (v0.2)

**Goal (spec 15.3):** five stories go from Ready to staging, attended, each with a digest entry and a cost per story. The only humans involved approve pull requests.

**Entry:** Stage 1 exit; owner decision S11 recorded (WP-201: one stack and one staging host for the sample project).

| Order | Work packages | Notes |
| --- | --- | --- |
| 1 | WP-201 | Owner decision recorded as an ADR |
| 2 | WP-210 developer | Card → fixtures → stub → agent file → smoke → evals (`04-agent-build-protocol.md`) |
| 3 | WP-211 qa, WP-212 tech-lead | QA writes test cases first, then tests the PR; tech-lead reviews; merge only through `arima-merge` |
| 3 | WP-213 devops-lite | Staging deploys only; the stub deploy script **refuses production under every condition** (S10) |
| 4 | WP-214 `/arima:setup`, WP-216 `/arima:plan` | Walking skeleton on staging; milestone of 8-12 points |
| 5 | WP-215 `/arima:run` (real) | Dispatcher wired to real roles; retry-once, flaky-CI rerun, three-strikes Blocked, review-queue limit |
| 6 | WP-220 | v0.2 eval |

**Conditions**

- IF a story is not Ready (DoR) THEN the dispatcher never assigns it.
- IF the review queue holds `review.max_prs_awaiting_human` PRs THEN no new story starts.
- IF a run fails twice THEN the item is Blocked and a question is raised (never a third silent retry).
- IF a story budget is exhausted THEN it is Blocked with cost-so-far and options (hard stop `story_budget`).
- Stories in this stage are hand-written to the DoR; there is no BA agent yet (known, intentional gap).

**Exit:** WP-220 passes with real agents on the throwaway repo (attended, `/arima:run` started by the human); the digest and cost per story are correct; judge checkpoint **J2** saved and answered.

### Gate U: unattended readiness (owner decision point after Stage 2 exit)

Unattended or scheduled runs are **not allowed** (D-41) until all of: the Docker sandbox runtime built and verified (WP-190); seat terms and billing resolved or an API key chosen (S15); branch protection on the default branch and no agent holds push credentials (WP-111, S16); two weeks of attended runs with no hard-stop failure and no guard bypass found; the owner says go. Then WP-230 (scheduler) is built.

## 6. Stage 3: Discovery and design (v0.3)

**Goal (spec 15.3):** a brief reaches G2 with every artifact its profile requires, and nobody edits agent output except to answer questions.

**Entry:** Stage 2 exit.

| Order | Work packages | Notes |
| --- | --- | --- |
| 1 | WP-301 question protocol and human tasks, WP-302 meeting engine | Needed by every agent below |
| 2 | WP-330 gate protocol and `gate-check`, WP-331 baseline freeze | Gate approver check is the placeholder behind `checkApprover()`; the owner may reopen S1 (D-40) |
| 3 | WP-310 ba, WP-312 architect | Requirements and design; artifacts validated against templates |
| 3 | WP-311 ux, WP-313 security | Prototype only for ux; security uses a verifier agent that tries to disprove each critical finding |
| 4 | WP-320 phase playbooks, WP-340 RTM | `/arima:discover`, `/arima:design`: cost-and-plan prompt before fan-out, one-unit pilot, sequential fallback |
| 5 | WP-350 | v0.3 eval |

**Conditions**

- IF the profile is solo-lite THEN only G1 and G3 are enforced and the charter is not a gate artifact, but the brief and budget plan are still written (S14).
- IF personal data is flagged THEN the DPIA is required (always in regulated); signed by a human legal role.
- IF an agent cannot decide THEN it raises a question (batched, max 10 per digest); it never invents a requirement.
- IF a requirement changes after G1 THEN it goes through a change request (WP-403 for the full flow; before then, the baseline-freeze check refuses silent edits).

**Exit:** WP-350 passes; judge checkpoint **J3** saved and answered.

## 7. Stage 4: Release and operations (v0.4)

**Goal:** a release, a simulated incident and a change request complete on the eval project.

Packages: WP-401 Phase 5 (RC tag, regression, performance, accessibility, dynamic scan, UAT scripts, go/no-go, G3); WP-402 Release (`/arima:release`, production deploy script that proceeds only on the human's approval on the release page; production-data-migration flag; S10 real path); WP-403 Hypercare, G4, incidents, change requests, recurring jobs, retro and lessons; WP-404 the remaining hard stops (new paid service, licence, critical finding); WP-405 optional OpenTelemetry and the Q-21 decision; WP-410 v0.4 eval.

**Conditions:** IF the deploy target is production THEN the deploy script requires the human approval on the release page and refuses otherwise, with no flag to override; IF a critical security finding is open without a human-accepted risk record THEN merge and release are blocked; IF a P1/P2 incident is open THEN it outranks every other work item in the plan of the day.

**Exit:** WP-410 passes; judge checkpoint **J4**.

## 8. Stage 5: Stable (v1.0)

WP-501 showcase project built end to end by ARIMA and published; WP-502 full eval suite in CI; WP-503 migrations for config, Notion template and ledger versions; WP-504 install from the marketplace in under 30 minutes by someone who has not seen it; WP-505 final names, semver, complete docs, security review of the shipped payload, policy-style README read-through. **Exit:** all of spec 15.3 item 5; judge checkpoint **J5**; owner approves the tag.

## 9. Per-stage routine (every stage, every package)

1. `STATE.md` read; `work-packages.yaml` ready packages chosen.
2. Card read (`agents/` or `features/`); acceptance criteria and test plan restated.
3. Tests first; build; the five checks; real check on the dev project if Notion, GitHub or a live session is touched.
4. Package marked `done` only when `05-verification.md` definition of done holds; `STATE.md` updated.
5. At the stage end: judge (read-only, independent, given paths and questions, not conclusions), saved review, every finding answered; docs and changelog updated; owner decision points raised in one batch.

## 10. What "deep" means for an agent or feature

A package is not done when a file exists. It is done when the card's inputs, input handling, outputs, conditions, failure handling and evals are all implemented and **each is exercised by a test or eval that can fail**. `04-agent-build-protocol.md` defines the eight steps and the cards in `agents/` and `features/` hold the per-component specifics.
