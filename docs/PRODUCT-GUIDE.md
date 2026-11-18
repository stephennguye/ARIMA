# What ARIMA will be

This guide describes the finished product in plain language: what it does, who does what, and what goes in and out at every step. It is built from the master specification (`docs/spec/ARIMA-Master-Spec.md`) and from what we have already built. If this guide and the spec disagree, the spec wins until an ADR says otherwise.

Each feature is marked:

- **Built** - exists today in v0.1 and passes its tests. Everything involving Notion has only been tested against a simulated Notion, not a real one yet.
- **Planned (v0.2 / v0.3 / v0.4 / v1.0)** - the increment that delivers it.

For the order we build things in, see `docs/BUILD-GUIDE.md`.

---

## 1. The idea in one page

ARIMA is a Claude Code plugin that runs a whole software project, from a one-page brief to a live product, the way a careful consulting team would: in phases, with sign-offs, and with a written record of everything.

- **Agents do the work.** Nine kinds of agent (analyst, designer, architect, developers, testers and so on) each have one job, a short list of things they may touch, and a list of things they must never do.
- **People make the decisions.** A human approves every gate, every pull request and every production deploy. People also own money, legal and judgment calls.
- **It runs by itself every day.** Once a day an orchestrator wakes up, looks at the project, hands out work, collects results, and writes a short report. It stops and waits for a person only at defined "hard stops".
- **Everything is written down.** Agents remember nothing between runs. If it is not in Notion, in the repository, or in ARIMA's own logs, it does not exist for the next agent.
- **Every run is costed and timed**, so you can see what each story, role and phase cost.

It is for building **new web apps**. Mobile apps, existing codebases, several projects at once, other project-management tools and a custom web UI are out of scope for version 1.0.

### A normal day, from your side

About 15 minutes:

1. Read the **daily digest** in Notion (what shipped, what is waiting for you, what it cost).
2. Approve or comment on the pull requests, gates and questions in the **Approval inbox**.
3. Occasionally run a command in Claude Code (`/arima:status`, `/arima:pause`).

---

## 2. Where things live

| Place | What is kept there | Who writes |
| --- | --- | --- |
| **Notion** (19 linked databases under one root page) | The project-management side: requirements, stories, test cases, bugs, gates, decisions, questions, meetings, digests, releases, incidents, risks, lessons, cost log | Only the orchestrator, from proposals that other agents leave in a folder (the "outbox") |
| **GitHub** (the app's repository) | The engineering side: code, tests, architecture docs, API spec, design files, CI, releases | Developer, QA, architect and others, each in their own area |
| **`.arima/`** in the app repo, saved on a special branch called `arima-state` | ARIMA's own state: a read-only copy of Notion, the outbox, the event log, the run ledger, locks, run reports | ARIMA's scripts |
| **`arima.yaml` and `team.yaml`** in the app repo | Settings: profile, budgets, schedule, who fills which role | You |
| **Your computer's environment** | Secrets such as the Notion token. Never copied anywhere else | You |

Three rules keep this tidy:

- **One master per artifact.** Every document has exactly one home. Anything else is a read-only copy.
- **Agents never edit the Notion copy.** They write a proposal; the orchestrator checks it and applies it.
- **If you edit something in Notion while a run is going, your edit wins.**

---

## 3. The three settings that shape a project

**Profile** decides how much ceremony the project needs.

| | solo-lite | client-project (default) | regulated |
| --- | --- | --- | --- |
| Gates you must pass | G1 and G3 | G0 to G4 | G0 to G4 plus a named compliance sign-off |
| Requirements | Inside the PRD | Separate user and system requirements | Same, formally reviewed |
| Test coverage needed at the release gate | Not checked | Every "Must" requirement has a passing test | Every requirement has a passing test |
| Code review | One reviewer agent | One reviewer agent | Two independent reviewers |
| Penetration test | No | Recommended | Required |
| Privacy assessment (DPIA) | If personal data | If personal data | Always |

**Autonomy mode** (`assisted`, `gated`, `autonomous`) and **question policy** (`block_story` or `assume_and_log`) decide how often ARIMA stops to ask.

**Team** (`team.yaml`) says, for each role, whether it is an agent or a person. You can swap any role between agent and person at any time. Gate approvers must always be people.

---

## 4. The nine agents

Every agent works in short, separate runs. Each run has a budget in dollars, a limit on turns, and a log row. No agent reviews, tests or approves its own work.

Where "Notion" appears under outputs, it always means "proposed in the outbox, applied by the orchestrator".

### Orchestrator (project manager and scrum master) - **Built (minimal)**, full version Planned (v0.2)

- **Job:** run the process. Keep plan, state, budget and people in sync.
- **Inputs:** `arima.yaml`, `team.yaml`, the Notion copy, GitHub status (CI, pull requests), `.arima/` state, the ledger.
- **Outputs:** all Notion records, ID numbers, the milestone plan, the risk register, meeting minutes, gate pages and evidence packs, the daily digest, the cost log, the event log.
- **Tools:** ARIMA's scripts, read-only GitHub commands, files only under `.arima/` and `docs/spec/`.
- **Never:** write product code, approve a gate, merge a pull request, deploy to production, delete anything.
- **Stops and asks when:** any hard stop is hit, the same run fails three times, a budget threshold is crossed, or a human edit conflicts with a pending change.
- **Today:** can start a project (`/arima:init`), report status and pause. The daily run, dispatching and the digest come in v0.2.

### Business analyst (`ba`) - Planned (v0.3)

- **Job:** turn the brief and your answers into precise, testable requirements.
- **Inputs:** the brief, interview answers, reference material you supply, the glossary, the requirements copy.
- **Outputs:** PRD draft (the product owner owns the content), user and system requirements, numbered requirement records, epics, user stories with Given/When/Then acceptance criteria, glossary, links between requirements and stories, change-request impact analyses, questions for people.
- **Never:** change code, set priorities (the product owner does), approve anything.
- **Done when:** every "Must" requirement has a story, every story meets the Definition of Ready, and QA's testability review has no open items.
- **Stops and asks when:** requirements contradict each other, a business rule is missing, or scope grows past the approved baseline (this opens a change request).

### UX designer (`ux`) - Planned (v0.3)

- **Job:** design flows and screens that meet the stories and accessibility standard WCAG 2.2 AA.
- **Inputs:** PRD, stories, brand assets, the stack's design conventions.
- **Outputs:** personas, journeys, sitemap, wireframes, a clickable HTML prototype, design tokens, screen states per story (empty, loading, error, success), accessibility notes, design-QA comments on pull requests. The HTML prototype and tokens are the only design source; there is no external design tool.
- **Never:** change backend or business logic, or invent requirements (it raises a question instead).
- **Stops and asks when:** brand assets are missing or a requirement forces an inaccessible pattern.

### Solution architect (`architect`) - Planned (v0.3)

- **Job:** shape the system so it meets the non-functional requirements inside the chosen stack.
- **Inputs:** PRD, system requirements, non-functional requirements, stack documentation, past decisions.
- **Outputs:** system architecture document, decision records (ADRs), OpenAPI spec, data model, infrastructure diagram, hosting cost estimate, measurable performance and reliability targets, reviews of architecture-impacting pull requests.
- **Never:** merge, deploy, or leave the default stack without an approved decision record.
- **Stops and asks when:** a target cannot be met within budget or a stack change is needed. Stacks are proposed per project and approved at gate G2.

### Tech lead (`tech-lead`) - Planned (v0.2)

- **Job:** guard code quality and decide what merges.
- **Inputs:** the pull request diff, the story and its acceptance criteria, conventions, decision records, CI results.
- **Outputs:** pull request reviews (approve or request changes, with findings tagged blocker, major, minor or nit), convention updates, technical-debt entries. When review, CI and QA all pass, the pull request waits for your approval and is then merged automatically (squash).
- **Never:** push commits to the branch under review, or merge without green CI, a QA pass and your approval.
- **Stops and asks when:** the same pull request fails review three times, or a change conflicts with a decision record.

### Developer (several can run at once) - Planned (v0.2)

- **Job:** build exactly one story or bug fix per run, to the Definition of Done.
- **Inputs:** the story, its acceptance criteria, linked requirements, the API spec, relevant decisions, the story's screens, its test cases.
- **Outputs:** code plus unit and integration tests on its own branch in its own working copy, and a pull request that maps each acceptance criterion to code and tests.
- **Never:** touch other working copies or `main`, edit CI or hooks, read or set secrets, merge, add a dependency with a non-approved licence, or add a paid service.
- **Stops and asks when:** the acceptance criteria are ambiguous (the story is blocked with a question) or the API contract needs to change (goes to the architect).

### QA engineer (`qa`) - Planned (v0.2)

- **Job:** prove, independently, that each story meets its acceptance criteria.
- **Inputs:** stories, acceptance criteria, requirements, the test plan, screens, the running test environment. It never reads the developer's notes or transcript.
- **Outputs:** test cases written before development starts, automated end-to-end tests, test results, bug reports, test summaries, regression, performance and accessibility reports.
- **Never:** fix product code, or close its own bug without retesting.
- **Stops and asks when:** the environment is broken or an acceptance criterion cannot be tested as written.

### Security engineer (`security`) - Planned (v0.3)

- **Job:** keep known security risk at an accepted level.
- **Inputs:** architecture, data model, API spec, diffs, dependency lists, scanner output.
- **Outputs:** security requirements, threat model, privacy assessment draft (a person signs it), finding records, a pre-release security report.
- **Never:** modify code (it files bugs instead) or accept a risk on its own findings.
- **Stops and asks when:** a critical finding appears or a secret is found in history.

### DevOps / SRE / first-line support (`devops`) - Planned (v0.2 to v0.4)

- **Job:** run environments, pipelines, releases and operations.
- **Inputs:** architecture, infrastructure config, CI results, monitoring alerts, runbooks.
- **Outputs:** CI/CD setup, infrastructure as code, environment list, staging deploys, release candidates, runbooks, rollback plans, incident records, postmortem drafts, uptime reports, software bill of materials, dependency-update pull requests.
- **Never:** deploy to production without the approval recorded on the release page, or read production credentials (only the approval-gated deploy script can).
- **Stops and asks when:** production is degraded or a deploy fails and a rollback is needed.

### The people

| Role | Default | What they do |
| --- | --- | --- |
| Sponsor | You, or the client's representative | Approves gates; owns budget |
| Product owner | You | Owns the PRD and priorities; approves gates with the sponsor |
| Legal | You | Signs the privacy assessment; compliance sign-off in the regulated profile |

When a normal role (say QA) is set to "person", ARIMA creates a Notion task for that person with the template attached and a due date, reminds them after 24 working hours, and escalates to the sponsor after 48.

---

## 5. The phases

There are nine phases, 0 to 8. Five of them end in a **gate**: a formal approval only a person can give. At each gate ARIMA assembles an **evidence pack** on a Notion page (a checklist of criteria, links to every required artifact, open risks, known issues, and the agents' recommendation). An approver sets the decision to Approved, Approved with conditions, or Rejected. ARIMA accepts the decision only if the person who set it is listed as an approver for that gate.

### Phase 0 - Initiation (1 to 3 days) - **Built (partly)**; rest Planned (v0.3)

- **Goal:** decide whether to start, with an agreed scope and budget.
- **Inputs:** your brief (problem, users, goals, must-haves, out of scope, constraints, risks), settings, team.
- **Steps:** the orchestrator checks the brief and asks for gaps; creates the Notion workspace; the analyst drafts a vision and scope, the architect writes a feasibility note, and security screens the data (personal data, payments, children, health) in parallel; the orchestrator writes the charter, budget plan and risk register; then it opens G0.
- **Outputs:** project brief, charter, budget plan, feasibility note, compliance screen, risk register, G0 page.
- **Gate G0 (sponsor):** brief complete, charter, feasibility note, compliance screen, budget plan.
- **Built today:** brief check, config check, workspace mapping, brief and charter skeleton and budget plan written to Notion, all gate pages created. Feasibility note and compliance screen wait for the architect and security agents.

### Phase 1 - Discovery and requirements (1 to 3 weeks) - Planned (v0.3)

- **Goal:** an approved, testable set of requirements.
- **Inputs:** charter, brief, your answers, reference material, brand assets.
- **Steps:** the analyst asks you questions in batches of at most ten; UX drafts personas, journeys, sitemap and wireframes; the analyst writes the PRD and requirements; the architect sets measurable non-functional targets; security writes security requirements; the analyst breaks it into epics and stories; a requirements review meeting runs; QA closes the testability review; the orchestrator freezes a baseline into `docs/spec/baseline-G1/`.
- **Outputs:** PRD, user and system requirements, non-functional requirements, glossary, UX discovery set, security requirements, privacy assessment draft, backlog, review log.
- **Gate G1 (sponsor and product owner):** every "Must" requirement has a story; first-milestone stories are ready; no open blocking questions; all non-functional targets measurable; privacy assessment signed if required.

### Phase 2 - Design (1 to 2 weeks) - Planned (v0.3)

- **Goal:** an approved design that meets every non-functional target in the chosen stack.
- **Inputs:** the G1 baseline, targets, wireframes.
- **Steps:** the architect produces architecture, decisions, API spec, data model and a cost estimate; in parallel UX builds a clickable prototype and tokens, security writes a threat model, QA writes the master test plan, DevOps plans environments and pipelines; the orchestrator builds the milestone plan; a design review meeting; open G2.
- **Outputs:** architecture document, decision records, API spec, data model, infrastructure diagram, prototype, design tokens, threat model, master test plan, environment list, pipeline design, milestone plan, Definition of Ready and Done.
- **Gate G2 (product owner and sponsor; the client approves the UI):** every target has a design response and a way to verify it; API spec covers the first milestone; no unmitigated high threat; prototype covers every first-milestone screen; any stack change has an approved decision record.

### Phase 3 - Setup (2 to 5 days) - Planned (v0.2)

- **Goal:** a working delivery pipeline before the first feature.
- **Inputs:** architecture, environment plan, accounts and credentials from people (missing ones raise a blocking question).
- **Steps:** DevOps creates the repo from the stack template, CI, staging infrastructure and monitoring; in parallel the tech lead writes conventions and the pull request template, QA sets up the end-to-end test framework, security adds scanning to CI; a developer builds a thin "walking skeleton" through UI, API and database, deployed to staging.
- **Outputs:** pipeline, staging, conventions, test skeleton, security checks, skeleton on staging.
- **Exit (a checklist, no gate):** skeleton green on staging; every CI stage runs; the merge guard and the approval-gated deploy script are active.

### Phase 4 - Build (one or more milestones) - Planned (v0.2)

- **Goal:** deliver the planned scope to staging, story by story.
- **Inputs:** ready stories, milestone plan, budgets.
- **Daily loop:** pick ready stories within budget and the number of parallel developers; QA writes test cases first; a developer builds and opens a pull request; the tech lead reviews; QA tests on a preview; UX checks the design; once review, CI and QA pass and you approve, the pull request merges and DevOps deploys to staging; the story is auto-accepted, and you can veto it at the milestone review.
- **Outputs:** test cases, code and tests, pull requests, bug reports, milestone review page, retro lessons.
- **Exit (per milestone, no gate):** all milestone stories done or explicitly moved; milestone review held; lessons recorded.
- **Ticket states:** Backlog, Ready, In Progress, In Review, In QA, PO Acceptance, Done, Released, plus Blocked and Cancelled. The third failed review or QA attempt on one story moves it to Blocked and raises a question.

### Phase 5 - Stabilization, testing and acceptance (1 to 2 weeks) - Planned (v0.4)

- **Goal:** prove the release candidate is fit for production.
- **Steps:** code freeze and release candidate tag; in parallel full regression and cross-browser testing, load tests, a dynamic security scan, an accessibility audit; an optional penetration test by a person; user-acceptance scripts generated from the acceptance criteria, which people run on staging; daily bug triage; a go/no-go meeting where each agent gives a verdict with evidence; open G3.
- **Outputs:** test summary, performance report, security report, accessibility report, pen-test report, acceptance results, known-issues list, go/no-go minutes.
- **Gate G3 (sponsor, with product owner):** no open severity 1 or 2 bugs; each open severity 3 bug has an accepted workaround; test-coverage rule met; performance targets met; no unaccepted critical or high security finding; acceptance signed; runbook and rollback plan ready.

### Phase 6 - Release (1 to 3 days) - Planned (v0.4)

- **Goal:** ship safely.
- **Steps:** DevOps drafts the release plan and notes; **a person approves the production deploy on the release page** (a hard stop); a protected deploy job rolls out gradually and runs a smoke test; user guide, FAQ and support pack are published.
- **Outputs:** release record and notes, deploy log, user guide, FAQ, support knowledge base, escalation matrix.
- **Exit (checklist):** production smoke test passed; release record complete; no rollback in the first 24 hours.

### Phase 7 - Hypercare and handover (2 weeks by default) - Planned (v0.4)

- **Goal:** stabilize in production and close the build project.
- **Steps:** tighter alerts and daily incident triage; hotfixes through the hotfix flow; final operations manual and runbooks; hypercare and closure reports; open G4.
- **Gate G4 (sponsor):** no open priority 1 or 2 incidents; availability at or above target (default 99.5%) for 7 consecutive days; operations docs complete; closure report accepted.

### Phase 8 - Operations and maintenance (ongoing) - Planned (v0.4)

- **Goal:** keep the product healthy and evolving.
- **Work arrives as:** incidents, change requests, recurring jobs (weekly dependency and security updates, monthly cost and uptime reports, quarterly backup-restore tests, yearly disaster-recovery drill) and new milestones. New features re-enter at phase 1 as a small discovery.
- **Exit:** a retirement decision by the sponsor; ARIMA archives the workspace and repo.

---

## 6. The daily run (the heartbeat) - Planned (v0.2)

Started by the scheduler (or you, with `/arima:run`). Ten steps:

1. **Preflight** - kill switch off, config valid, no other run active, budget left, credentials present. (**Built.**)
2. **Sync in** - copy Notion into the read-only mirror (**Built**); pull CI, pull request and alert status.
3. **Apply your inputs** - approvals advance gates, answers unblock stories, vetoes create undo tasks, priority changes reorder the queue.
4. **Plan the day**, in this order: serious incidents, a broken main or staging, rework on work in flight, QA of finished pull requests, test cases for newly ready stories, new stories, recurring jobs, documentation and tech-debt.
5. **Dispatch runs** - one headless run per piece of work, each with a role, item ID, dollar budget, turn limit and working copy; every result goes in the ledger. (**Built**: the wrapper that does one run.)
6. **Hold due meetings.**
7. **Check gates** - if exit criteria are met, build the evidence pack and open the gate.
8. **Handle hard stops** - record them, pause dependent work, continue independent work.
9. **Sync out** - apply the outbox to Notion. (**Built.**)
10. **Close** - write the digest, close ledger rows, save state to the `arima-state` branch (**Built**), release the lock (**Built**).

### The daily digest

One Notion page per day, ready by 07:00 by default: a one-line headline with health (green, amber, red); what is awaiting you; what shipped; decisions made (each with a veto box); blockers and risks; cost and time; tomorrow's plan; run health. Each list is capped at ten items, highest impact first.

---

## 7. Safety: the hard stops

ARIMA stops and waits for a person at these points, and enforces them in code, not only in instructions.

| Hard stop | How it is enforced | Status |
| --- | --- | --- |
| Gates G0 to G4 | Only listed approvers' decisions count; agents cannot write approver or decision fields | Partly built |
| Production deploy | A deploy script that waits for your approval on the release page | Planned (v0.4) |
| Secrets change | A hook blocks reading or editing secret files and printing secret variables; secrets are also scanned for before anything is written to Notion, logs or the state branch. Pattern-based, not a sandbox | Built (verified live) |
| Daily or project budget reached | Checked by the daily preflight and again before every dispatch | Built |
| Story budget reached | Checked before each dispatch | Planned (v0.2) |
| Deleting anything in Notion | No delete operation exists in ARIMA's code | Built |
| Production data migration | Flagged in pull requests; needs release-page approval | Planned (v0.4) |
| New paid service or account | Dependency and infrastructure review raises a question | Planned (v0.2) |
| Dependency with a non-approved licence | CI check blocks the pull request | Planned (v0.2) |
| Critical security finding | Blocks merge and release | Planned (v0.3) |
| Kill switch | A "Pause ARIMA" to-do in Notion and a `PAUSE` file (also read from the remote state branch if Notion is down); either one stops every run, a missing Notion switch counts as paused, and agents cannot clear it | Built |

Other protections: the Notion token is given only to the orchestrator; agents get a tool allow-list per role; text from Notion, web pages and issues is treated as data, never as instructions; test data is always made up; nothing that looks like a secret is written to a log.

---

## 8. Cost and time tracking

Every run writes one ledger row: project, phase, milestone, item, role, model tier, attempt, whether it was rework, cost, tokens, duration, outcome. Budgets are set per run, per story (by size S, M, L), per day and per project, with alerts at 50%, 80% and 100%. If you use a Claude subscription seat, the dollar amounts are estimates of consumption, not money spent; when the seat's usage limit is reached a run pauses and the next scheduled run resumes.

**Built:** ledger, run wrapper with per-run caps, preflight budget checks and alerts. **Planned:** per-story budgets and cost per story (v0.2), `/arima:cost` and the Notion cost log, delivery metrics (lead time, cycle time, rework share), optional OpenTelemetry (v0.4).

---

## 9. Commands

| Command | What it does | Status |
| --- | --- | --- |
| `/arima:init` | Check the brief, validate config, set up Notion, run phase 0 | **Built** (to the point G0 can be opened) |
| `/arima:status` | Phase, gates, open questions, board, budget | **Built** |
| `/arima:pause [--resume]` | Set or clear the kill switch | **Built** |
| `/arima:run [--dry-run] [--only <item>]` | The daily run | Planned (v0.2) |
| `/arima:plan [MS-NN]` | Build or revise a milestone plan | Planned (v0.2) |
| `/arima:digest [--date]` | Rebuild the daily digest | Planned (v0.2) |
| `/arima:setup` | Run phase 3 to the walking skeleton | Planned (v0.2) |
| `/arima:discover` | Run phase 1 to G1 | Planned (v0.3) |
| `/arima:design` | Run phase 2 to G2 | Planned (v0.3) |
| `/arima:meeting <type>` | Run a meeting by the protocol | Planned (v0.3) |
| `/arima:gate <G0-G4>` | Check criteria, build the evidence pack, open the gate | Planned (v0.3) |
| `/arima:release <version>` | Prepare a release; wait for your approval | Planned (v0.4) |
| `/arima:hypercare [--days N]` | Start hypercare; build the G4 pack at the end | Planned (v0.4) |
| `/arima:incident <description>` | Open an incident, triage, hotfix, postmortem | Planned (v0.4) |
| `/arima:cr <description>` | Open a change request with impact analysis | Planned (v0.4) |
| `/arima:retro [MS-NN]` | Run a retro and propose lessons | Planned (v0.4) |
| `/arima:cost [--by role/phase/item]` | Cost and time breakdown | Planned (v0.2) |
| `/arima:assign <role> <agent or person>` | Switch a role between agent and person | Planned (v0.3) |

The scheduler only ever calls `/arima:run`.

---

## 10. Other features

- **Meetings** (planned v0.3): the orchestrator sends every participant the same pack; each writes an independent assessment first, then responds only to disagreements (at most two rounds); the orchestrator writes minutes with decisions, open issues and owned action items; unresolved disagreements become questions for you. Meetings: requirements review, design review, milestone review, go/no-go, postmortem, retro, and a generated standup.
- **Questions** (planned v0.3): each has an asking role, linked item, options with a recommendation, whether it blocks, a default, an expiry. Blocking questions move the story to Blocked. Under `assume_and_log` a non-blocking question is answered with the agent's recommendation and logged as a decision you can veto. Hard-stop matters are never assumed.
- **Change requests** (planned v0.4): analyst writes impact (requirements, stories, tests, cost, schedule, risk); the product owner approves if budget and deadline are unchanged, otherwise the sponsor; the baseline version increases.
- **Incidents and hotfixes** (planned v0.4): priority P1 to P4; hotfix branch; fast-track review; production deploy still needs approval; blameless postmortem within five working days.
- **Retros and lessons** (planned v0.4): lessons become project overrides; broadly useful ones are proposed back to ARIMA.
- **Live traceability** (planned v0.3): requirement to story to test case to bug to release, generated from Notion relations, never maintained by hand.
- **Client portal** (planned v0.3): a Notion page for client guests showing only what they need (gate pages, approved documents, milestone reviews, acceptance runs, release notes).
- **Evals** (**Built** for v0.1): a sample project with expected outcomes that must pass before any release.

---

## 11. Appendix: all 58 deliverables

"Where" is the single master location. Notion items are rows in the Notion workspace; repo items are files in the app repository.

**Phase 0:** project brief (product owner; Notion page) - charter (orchestrator; Notion page) - budget plan (orchestrator; Notion page) - feasibility note (architect; Notion) - compliance screen (security; Notion) - contract or statement of work (a person; outside ARIMA, linked) - risk register (orchestrator; Notion risks).

**Phase 1:** PRD (analyst; Notion) - user requirements with requirement items (analyst; Notion) - system requirements (analyst; Notion) - non-functional requirements (architect; Notion requirements) - glossary (analyst; Notion page) - personas, journeys and sitemap (UX; Notion) - wireframes (UX; `design/wireframes/`) - security requirements (security; Notion) - privacy assessment (security drafts, legal signs; Notion) - epics, stories and acceptance criteria (analyst; Notion stories) - requirement review log (QA; Notion meetings).

**Phase 2:** system architecture document (architect; `docs/architecture/sad.md`) - decision records (architect; `docs/architecture/adr/`) - API spec (architect; `api/openapi.yaml`) - data model (architect; `docs/architecture/data-model.md` and migrations) - infrastructure diagram and hosting cost estimate (architect; `docs/architecture/`) - prototype and design tokens (UX; `design/`) - threat model (security; `docs/security/threat-model.md`) - master test plan (QA; Notion) - environment list and pipeline design (DevOps; `docs/ops/`) - milestone plan (orchestrator; Notion milestones) - Definition of Ready and Done (orchestrator; Notion page).

**Phase 3:** engineering conventions (tech lead; `docs/engineering/conventions.md`).

**Phase 4 and ongoing:** test cases (QA; Notion test cases and `tests/e2e/`) - code, unit and integration tests (developer; repo) - pull requests and reviews (developer and tech lead; GitHub) - bug reports (QA and DevOps; Notion bugs) - milestone review (orchestrator; Notion milestones) - daily digest (orchestrator; Notion digests) - decision log (any agent; Notion decisions) - questions (any agent; Notion questions) - meeting minutes (orchestrator; Notion meetings) - lessons (all agents; Notion lessons).

**Phase 5:** test, regression, performance and accessibility reports (QA and DevOps; Notion) - pre-release security report (security; Notion) - penetration test report (an external person; Notion, uploaded) - acceptance scripts and sign-off (orchestrator and people; Notion test runs) - go/no-go minutes (orchestrator; Notion meetings) - runbook and rollback plan (DevOps; `docs/ops/`).

**Phase 6:** release record and notes (DevOps and analyst; Notion releases and the GitHub release) - user guide and FAQ (analyst; Notion, published) - support knowledge base and escalation matrix (DevOps; Notion) - software bill of materials (DevOps; GitHub release asset).

**Phase 7:** hypercare and closure reports (orchestrator; Notion) - operations manual (DevOps; `docs/ops/ops-manual.md`).

**Phase 8:** incident records and postmortems (DevOps; Notion incidents) - change requests and impact analyses (requester and analyst; Notion) - uptime and cost reports (orchestrator; Notion).

**Generated, never hand-written:** the requirements traceability matrix (Notion relations view) - the changelog (`CHANGELOG.md`, from merged pull request titles) - the run ledger and event log (`.arima/` on the state branch).

Which of these have a template today: project brief, PRD, user story, decision record, bug, gate evidence pack, meeting minutes, digest, postmortem and change request. The other 48 have no template yet; deciding their required sections is the first job of the template step in `docs/BUILD-GUIDE.md`.
