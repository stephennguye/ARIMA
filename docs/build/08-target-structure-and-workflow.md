# 08 Target folder structure and workflow diagrams

Read `CONCEPT.md` first: sections 2 and 3 below are the *team view* (the spirit of ARIMA); sections 4 to 6 are the *machine view* that carries it.

Status: `[PROPOSED]`. The "after" structure is the target once the build is done and the documentation is cleaned up; the cleanup itself needs the owner's approval (see `START-HERE.md`, third prompt). Nothing here has been moved yet.

## 1. Folder structure: before and after

### Before (today)

```
arima/
├── START-HERE.md  README.md  CLAUDE.md  LICENSE  NOTICE
├── package.json  tsconfig.json  eslint.config.js  .prettierrc.json  .gitignore ...
├── vitest.config.ts  vitest.evals.config.ts  vitest.live.config.ts  vitest.agents.config.ts
├── .claude-plugin/marketplace.json
├── .github/workflows/ci.yml        .githooks/pre-push
├── scripts/                        build.mjs  check-dist.mjs  setup-hooks.mjs  tick-task.mjs
├── examples/                       arima.yaml  team.yaml  brief.md
├── evals/                          README.md  v0.1/
├── docs/
│   ├── spec/                       ARIMA-Master-Spec.md  README.md
│   ├── adr/                        ADR-0001 .. ADR-0006
│   ├── build/                      README, 00-08 docs, STATE.md, work-packages.yaml,
│   │                               agents/ (10 files), features/ (11 files)
│   ├── process/                    JUDGE.md  spec-issues.md  reviews/ (6 review files)
│   ├── BUILD-GUIDE.md  BUILD-PLAN.md  KICKOFF-PROMPT.md      (superseded)
│   ├── INSTALL.md  PRODUCT-GUIDE.md  NOTION-TEMPLATE.md  SETUP-CHECKLIST.md
└── plugins/arima/
    ├── .claude-plugin/plugin.json
    ├── agents/                     orchestrator.md                      (1 of 9)
    ├── skills/                     init  status  pause                  (3 of 18)
    ├── hooks/                      hooks.json  guard.sh
    ├── catalog/                    artifacts.yaml
    ├── profiles/  schemas/  templates/
    ├── scripts/src/ + dist/ + test/ + test-live/
    └── LICENSE  NOTICE  README.md  CHANGELOG.md
```

### After (v1.0, cleaned up)

```
arima/
├── README.md                       what it is, 5-minute install, link to docs/
├── START-HERE.md                   only for contributors and fresh sessions
├── CLAUDE.md  LICENSE  NOTICE  CONTRIBUTING.md
├── package.json  tsconfig.json  eslint.config.js  .prettierrc.json
├── vitest/                         one folder: unit.ts  evals.ts  live.ts  agents.ts
├── .claude-plugin/marketplace.json
├── .github/workflows/              ci.yml  release.yml  (arima-daily.yml only after Gate U)
├── tools/                          build.mjs  check-dist.mjs  setup-hooks.mjs   (was scripts/)
├── examples/                       sample-project/  (brief, arima.yaml, team.yaml, stories)
├── evals/
│   ├── stub/                       engine scenarios with stub agents (run in CI)
│   ├── agents/                     real-agent evals, one folder per role (run by hand)
│   └── fixtures/                   scrubbed real responses, golden outputs
├── docs/
│   ├── spec/                       ARIMA-Master-Spec.md  (the authority)
│   ├── adr/                        ADR-0001 ..  (decisions)
│   ├── build/                      the live plan: README, STATE, work-packages.yaml,
│   │   │                           architecture, stages, contracts, verification, risks
│   │   ├── agents/                 one card per agent
│   │   └── features/               one spec per command / engine feature
│   ├── guides/                     INSTALL  PRODUCT  NOTION-TEMPLATE  SETUP-CHECKLIST
│   ├── process/                    JUDGE.md  spec-issues.md
│   └── archive/                    BUILD-GUIDE  BUILD-PLAN  KICKOFF-PROMPT  reviews/  (read-only history)
└── plugins/arima/                  the installable product; self-contained
    ├── .claude-plugin/plugin.json
    ├── agents/                     orchestrator  ba  ux  architect  tech-lead
    │                               developer  qa  security  devops               (9)
    ├── skills/                     init discover design setup plan run digest meeting gate
    │                               release hypercare incident cr retro status cost assign pause (18)
    ├── hooks/                      hooks.json  guard.sh
    ├── catalog/  profiles/  schemas/  templates/  stacks/ (one reference stack)
    ├── scripts/
    │   ├── src/{engine,safety,notion,git,agents,cli,lib}/    (grouped by layer)
    │   ├── dist/                   committed single-file bundles
    │   └── test/  test-live/
    └── LICENSE  NOTICE  README.md  CHANGELOG.md
```

What changes: superseded planning files and review reports move to `docs/archive/` (kept, not deleted); guides gather in `docs/guides/`; the four vitest configs collapse into one folder; repo-level `scripts/` becomes `tools/` so it is not confused with the plugin's `scripts/`; the plugin gains eight agents, fifteen skills and a reference stack; `scripts/src/` is grouped by layer once Stage 1 adds the engine modules. `docs/build/` stays, because it is the working plan.

## 2. The team view: a company team, lifecycle, artifacts and gates

```mermaid
flowchart LR
  CL["CLIENT SIDE (humans)<br/>sponsor, PO, legal<br/>give the brief, answer questions,<br/>approve gates and PRs, veto,<br/>approve production"]

  P0["PHASE 0 Initiation<br/>orchestrator, ba, architect, security<br/>OUT: charter, budget plan, feasibility note,<br/>compliance screen, risk register"]
  G0{{"G0<br/>sponsor"}}
  P1["PHASE 1 Discovery<br/>ba, ux, architect, security, qa<br/>OUT: PRD, URS, SRS, NFRs, glossary, personas,<br/>wireframes, security reqs, DPIA, stories<br/>MEETING: requirements review"]
  G1{{"G1<br/>sponsor + PO"}}
  P2["PHASE 2 Design<br/>architect, ux, security, qa, devops<br/>OUT: SAD, ADRs, OpenAPI, data model,<br/>prototype, threat model, master test plan,<br/>environment matrix, milestone plan<br/>MEETING: design review"]
  G2{{"G2<br/>PO + sponsor"}}
  P3["PHASE 3 Setup<br/>devops, tech-lead, qa, developer<br/>OUT: CI/CD, staging, conventions,<br/>walking skeleton"]
  subgraph P4["PHASE 4 Build, repeated per milestone"]
    direction TB
    S1["qa writes test cases"] --> S2["developer builds in own worktree"] --> S3["tech-lead reviews"] --> S4["qa tests on preview"] --> S5["human approves PR, merge script merges,<br/>devops deploys staging"]
    S5 --> S6["MILESTONE REVIEW: human may veto,<br/>RETRO: lessons"]
  end
  P5["PHASE 5 Stabilize and UAT<br/>qa, security, devops, humans<br/>OUT: test reports, security report,<br/>pentest report, UAT sign-off<br/>MEETING: go/no-go"]
  G3{{"G3<br/>sponsor + PO"}}
  P6["PHASE 6 Release<br/>devops, ba<br/>OUT: release record, notes, user guide,<br/>runbook, support pack, SBOM"]
  PA{{"PRODUCTION APPROVAL<br/>human, on the release page"}}
  P7["PHASE 7 Hypercare, 2 weeks<br/>devops, developer<br/>OUT: ops manual, incident records,<br/>hypercare and closure reports"]
  G4{{"G4<br/>sponsor"}}
  P8["PHASE 8 Operations<br/>incidents, change requests,<br/>recurring jobs, new milestones"]

  CL --> P0 --> G0 --> P1 --> G1 --> P2 --> G2 --> P3 --> P4 --> P5 --> G3 --> P6 --> PA --> P7 --> G4 --> P8
  G0 -. "rejected: back with comments" .-> P0
  G1 -. "rejected" .-> P1
  G2 -. "rejected" .-> P2
  G3 -. "rejected: fix and retest" .-> P5
  P8 -. "change request: impact analysis, new baseline" .-> P1

  subgraph ALWAYS["Running through every phase"]
    DG["DAILY DIGEST: stand-up and status report<br/>(awaiting you, shipped, decisions with veto,<br/>blockers, cost and time, plan, run health)"]
    QN["QUESTIONS to the client: batched, with options<br/>and a recommendation; blocking or assume-and-log"]
    DL["DECISION LOG: every autonomous call, vetoable"]
    LG["LEDGER: every run costs and times against<br/>project, phase, story and role"]
  end
  ALWAYS -.-> CL
```

## 3. Communications: who talks to whom, and through what

Every team conversation has one channel and leaves a record (`CONCEPT.md` section 4).

```mermaid
flowchart TB
  subgraph TEAM["The team (agents)"]
    OR["orchestrator<br/>project manager and scrum master"]
    BA["ba"] ~~~ UX["ux"] ~~~ AR["architect"] ~~~ SE["security"]
    TL["tech-lead"] ~~~ DV["developer"] ~~~ QA["qa"] ~~~ DO["devops"]
  end
  subgraph HUMANS["Humans"]
    SP["sponsor"] ~~~ PO["product owner"] ~~~ LE["legal"]
  end

  subgraph CH["Channels, each leaving a record"]
    C1["QUESTION<br/>Q record: options, recommendation, blocking?"]
    C2["DECISION<br/>DEC record with veto box"]
    C3["WORK ITEM STATE<br/>hand-off between roles; guards"]
    C4["PR REVIEW<br/>findings, QA verdict, human approval"]
    C5["MEETING<br/>same pack, independent round, minutes, actions"]
    C6["GATE<br/>evidence pack, decision by approver"]
    C7["DIGEST<br/>daily status to humans"]
    C8["CHANGE REQUEST<br/>impact analysis, new baseline"]
    C9["INCIDENT<br/>INC, mitigation, postmortem"]
    C10["RETRO<br/>lessons, project overrides"]
  end

  TEAM -->|"need info or a ruling"| C1 --> HUMANS
  TEAM -->|"made a call"| C2 --> HUMANS
  HUMANS -->|"answer, veto, priority, edit in Notion"| OR
  BA & AR & UX & DV & QA & TL -->|"hand over work"| C3
  DV --> C4
  TL --> C4
  QA --> C4
  HUMANS -->|"approving review"| C4
  OR -->|"convenes"| C5
  TEAM --> C5
  OR -->|"prepares"| C6 --> HUMANS
  OR --> C7 --> HUMANS
  HUMANS -->|"asks for a change"| C8 --> BA
  DO --> C9 --> TEAM
  OR --> C10 --> TEAM
```

## 4. The machine view: agents, tools, inputs and outputs (how the team above is carried by code)

```mermaid
flowchart TB
  %% ---------- people and external systems ----------
  subgraph HUM["Humans: sponsor, PO, legal (roles in team.yaml)"]
    H1["Write the brief; answer questions;<br/>approve gates in Notion;<br/>review and approve every PR in GitHub;<br/>approve production deploy; veto"]
  end

  subgraph NOT["Notion workspace: 19 databases (master for plan, requirements, gates, questions, digests)"]
    N1[("Stories, Requirements, Gates,<br/>Questions, Decisions, Bugs,<br/>Digests, Cost log ...")]
  end

  subgraph GH["GitHub (master for code, docs, CI)"]
    G1[("App repo: code, tests,<br/>docs/architecture, api/, design/<br/>PRs, CI, releases")]
    G2[("arima-state branch:<br/>.arima/ persisted")]
  end

  %% ---------- host: orchestrator + deterministic engine ----------
  subgraph HOST["Host machine: orchestrator session holds the Notion token; kill switch = Notion to-do + PAUSE file + state branch"]
    direction TB
    PRE["1 Preflight script<br/>in: arima.yaml, team.yaml, kill switch, run.lock, ledger, env<br/>out: ok or exit 10-14; hardstop.hit event"]
    SYNC["2 Sync in: arima-notion pull<br/>in: Notion, GitHub status<br/>out: .arima/mirror/*.json (read-only for agents)"]
    INBOX["3 Apply human inputs: inbox<br/>in: mirror diff (approvals, answers, vetoes, priority)<br/>out: events; Status changes by the state machine"]
    PLAN["4 Plan the day: queue + ticket state machine<br/>in: items, DoR, budgets, WIP, review queue<br/>out: ordered work-unit descriptors"]
    PKT["Packet builder<br/>in: work unit + mirror + repo paths<br/>out: run packet markdown<br/>with untrusted blocks fenced"]
    WT["Worktree manager<br/>out: branch + worktree per unit"]
    RUN["arima-run-agent<br/>caps: dollars, turns, minutes<br/>env allow-list; role tool list; guard hooks;<br/>optional Docker sandbox"]
    COL["Report collector<br/>in: final message arima-report JSON<br/>checks: schema, evidence, secret scan, templates<br/>out: report.json; retry once on failure"]
    OUTB["Outbox + push: arima-notion push<br/>checks: human-only fields, Status refused,<br/>secrets, value-based conflicts<br/>out: Notion rows, mirror refresh"]
    PUB["Publish script (host only, holds GitHub token)<br/>out: pushed story branch + PR from template"]
    MRG["Merge script: only merger<br/>needs CI green + QA pass + human approving review"]
    GATE["Gate-check + evidence pack<br/>in: artifacts, catalog, profile<br/>out: gate page Ready for review"]
    DIG["Digest + cost roll-up<br/>in: ledger, events, mirror<br/>out: Digest row, Cost log, health flags"]
    LED[("ledger.jsonl: one row per run<br/>events.jsonl: every state change")]
  end

  %% ---------- agents ----------
  subgraph AG["Role agents: headless claude -p, one per work unit, no memory between runs"]
    direction TB
    BA["ba (strong)<br/>in: brief, answers, mirror<br/>out: PRD, URS, SRS, stories + criteria, questions<br/>tools: Read, drafts folder, WebFetch"]
    UX["ux<br/>in: PRD, stories, brand<br/>out: personas, wireframes, HTML prototype,<br/>tokens, screen states, design-QA verdict<br/>tools: design/ folder, Playwright"]
    ARC["architect (strong)<br/>in: PRD, SRS, NFRs<br/>out: SAD, ADRs, OpenAPI, data model, cost estimate<br/>tools: docs/architecture, api/"]
    SEC["security (strong)<br/>in: SAD, diffs, scanner output<br/>out: threat model, findings, DPIA draft, report<br/>tools: read, git read, npm audit<br/>+ verifier pass on critical findings"]
    DEV["developer x N<br/>in: story, AC, OpenAPI, ADRs, screens, test cases<br/>out: code + tests in own worktree,<br/>report with criteria_map evidence<br/>tools: edit in worktree, build/test; no push, no merge"]
    QA["qa<br/>in: story, AC, Master Test Plan, preview URL<br/>never sees developer notes<br/>out: test cases, e2e tests, bugs, verdict<br/>tools: tests folder, Playwright"]
    TL["tech-lead (strong)<br/>in: PR diff, AC, conventions, CI<br/>out: review findings blocker/major/minor/nit,<br/>verdict; comment review only<br/>tools: git/gh read, tests"]
    OPS["devops<br/>in: SAD, CI results, alerts<br/>out: CI/CD, staging deploys, runbooks, incidents, SBOM<br/>tools: infra/, .github/, staging CLIs only"]
  end

  %% ---------- flows ----------
  H1 -->|"brief, approvals, answers, vetoes"| N1
  N1 -->|"pull"| SYNC
  PRE --> SYNC --> INBOX --> PLAN
  PLAN -->|"work-unit descriptor"| PKT
  PKT -->|"run packet"| RUN
  WT -->|"worktree path"| RUN
  RUN --> BA & UX & ARC & SEC & DEV & QA & TL & OPS
  BA & UX & ARC & SEC & DEV & QA & TL & OPS -->|"arima-report + files + proposals"| COL
  COL -->|"valid: outbox entries (Q, DEC, TC, BUG ids issued by engine)"| OUTB
  COL -->|"invalid: run_failures + 1, retry once, then Blocked + question"| PLAN
  OUTB -->|"push"| N1
  DEV -->|"commits in worktree"| PUB
  PUB -->|"branch + PR"| G1
  H1 -->|"approving review"| G1
  TL -->|"comment review"| G1
  G1 -->|"CI green"| MRG
  QA -->|"pass verdict"| MRG
  MRG -->|"squash merge"| G1
  OPS -->|"staging deploy"| G1
  PLAN --> GATE
  GATE -->|"evidence pack, gate Ready for review"| N1
  N1 -->|"human decision"| INBOX
  RUN --> LED
  COL --> LED
  OUTB --> LED
  LED --> DIG
  DIG -->|"daily digest"| N1
  DIG -->|"digest, awaiting you"| H1
  LED -->|"close: commit .arima/"| G2
  SYNC -.->|"kill switch fallback"| G2

  %% ---------- hard stops ----------
  HS{{"Hard stops: gates G0-G4, production deploy,<br/>secrets, budget, story budget, Notion delete,<br/>data migration, paid service, licence,<br/>critical finding, kill switch, missing credential<br/>=> stop, record, ask a human"}}
  PRE -.-> HS
  PLAN -.-> HS
  RUN -.-> HS
```

## 5. One story from Ready to Done (the build loop)

```mermaid
sequenceDiagram
  autonumber
  participant H as Human (PO)
  participant O as Orchestrator and engine
  participant Q as qa agent
  participant D as developer agent
  participant T as tech-lead agent
  participant GH as GitHub
  participant N as Notion
  Note over O: Preflight ok, mirror pulled, story US-112 is Ready (DoR holds, budget left)
  O->>Q: packet kind test-write (story, criteria AC-1..n)
  Q-->>O: report + test case proposals (no ids)
  O->>N: outbox push: TC records (engine issues TC ids)
  O->>D: packet kind develop (story, OpenAPI, ADRs, test cases, worktree)
  D-->>O: report: criteria_map with file:line evidence, commits in worktree
  alt report invalid or evidence missing
    O->>O: run_failures + 1, retry once, second failure: Blocked + question
  else report valid
    O->>GH: publish script pushes branch and opens PR from template
    GH-->>O: CI result
    O->>T: packet kind review (PR diff, criteria, conventions)
    T-->>O: verdict approve or changes_requested with findings
    alt changes requested
      O->>O: attempt + 1 (third attempt: Blocked + question), back to developer
    else approved
      O->>Q: packet kind qa (preview URL, test cases)
      Q-->>O: verdict pass or fail + bugs
      alt QA fails
        O->>O: attempt + 1, BUG linked, back to developer
      else QA passes
        O->>N: status In QA, flagged Awaiting you
        H->>GH: approving review on the PR
        O->>GH: merge script checks CI green + QA pass + human review, squash merges
        O->>GH: staging deploy (production refused, hard stop)
        O->>N: engine writes Status PO Acceptance then Done
        Note over H,N: Human may veto at milestone review: story reopens with a BUG
      end
    end
  end
  O->>N: digest row, cost per story from the ledger
```

## 6. Ticket states (the rules the engine enforces)

```mermaid
stateDiagram-v2
  [*] --> Backlog
  Backlog --> Ready: ba + po priority, DoR holds
  Ready --> InProgress: orchestrator assigns; tests exist, budget, WIP ok
  InProgress --> InReview: developer; PR open, CI green, criteria mapped
  InReview --> InProgress: tech-lead changes requested (attempt + 1)
  InReview --> InQA: tech-lead approves, preview up
  InQA --> InProgress: qa fails a test, BUG linked (attempt + 1)
  InQA --> POAcceptance: human PR approval, merge script merges
  POAcceptance --> Done: automatic on QA pass
  POAcceptance --> InProgress: human veto at milestone review
  Done --> Released: devops, production release
  Backlog --> Blocked: blocking question, missing credential, budget, third failed attempt
  Ready --> Blocked
  InProgress --> Blocked
  InReview --> Blocked
  InQA --> Blocked
  Blocked --> InProgress: cause resolved (returns to previous state)
  Backlog --> Cancelled: po
  Ready --> Cancelled: po
  InProgress --> Cancelled: po
```
