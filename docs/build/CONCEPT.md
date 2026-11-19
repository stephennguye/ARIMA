# CONCEPT: what ARIMA is, and the spirit every part must serve

Read this before anything else in `docs/build/`. Every other document (architecture, stages, contracts, agent cards) is a *means*; this file is the *end*. If a design choice, a work package or an agent card cannot be explained in the terms below, it is drifting.

## 1. The idea in one paragraph

**ARIMA builds a brand-new web application from a brief by replicating how a good software team in a company works.** A real team does not just write code: it has roles with clear responsibilities, a lifecycle with approval points, a written artifact for every important thought (requirements, designs, test plans, decisions, release notes), regular communications (stand-ups, reviews, status reports, questions to the client, change control, retrospectives) and measurement (cost, time, quality, rework). ARIMA staffs that team with Claude agents, puts the **human in the seat of client, sponsor and product owner** (about 15 minutes a day), and keeps the same discipline: *nothing important lives in someone's head, every artifact has one owner and one reviewer, no one checks their own work, every decision is recorded and can be vetoed, and humans decide at the gates.*

The output of ARIMA is therefore **two things**: the running web application, and the complete, traceable trail of artifacts and decisions a professional team would have left behind. Greenfield web apps only (D-33, D-05).

## 2. What "replicating a company team" means, concretely

| A company team has | ARIMA's version | Where it is specified |
| --- | --- | --- |
| Roles with RACI (PM, BA, UX, architect, tech lead, developers, QA, security, DevOps; client, sponsor, PO, legal) | 9 agents fill 11 roles; sponsor, PO and legal are humans (`team.yaml`); any role can switch between agent and human without changing the process | Spec 5, 4.2 |
| A defined lifecycle with stage gates and a steering committee | Phases 0 to 8; gates G0 to G4 that **only a human can pass**, each with an evidence pack | Spec 6, 7.4 |
| A document for every important thought, with an owner, a reviewer and one master location | 58 artifacts, each with owner, approver, master (Notion or GitHub) and required sections; templates and validators | Spec 8, `catalog/artifacts.yaml` |
| Stand-up | The orchestrator's daily digest (generated from state) | Spec 7.3, 12.1 |
| Sprint and sprint review | Milestones of 8 to 12 points and a milestone review where humans can veto any accepted story | Spec 7.1, 6.4 |
| Backlog refinement and Definition of Ready | BA writes stories with Given/When/Then criteria; a story is Ready only when the DoR holds | Spec 7.1, 8.2 |
| Code review and merge discipline | Developer ≠ tech-lead reviewer ≠ QA; the human approves every PR; one merge script merges | Spec 10.3, D-21, D-38 |
| Independent QA and a test plan | QA writes test cases before development, tests on a preview, never sees the developer's notes; Master Test Plan | Spec 5.8, 6.2 |
| Design, architecture and security reviews | Requirements review and design review meetings; threat model; ADRs | Spec 7.3, 6.1, 6.2 |
| Asking the client questions | Question protocol: batched, with options and a recommendation, blocking or assume-and-log, never assuming hard-stop matters | Spec 7.5 |
| Risk register, decision log, change control | RISK and DEC records; every autonomous decision is shown in the digest with a veto box; change requests with impact analysis after G1 | Spec 7.9, 12.1 |
| Release management and a production approval | Release plan, notes from merged PRs, SBOM; the production deploy waits for the human's approval on the release page | Spec 6.6, 11.1 |
| Incident management, postmortems, hypercare | INC records, hotfix flow, blameless postmortems, two-week hypercare, G4 | Spec 6.7, 7.8 |
| Retrospectives and continuous improvement | Retro per milestone; approved lessons become project overrides of agent instructions | Spec 7.11 |
| Finance and delivery metrics | One ledger row per run (project, phase, milestone, item, role, cost, tokens, time); cost per story, rework share, lead and cycle time, DORA | Spec 13 |
| An audit trail | `events.jsonl` for every state change, "Last written by run" on every Notion write | Spec 3.2, 9.3 |
| A rule that nobody approves their own work | No agent reviews, tests or approves its own output; gates and production need humans | Spec principle 5, 7 |

## 3. The lifecycle as the organization sees it

This is the view that matters: who does what in each phase, what they leave behind, who approves, and what is measured. (The machine that carries it is in `01-architecture.md`.)

| Phase | Purpose | Roles that act | Artifacts produced (catalog ids) | Communications | Approval | Measured |
| --- | --- | --- | --- | --- | --- | --- |
| 0 Initiation | Decide whether to start; agree scope frame and budget | orchestrator, ba, architect, security | project-brief, charter, budget-plan, feasibility-note, compliance-screen, risk-register | Brief completeness questions; G0 evidence pack | **G0** sponsor (not in solo-lite) | Budget plan vs caps |
| 1 Discovery and requirements | An approved, testable requirements baseline | ba, ux, architect, security, qa, orchestrator | prd, urs, srs, nfr, glossary, personas-journeys-sitemap, wireframes, security-requirements, dpia (if personal data), backlog (epics, stories), requirement-review-log | Question batches to the PO (max 10); **requirements review meeting**; baseline frozen | **G1** sponsor + PO | Questions raised/answered, time waiting on humans |
| 2 Design | A design that meets every NFR in the approved stack | architect, ux, security, qa, devops, orchestrator | sad, adrs, openapi, data-model, infra-diagram, prototype, threat-model, master-test-plan, env-matrix, milestone-plan, dor-dod | **Design review meeting**; stack proposal for approval | **G2** PO + sponsor (client approves UI) | Design cost estimate |
| 3 Setup | A working delivery pipeline before the first feature | devops, tech-lead, qa, security, developer | conventions, CI/CD, staging, test skeleton, walking skeleton | Pipeline checklist | Checklist (no gate) | Pipeline duration |
| 4 Build (per milestone) | Deliver release scope to staging, story by story | orchestrator, qa, developer, tech-lead, ux, devops | test-cases, code-tests, pull-requests, bug-reports, milestone-review, digest, decision-log, questions, lessons | **Daily digest** (stand-up); PR reviews; **milestone review** with veto; **retro** | Human PR approval; milestone review | Cost per story, rework share, first-pass QA, lead and cycle time |
| 5 Stabilization and UAT | Prove the release candidate is fit for production | tech-lead, qa, devops, security, humans | test-reports, security-report, pentest-report, uat, go-no-go-minutes | **Go/No-Go meeting** (one verdict per agent with evidence); daily defect triage | **G3** sponsor + PO | Defects by severity, coverage of requirements |
| 6 Release | Ship safely | devops, ba, orchestrator | release-record, user-guide-faq, support-kb, runbook-rollback, sbom, changelog | Release plan; **production approval on the release page** | Human approval (hard stop) | Deploy success, smoke test |
| 7 Hypercare | Stabilize in production; close the build project | devops, developer, orchestrator | hypercare-closure, ops-manual, incidents | Daily incident triage; hotfix flow; postmortems | **G4** sponsor | Availability vs SLO |
| 8 Operations | Keep it healthy and evolving | all, on demand | incidents, change-requests, slo-cost-reports, rtm | Recurring jobs; CR impact analysis | PO or sponsor per CR | DORA, SLO, cost reports |

## 4. How the team communicates (channels, not code)

Every communication a real team has maps to exactly one channel, and every channel leaves a record.

| Need | Channel | Record |
| --- | --- | --- |
| Agent needs a decision or information | **Question** (options + recommendation, blocking or not, batched ≤ 10 per digest) answered in Notion | Q record, linked item |
| Agent makes a call without waiting | **Decision** (assume-and-log) shown in the digest with a veto box | DEC record |
| Hand-off between roles | A **work item moving state** (Backlog → Ready → In Progress → In Review → In QA ...) with guards | Status change event |
| Review of work | **PR review** (tech-lead findings, QA verdict, human approval) | Review comments, test results |
| Several roles must agree | **Meeting protocol**: same input pack, independent round 1, at most two rounds, minutes with owned actions, unresolved points become questions | MTG record |
| Human must approve | **Gate** page with evidence pack; **release approval**; **CR decision** | Gate decision record |
| Tell the human what happened | **Daily digest**; urgent @mention for P1/P2 | Digest record |
| Human changes their mind | **Veto** (undo task) or an edit in Notion (human edit wins) | Event + conflict record |
| Scope changes after approval | **Change request** with impact analysis | CR record, baseline version |
| Something breaks in production | **Incident** record, mitigation, postmortem | INC record, lessons |
| Team learns | **Retro** → lessons → project overrides | LES record, `.arima/overrides/` |

## 5. How the team is measured

Every run writes one ledger row; everything else is derived. Cost per story and per accepted story, rework share and reasons, first-pass QA rate, estimate accuracy by size, lead time, cycle time, touch time, queue time, human wait, flow efficiency, budget burn, and DORA's five metrics (spec 13.3 and 13.4). Budgets are enforced per run, per story, per day and per project (hard stops). Measurement is part of the product, not an add-on: the digest and the retros consume it.

## 6. What Anthropic's own plugins teach us about *building* this

Studied from `anthropics/claude-plugins-official`, especially `feature-dev`, `code-modernization`, `pr-review-toolkit`, `plugin-dev`, `claude-security` and `example-plugin`.

| Observation (what the proven plugins do) | What ARIMA does about it |
| --- | --- |
| **A command is the playbook; agents are narrow specialists.** `feature-dev` is one command that walks fixed phases (discovery, exploration, clarifying questions, architecture, implementation, review) and launches single-purpose agents (`code-explorer`, `code-architect`, `code-reviewer`) | Our phase playbooks are skills (`/arima:discover`, `/arima:design`, `/arima:run` ...) that orchestrate role agents; each agent has one job and a minimal tool list |
| **Humans decide at explicit points; nothing is built until approved.** `code-modernization` lists "a person decides at six points" and refuses to build before the brief is approved; `feature-dev` says "DO NOT START WITHOUT USER APPROVAL" | Gates, the Approval inbox, the PR approval, the production approval; documented as decision points per phase (section 3) |
| **Each step stands alone and ends with the next command; a status command says where you are.** `modernize-status` inspects files and prints the exact next command | `/arima:status` and the rule "every skill ends on one next command"; state lives in files, not chat |
| **Proof comes from scripts, not from the model's opinion**; verification is independent, re-done in a fresh session, with canary tests | Deterministic engine, validators, graders; QA and the verifier agents; the independent judge; mutation checks |
| **Pilot one unit before fanning out** (`uplift`: one pilot unit, lessons written, then batches) | Phase playbooks ask once, pilot one unit, fall back to sequential agents |
| **Agents are adversarial where it matters** (`architecture-critic`: "default stance is skeptical"; `code-reviewer`: report only high-confidence issues with file and line) | tech-lead, qa, security and the verifier agents report evidence-backed findings with severity and refutation attempts |
| **Layout is plain and self-contained**: `.claude-plugin/plugin.json`, `agents/`, `commands` or `skills/`, `hooks/`, `scripts/` (deterministic work), `tests/`, `workflows/` (scripted fan-out), `README`, `CHANGELOG`, `LICENSE`; `marketplace.json` with immutable names | Already the shape of `plugins/arima/`; add `workflows/` only if scripted fan-out is needed; keep tests with the code |
| **README states install, the path, who decides when, what to expect (cost), and what it was tried on** | Plugin README discloses data leaving the machine, state location, cost; "what it was tried on" will be the eval projects |

**A risk to manage:** Anthropic's agents are task-shaped (explorer, architect, reviewer), whereas ARIMA's agents are role-shaped and several (qa, ux, security, tech-lead) carry multiple work-unit kinds. The rule that keeps this safe: **every `kind` an agent can be dispatched with has its own section in the agent file, its own fixtures and evals, and its own owner package** (cards list them in section 2; the register names them). If an agent file approaches the 10,000-character cap, split it into one file per kind rather than shortening the rules.

Deliberate differences: ARIMA's state is machine-written in `.arima/` and Notion (not hand-edited settings), and it uses `skills/<name>/SKILL.md` for commands (the spec's choice), which Claude Code treats as slash commands.

## 7. How the documents are layered, high to low

```
CONCEPT.md                      why and what (this file)            ← the spirit; read first
  └─ 01-architecture.md         the machine that carries it          ← layers, components, trust, rules
       └─ 02-stages.md          build order and exit criteria        ← when each part is built
            ├─ agents/*.md      each role: inputs, handling, outputs ← the deep level for agents
            ├─ features/*.md    each command / engine feature        ← the deep level for features
            └─ 03-contracts.md  the exact interfaces                 ← the lowest level
work-packages.yaml · artifact-map.yaml · 05-verification.md         ← the checkable layer
```

Rules of thumb for any session: start at the top and descend only as far as the task needs; if a lower document contradicts a higher one, the higher one wins and the lower one is a bug; **if something cannot be traced up to section 1, ask the owner before building it**.

## 8. Anti-drift checklist (run mentally before starting any package)

1. Which row of section 2 does this serve? Which phase and artifact of section 3?
2. Does it keep the separation of duties (nobody checks their own work)?
3. Does it leave a record (artifact, event, ledger row) and a human decision point where one is due?
4. Is anything here an engine detail that has taken the place of a team behaviour? If so, say which behaviour it enables.
5. Does every artifact it produces have an owner, a reviewer, a master location and a validator (`artifact-map.yaml`)?
