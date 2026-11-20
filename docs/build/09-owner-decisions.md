# 09 Owner decisions and working principles (2026-11-19)

These are binding on every card, feature spec and work package. They come from the owner's answers and instructions. Where a card disagrees, the card is wrong. Recorded in the spec decision log as D-43 to D-47.

## 1. How the owner works with ARIMA (the operating principle)

The owner **steers**: triggers commands in Claude Code, answers questions, and reviews results (digest, gates, pull requests, release). The owner does **not** supervise routine agent work.

- **Agents work with each other without asking permission**: hand-offs, reviews, consultations between roles, ADR approval, test and design disputes are resolved inside the team (a consult round, then the tech-lead or orchestrator rules, recorded as a DEC with a veto box).
- **Asking the owner is for critical blockers only.** A critical blocker is one of: a hard stop (spec 11.1, the 16 ids), a missing credential or account, money or a paid service, a legal/privacy matter (DPIA, licence), an irreversible or production action, or two requirements that contradict and that the team cannot reconcile after one consult round. Everything else: the agent decides, writes a DEC (assume-and-log) and carries on; the owner may veto from the digest.
- Default config: `autonomy.question_policy: assume_and_log` for non-hard-stop questions (`block_story` is for projects that want it). Hard-stop matters are never assumed.
- Each agent gets the **tools and write scope its whole job needs**, including the means to talk to the others (outbox proposals, question and decision records, PR comments, reading the artifacts it depends on). Nobody gets: push or merge to the default branch, production deploy, secrets, Notion delete, gate decisions.
- **Decision D-43:** these principles, including the critical-blocker definition above.

## 2. Resolved design decisions

| # | Decision | Detail |
| --- | --- | --- |
| D-44 | **ADRs: the tech-lead owns approval.** The architect drafts an ADR with status `Proposed`; the tech-lead reviews it and sets `Accepted`, `Rejected` or `Superseded` (the tech-lead role gets a scoped write grant on `docs/architecture/adr/**`). Security may comment. The owner sees the result in the digest and at G2, and may veto. | Resolves the ADR-approval gap (concept review) |
| D-45 | **Baseline freeze on approval.** A baseline (`docs/spec/baseline-Gx/`) is frozen when the gate is approved; a pre-gate snapshot is kept as evidence-pack input. | Resolves spec 6.1 step 8 vs 7.4 and 3.3 |
| D-46 | **`/arima:run` covers Phase 4 (build) and operations only.** Phases 0 to 3 and Phase 5 run through their playbook commands (`/arima:init` to G0, `/arima:discover`, `/arima:design`, `/arima:setup`, and the stabilization command). `/arima:run` refuses to start Phase 4 until the Phase 3 exit checklist holds. | Resolves the playbook-split question |
| D-47 | **Hosting is local; DevOps works with GitHub, GitHub Actions, Git and Docker only** (K3s and K8s later). Both web apps and their environments run **on the owner's machine**. | See section 3 |
| D-48 | **No AI attribution anywhere.** No `Co-Authored-By` trailer naming Claude, no "Generated with Claude" or similar line, no AI-contributor credit in any commit, pull request, code comment or document that ARIMA or its builders produce, in this repo or in any app repo. The PR template and the commit hook forbid it. (The owner's repositories are reviewed by employers.) | Overrides any tool default that adds such lines |
| D-49 | **No agent role holds any GitHub credential.** The host reads PRs, CI and review threads into the run packet and posts each role's comments, findings and verdicts (as COMMENT reviews, never approvals) from the validated report; the host also pushes, opens PRs, merges and tags. The team still talks to itself without the owner; no credential exists to misuse. | Consolidates D-37, D-38 and the card decisions (tech-lead, architect, security, devops, developer) |
| D-50 | **WP-213 accepted (2026-11-21).** The owner accepted the devops agent as built, including the reworded acceptance line: no deploy workflow exists, and the files `ci.yml` and `security-weekly.yml` are delivered by WP-219. | Closes the open question after the J-agent:devops judge review |
| D-51 | **Attended first, unattended after Stage 5 (2026-11-21).** The build loop, discovery, design and release features are built and proven attended (the human starts `/arima:run`). Gate U, the scheduler (WP-230), seat terms for unattended use (S15) and the real `claude -p` check inside the Docker sandbox (WP-190) wait until Stage 5 is stable and the attended features have been used to build a real application. No attended work is blocked by them. | Safety before autonomy; D-41 stands |

## 3. Local hosting and DevOps scope (D-47)

- **Environments** are Docker Compose projects on the owner's machine: `preview-<pr>` (per pull request, on a free local port), `staging` (follows `main`), `production` (separate project, separate data volume). No cloud account, no paid service (hard stop `new_paid_service` stays), no cloud CLI.
- **CI is GitHub Actions**: lint, type check, unit and integration tests, build, static analysis, dependency audit, secret scan, licence check, container image build and a smoke test of the image. Actions runners cannot reach the owner's machine, so **deployment is not done from Actions**.
- **Deploys are local scripts run by the host** (the orchestrator's machine): staging is rebuilt from `main` after each merge; the preview is created when a PR reaches In Review. **Production** is deployed only by the approval-gated local deploy script, which proceeds only when the owner's approval is on the Notion release page and has no override flag (D-29, WP-402). The devops agent never holds production credentials and never runs the production script.
- **Hosting cost estimate** in the SAD is "local machine, no hosting cost" plus CI minutes; capacity limits (CPU, RAM, disk, ports) are stated as constraints.
- **Portable by design for K3s/K8s later**: every service is containerized, configuration via environment variables, health and readiness endpoints, no host-path coupling except named volumes, one image per service, compose files kept simple and mappable to manifests.
- **Backups and recovery**: named-volume backup and restore scripts, tested in the restore-test recurring job (spec 7.10).
- **Reference stack for the sample project (resolves WP-201, ADR-0007):** TypeScript end to end, Node 22, React with Vite for the web UI, Fastify for the API, PostgreSQL in Docker, Vitest and Playwright for tests, Docker Compose to run everything. Shipped as `stacks/default-web`. The architect may propose another stack per project (D-12); deviating from the reference stack needs an ADR approved by the tech-lead.

## 4. Commits and pull requests

No attribution lines of any kind (D-48). Commit messages: Conventional Commits with the item id as scope (`feat(US-112): add checkout summary`). PR title `<ID>: <title>`; PR body from the template, which has no generated-by footer. The owner's account approves; the machine account opens PRs (D-30).

## 5. How the cards use this file

Each agent card's former "open decisions" section now lists the **resolved decisions** it made under these principles (decision, reason, the work package or code change that implements it). Only a true critical blocker (section 1) may remain open, and it is marked **OWNER**.
