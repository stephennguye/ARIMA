> **Superseded in part.** The stage plan, work packages, contracts, agent cards and verification rules now live in `docs/build/` (start at `docs/build/00-handoff.md`). Sections 2 to 4 of this guide (ground rules, Anthropic practices, definition of done) still stand and are restated in `docs/build/01-architecture.md`; section 5 (the steps) is history.

# How we build ARIMA, step by step

This guide says what we build next, in what order, how each piece is built and checked, and how Anthropic's plugin best practices are part of every step rather than something added at the end. It pairs with `docs/PRODUCT-GUIDE.md` (what the finished product does). The master spec stays the authority; `docs/BUILD-PLAN.md` keeps the detailed task list and gets new tasks from this guide as each stage starts.

---

## 1. Where we are

### Built (v0.1, tasks T-01 to T-14, 14 pull requests, all green in CI)

- **Foundations:** TypeScript tooling, bundled scripts, CI on Windows and Linux, branch protection on `main`.
- **Config:** schemas and a validator with line-numbered errors, three profiles.
- **Bookkeeping:** ID issuer, event log, run ledger, run IDs, a locked append-only writer.
- **Running agents:** a wrapper that runs one headless Claude session with a dollar cap, a turn cap, a per-role tool list and an allow-listed environment; a usage-limit stop is recorded as a pause. Proven with real headless runs on Windows (Stage 0, S0.2).
- **Safety:** preflight (config, kill switch, run lock, budget, environment variables), a two-way kill switch that the role lists and the guard stop agents from clearing, a guard hook that blocks the common ways to read secret files, merge or push to the default branch, delete in Notion and write protected state (it fails closed inside ARIMA projects when it cannot decide, but not when the hook is killed by its timeout or the bundle is missing), audit hooks, no delete operation in ARIMA's own code. These are pattern-based layers, not a sandbox (spec issue S6).

**Plainly: the local safety layers are advisory for the developer and QA roles until a sandbox or GitHub branch protection exists.** Those two roles can edit files and run the project's own `npm run` and `npm test` scripts. A script they write is not seen by the guard hook (child processes are not hooked), so it could push to the default branch, delete the `PAUSE` file or read the environment. What stops a bad merge for real is GitHub branch protection on the default branch (S0.5; note that private repositories on GitHub Free do not support protected branches) and, for unattended runs, a sandbox: WSL 2 or Linux today, a Docker sandbox once designed (spec issues S6, S16). Everything below the sandbox line (role tool lists, the guard, the scrubbed environment, secret scanning) makes accidents and obvious attacks hard; it is not a boundary against an agent that is trying to get around it.
- **State:** `.arima/` kept on an `arima-state` branch, one commit per run, secret scan before commit.
- **Notion:** the 19-database template as data, bootstrap, verify-and-map, read-only mirror, outbox with human-only field refusal and "human edit wins".
- **Plugin parts:** one orchestrator agent, three skills (`init`, `status`, `pause`), hooks, ten templates.
- **Docs and evals:** install guide, Notion guide, a v0.1 eval that runs in CI.

### Known gaps in what we built (spec audit and the judge's review)

Fixed or being fixed in Stage 0 (see the status column there):

1. Real Notion, real GitHub and the live behaviour of skills were never exercised. The Claude side is now proven; Notion and GitHub are waiting on a shared page and a throwaway repo.
2. The guard, role lists, kill switch, environment and secret handling were weaker than the guides claimed: agents could merge, push to the default branch, clear the kill switch and edit approver config; secrets could reach Notion; the child environment was not trimmed. Stage 0A raised the bar with tests that try a list of forbidden actions; the second independent review (`docs/process/reviews/2026-11-18-judge-2.md`) then found bypasses the list did not contain, and those are being closed one by one. Passing those tests means "the listed forms are blocked", not "the action is impossible".
3. Charter, budget plan and gate pages now render from templates and the 58-artifact catalog exists with a document validator (Stage 0B, built). The 28 new templates have owner-approved section lists.
4. Profiles now have an artifact-level check (`profileStatus`); gate criteria checks arrive with `gate-check` in Stage 2.
5. Seventeen spec issues need the owner's decision (`docs/process/spec-issues.md`), including how a gate approver's identity can be verified, who merges, and Windows versus WSL 2.
6. Packaging gaps against Anthropic's norms (S0.8, S0.9).

---

## 2. Ground rules for every step

From `CLAUDE.md` and from Anthropic's own plugins:

1. **One task at a time, in order.** Before coding: write down the acceptance criteria, the files you will touch, and the test plan.
2. **Tests first** wherever there is logic. Every step ends with: `npm test`, `npm run eval`, `npm run build`, `claude plugin validate ./plugins/arima --strict`, and `claude plugin validate .` all passing.
3. **Never push to `main`.** Work on a named branch, open a pull request, CI must be green.
4. **Small commits** in Conventional Commits style with the task ID: `feat(T-21): add ticket state machine`.
5. **Do not drift silently.** If the spec cannot be followed, write an ADR (status Proposed) and ask. Changing the spec text itself also needs your approval.
6. **Check the real thing.** Anything touching Notion, GitHub, or a live Claude session gets a recorded manual check on a throwaway project before its task is ticked. Mocks prove logic, not reality.
7. **Never print, log, commit or ask for a secret.** Test data is invented.
8. **Update the docs in the same pull request.** Doc tests already fail when the Notion guide or install guide drift from the code; we extend that idea to the product guide.

---

## 3. Anthropic's best practices, and how we apply them

We studied Anthropic's official plugin repository (especially `plugin-dev`, `code-modernization` and `claude-security`, the closest to ARIMA). Each practice below becomes a rule in the "definition of done" lists in section 4 and, where possible, an automatic check in CI.

| Practice | What we do |
| --- | --- |
| **Everything the plugin needs lives in its own folder** | `plugins/arima/` gets its own LICENSE, NOTICE, README and CHANGELOG, because installing from the marketplace copies only that folder |
| **Validate in CI the way Anthropic does** | CI runs `claude plugin validate --json` on the plugin (alone and inside a throwaway marketplace), a frontmatter checker for agents and skills, a JSON check on `hooks/hooks.json`, and a licence check; GitHub Actions pinned by commit |
| **Agents: least privilege, clear triggers** | Each agent file sets `name`, `description`, `model`, `color` and only the tools it needs; the description is written as "use this agent when..." with two or three trigger examples and, for agents ARIMA starts itself, "not for direct invocation" so Claude never picks them by accident |
| **Agents: write like a brief to a colleague** | Second person ("You are..."), exactly the eight sections the spec requires, under 10,000 characters, the folders it may write to named in the body, citations required (`file:line` or an item ID), guesses marked as guesses |
| **Skills: discoverable and small** | Description in third person with the phrases a user would actually say; instructions in imperative form; under about 2,000 words; long tables and examples move to a `references/` folder; ends with an "Additional resources" list |
| **Skills: safe by default** | Anything with side effects is `disable-model-invocation: true`; `allowed-tools` lists exact script paths, never bare `Bash`; read-only skills (status) can be model-invoked |
| **Commands end on one next step** | Every skill finishes by telling you the one exact command to run next; `status` is read-only and works as the "where was I?" entry point after a break |
| **Hooks: hard stops are plain scripts** | Anything that must always happen (guards, hard stops) is a command hook that exits 2; hooks run in parallel so none depends on another; explicit timeouts; no-op quietly outside an ARIMA project |
| **Hooks: do not fail open** | A launcher or session-start check confirms Node is present; if the guard cannot run, ARIMA says so loudly instead of silently skipping it |
| **Deterministic work in code, judgment in the model** | Counting, tallying, sharding, rendering, rule checks (gate criteria, test coverage, budgets) are scripts with tests; agents do the judging |
| **Verification by a second, sceptical agent** | Where a result matters (code review, QA verdict, security findings, gate recommendation) a separate agent tries to disprove it, citations are checked, and critical items get a panel; this is also our "no agent checks its own work" rule |
| **State lives in files, not chat** | Already true (`.arima/`, Notion, repo). Every skill can resume from files; a fresh session plus `/arima:status` is enough to continue |
| **Big fan-out is gated** | Steps that start many agents (discovery, design, release testing) first show the plan and the cost, ask once, pilot on a single unit, and fall back to plain sequential agents if parallel tools are unavailable |
| **Say what it does with your data** | The plugin README states what leaves your machine (Notion API calls, state-branch pushes, the Claude usage), where state is stored, what it costs, and that there is no telemetry unless you turn on OpenTelemetry |
| **Marketplace hygiene** | `marketplace.json` gets `$schema`; the plugin `name` is an immutable slug, so we choose final names before release; version bumps follow semver with a changelog |
| **Use the validators Anthropic ships** | Run `plugin-dev`'s `plugin-validator` and `skill-reviewer` agents on our plugin at the end of each stage, and test with `--plugin-dir` before every release |

Two places we keep our own way, on purpose: the eight-section agent layout (the spec requires it) and machine state in `.arima/` (Anthropic's `.local.md` pattern is for settings people edit by hand; we may use it later for personal preferences).

---

## 4. Definition of done, by kind of component

Copy these into every task that adds the component.

**A new agent**
1. Agent file with `name`, trigger-style `description`, `model`, `color`, least-privilege `tools`, and the eight spec sections.
2. Entry in the role tool list (`roles.ts`) matching the spec's "Tools" line and the permissions matrix.
3. Hooks or scripts block what the file says it must not do (checked by a test that tries).
4. Unit test for the file's structure; eval scenario that runs it against a stub and checks its outputs exist and are valid.
5. Outputs validated against their templates.
6. Added to `docs/PRODUCT-GUIDE.md` status.

**A new skill (command)**
1. `skills/<name>/SKILL.md` with trigger-style description, `argument-hint`, narrow `allowed-tools`, correct invocation setting.
2. Logic in a tested script; the skill only calls it and explains exit codes. Long tables in `references/`.
3. Ends on one exact next command. Never asks for a secret.
4. Structure test (frontmatter, scripts exist, exit codes covered) and an eval step.

**A new hook**
1. Command hook, wrapped JSON with a description, explicit timeout, quiet outside ARIMA projects.
2. Fixture-payload tests for every block and every allow; a test through the real bundled script; a Windows run in CI.
3. Never logs a secret; never blocks on malformed input or its own logging errors.

**A new artifact template**
1. Required sections defined in the spec addendum (once approved) and in the artifact catalog data file.
2. Template file in `templates/`; validator test proving a document missing a required section fails.
3. Used by the code that produces it (nothing hard-coded in scripts).

**A new script**
1. Strict TypeScript, bundled into `dist/`, `npm run check:dist` clean.
2. Exit codes documented and tested; works on Windows, macOS and Linux.
3. Reads and writes only through the existing safe helpers (locked files, atomic writes, validated JSON).

**A change to the Notion template**
1. Schema data updated, `template_schema_version` bumped, a migration in `map --migrate`, `NOTION-TEMPLATE.md` updated, tested against the fake and then a real workspace.

---

## 5. The steps

Steps are numbered so they can become tasks (S0.x are small fixes; later stages use the spec's increments). Order within a stage matters unless marked "parallel".

### Stage 0 - Make v0.1 real and safe (v0.1.1)

Goal: what we built works against the real systems, the hard stops are enforced in code and proven by tests that try to break them, and the plugin is packaged the way Anthropic packages plugins. Nothing new for users except confidence.

An independent reviewer (the judge, `docs/process/JUDGE.md`) read the plan and the code before this stage began and found it too big and too weak in places. This version is the result: Stage 0 is split into **0A** (prove it and make the hard stops real, which gates the v0.1.1 tag) and **0B** (the catalog and templates, which do not). Reports are in `docs/process/reviews/`.

#### 0A - Prove it and make the hard stops real

| Step | What | Status |
| --- | --- | --- |
| S0.1 | Merge the 14 pull requests | **Done** |
| S0.2 | Real-world checks on the Claude side: a real headless run, the plugin loaded in a live session, hooks firing, an allowed script run under the real permission rules, a battery of forbidden actions, real result JSON recorded as fixtures | **Done** (`reviews/2026-11-18-real-world-checks.md`) |
| S0.3 | Real-world checks on the Notion side: bootstrap, map, `init`, mirror and outbox against a real workspace; timestamp granularity for the human-edit-wins rule; whether rollups and formulas are accepted; rate limits; whether a bot-created mention sends email; **whether a gate approver's identity can be checked (spec issue S1)**; whether a page can be duplicated and whether views can be created (S5) | **Waiting** for a Notion page shared with the integration |
| S0.4 | Fix what the judge found missing: no merge or push to the default branch for any role; the kill switch cannot be cleared by an agent and fails closed; the guard fails closed and checks Node exists; secrets scanned before they reach Notion and the scanner widened; child environment is an allow-list; hard stops re-checked at every dispatch; process tree killed on timeout; public state remotes refused; conflict baseline cannot be loosened by an agent; audit actor not "human" by default | **Done for the forms tested.** The second review found more bypasses; see `reviews/2026-11-18-judge-2.md` for what was fixed and what is open |
| S0.5 | Real GitHub check on a throwaway repo and machine account: token scope, `gh pr create`, how `gh pr merge` behaves, worktrees on Windows, behaviour on the Free plan | **Planned** (needs a throwaway repo and account from the owner) |
| S0.6 | A live test tier: `npm run test:live` behind environment variables, run by hand; real responses recorded (scrubbed) and fed back into the fakes so the mocks stop drifting from reality | **Built** (`npm run test:live`, scrubbed fixtures, shape-drift test) |
| S0.7 | Decisions: the owner answers spec issues S1 to S17 (`docs/process/spec-issues.md`); ADRs are written and the spec amended with approval | **Waiting** for the owner |
| S0.8 | Packaging and CI to Anthropic's norms: LICENSE, NOTICE and CHANGELOG inside `plugins/arima/`; `claude plugin validate --json` in CI (alone and in a throwaway marketplace); frontmatter check; hooks JSON check; licence check; Actions pinned by commit; README states what leaves the machine, where state lives, what it costs | **Built** (CI runs on GitHub when the PR runs) |
| S0.9 | Descriptions and hook polish: agent and skill descriptions in Anthropic's style, with "not for direct invocation" on the orchestrator; log permission-rule denials through the `PermissionDenied` hook; `if` filters; a measured hook latency budget; retry transient network errors on Notion reads (never blind retries of creates) | **Built** |

Tag **v0.1.1** when S0.2 to S0.9 are done.

#### 0B - Catalog and templates (does not block the tag)

| Step | What |
| --- | --- |
| S0.10 | The artifact catalog as one data file listing all 58 deliverables (id, phase, owner, master location, which profiles require it, template), with a test that keeps it in step with the profiles and the spec |
| S0.11 | Templates for every deliverable, drafted by the builder and reviewed by the owner at the end; 28 draft templates for document artifacts (records, generated files, code and external documents have none), a template renderer and a validator that fails a document missing a required section (built; the required sections for the 28 are the builder's proposal and need the owner's approval before they count as spec); charter, budget plan and gate pages move out of `init.ts` into templates. The required sections for the 48 new templates go in a separate **draft addendum** file; the spec itself is not edited until the owner approves. Order: the templates v0.2 consumes first (pull request, Definition of Ready and Done, digest, bug, story), then the rest |
| S0.12 | Profile rules become checks: a function that lists, for a profile, the required artifacts and gate criteria and which are present (the base of gate-check). Built for artifact ids; gate criteria come with gate-check in Stage 2 |
| S0.13 | Run the `plugin-dev` validators, update both guides, write the CHANGELOG entry |

### Stage 1 - v0.2 "Build loop (web)"

Goal (from the spec): five stories go from Ready to staging unattended, each with a digest entry and a cost per story. The only humans involved approve pull requests.

| Step | What | Notes |
| --- | --- | --- |
| 1.1 | **Ticket state machine** (spec §7.1): a script that knows every legal move, its guard, and who may make it; counts attempts; third failed review or QA moves to Blocked; story sizes S/M/L with budgets; milestones of 8 to 12 points | Pure code, exhaustively tested; the table in the spec becomes a test table |
| 1.2 | **Budget and queue rules:** story budget enforced before each dispatch (hard stop), review queue limit (stop starting stories when 5 pull requests wait for you) | Extends preflight and the ledger |
| 1.3 | **Working copies:** a script to create and remove a git worktree per developer run, following the branch and path conventions of spec §10.2 | Tested on real temporary repos |
| 1.4 | **ID rule hook:** commits and pull request titles must include a story, bug, incident or change-request ID; Definition-of-Done check before a pull request is marked ready | Hook with fixture tests |
| 1.5 | **Developer agent** + pull request template + `arima-run-agent` wiring | Writes only inside its working copy; cannot read secrets or edit CI or hooks |
| 1.6 | **QA agent:** writes test cases from acceptance criteria before development; tests on a preview; files bugs; never sees the developer's notes (its tool list denies the run-report folder) | A separate verifier pass tries to break each pass verdict |
| 1.7 | **Tech-lead agent and merge guard:** reviews against conventions, tags findings; one script is the only way to merge, and it refuses unless CI is green, QA passed, and your approving review exists (machine account opens pull requests, you approve from your own account) | Tested against a real throwaway GitHub repo |
| 1.8 | **Dispatcher and `/arima:run`:** the ten-step daily run from spec §7.2 (without meetings), with `--dry-run` and `--only <item>`; the plan-the-day order is code | Orchestrator agent grows to its full file |
| 1.9 | **Digest:** a script builds the daily digest from ledger, events and mirror, applies the health rules, caps lists at ten; `/arima:digest` | Uses the digest template |
| 1.10 | **Cost:** daily aggregates into the Notion cost log, per-story cost roll-ups, `/arima:cost` | Estimate accuracy by size |
| 1.11 | **Setup phase:** DevOps agent (staging only), CI and staging templates for the stack, walking skeleton; `/arima:setup`; the `stacks/` decision from S0.4 | Staging deploys automatic; production not yet |
| 1.12 | **Scheduler:** Windows Task Scheduler script (wake timer, catch up on a missed run), with a Linux/macOS cron or GitHub Actions equivalent later | Usage-limit pause already handled |
| 1.13 | **v0.2 eval:** a sample app with five ready stories, run unattended against throwaway Notion and GitHub accounts | Done when the spec's "five stories to staging" holds |

#### Prerequisites and gaps carried into Stage 1 (from the judge's review)

Do these before or inside the steps above; each has a test.

1. **The ticket state machine (1.1) comes before agents write to the Notion outbox.** Today `Status` on stories, requirements and documents is writable by an agent's outbox entry, so an agent could mark a story Done. `arima-notion push` now refuses any entry that sets `Status` unless it is run with `--allow-status-writes`, which only `init` and a human may pass (the guard blocks the flag for every role). The role named in an outbox entry is still self-declared; checking it against the run is still to do before the state machine lands.
2. **Stories have no producer before Stage 2.** The analyst, UX and architect agents arrive in v0.3, so the v0.2 evaluation uses hand-written stories that already meet the Definition of Ready, and says so.
3. **A stack and a staging host are needed for the walking skeleton** (spec issues S11 and Q-04). The owner picks one for the sample project and records it as an ADR before step 1.11.
4. **A stub deploy script ships with `/arima:setup`** (spec issue S10): it can deploy to staging and refuses production under every condition, with its hard stop tested.
5. **The dispatcher owns these rules, each with a test** (step 1.2): story budget before each dispatch, review-queue limit, third failed review or QA moves to Blocked, retry a failed run once, re-run flaky CI once, and the "missing credential" hard stop.
6. **Per-run cost floor.** Plan budgets knowing a run costs about $0.15 to $0.24 at minimum (spec issue S3); set each run's cap to the smaller of the cap and the remaining story budget.
7. **Hermetic headless runs.** Decide whether runs isolate user settings (`--setting-sources`, `--disable-slash-commands`) to cut about half the context cost, which then needs the plugin loaded explicitly (the wrapper already does that).
8. **Permission and secret-file coverage.** The guard is pattern-based. For unattended runs, prefer WSL 2 or Linux (spec issue S6) and add more adversarial tests (obfuscated paths, `git show HEAD:.env`, symlinks, indirect reads).
9. **Upgrade and migration test.** Add a test that loads a v0.1 `.arima/` and config and migrates them, because `schema_version` and `template_schema_version` already ship.
10. **Interactive commands wait for the run lock** (spec §12.4): `arima-notion pull` and other interactive writers take the lock or refuse while a run holds it.
11. **Seat terms and limits** (spec issue S15) are confirmed before the first unattended run.

### Stage 2 - v0.3 "Discovery and design"

Goal: a brief reaches gate G2 with every required artifact, and nobody edits agent output except to answer questions.

| Step | What | Notes |
| --- | --- | --- |
| 2.1 | **Question protocol and human tasks** (spec §7.5, §7.6): question records, batching (max 10), blocking and assume-and-log, reminders at 24 hours and escalation at 48 | Needed by every agent below |
| 2.2 | **Meeting engine** (§7.3): same pack to everyone, independent first round, at most two rounds on disagreements, minutes with owned action items, unresolved points become questions; `/arima:meeting` | Scripts do the packaging and rounds; agents do the thinking |
| 2.3 | **Business analyst agent** and the Phase 1 steps | Outputs follow the templates from S0.10 |
| 2.4 | **UX agent:** personas, journeys, wireframes, HTML prototype, tokens, screen states, accessibility notes | Playwright for screenshots |
| 2.5 | **Architect agent:** architecture document, decision records, API spec, data model, cost estimate; stack proposals approved at G2 | |
| 2.6 | **Security agent:** security requirements, privacy assessment draft, threat model, finding records; a verifier agent tries to disprove each critical finding | Panel for critical items |
| 2.7 | **Gate protocol and `gate-check`** (§7.4): mechanical checks as scripts (coverage, bug counts, CI), evidence pack from the template, accept a decision only from a listed approver, freeze the baseline to `docs/spec/baseline-Gx/`; `/arima:gate` | Uses the profile checks from S0.11 |
| 2.8 | **Phase playbooks:** `/arima:discover` and `/arima:design`, with a cost-and-plan prompt before fan-out, a one-unit pilot, and a sequential fallback | |
| 2.9 | **Traceability and portal:** generated requirements-to-release view, coverage rule, client portal and guest approvals (D-17), `/arima:assign` | |
| 2.10 | **v0.3 eval:** a brief reaches G2 with every artifact required by the profile, validated against templates | |

### Stage 3 - v0.4 "Release and operations"

| Step | What |
| --- | --- |
| 3.1 | Phase 5: release-candidate tagging, regression, performance and accessibility campaigns, dynamic security scan, acceptance scripts generated from acceptance criteria, daily triage, go/no-go meeting, G3 |
| 3.2 | Phase 6: release plan and notes, **production deploy script** that runs on your computer and proceeds only when your approval is on the Notion release page, production data migration flag, gradual rollout and smoke test, user guide, FAQ, support pack, software bill of materials |
| 3.3 | Phases 7 and 8: hypercare, G4, incidents and hotfix flow, change requests with impact analysis, recurring jobs, retros and lessons (with upstream proposals) |
| 3.4 | Finish the hard stops: new paid service, non-approved licence, critical finding, production data migration |
| 3.5 | Optional OpenTelemetry; decide Q-21 (seat or API key when moving to GitHub Actions) |
| 3.6 | **v0.4 eval:** a release, a simulated incident and a change request |

### Stage 4 - v1.0 "Stable"

1. A showcase project built end to end by ARIMA, published.
2. Full eval suite in CI.
3. Migrations for config, Notion template and ledger versions.
4. Install from the marketplace in under 30 minutes, checked by someone who has not seen it.
5. Final plugin and marketplace names, semantic versioning, complete docs, a security review of the shipped payload (including the bundled scripts), and a policy-style read-through of the README for honest disclosure.

---

## 6. How a single step is carried out

1. **Restate** the step: acceptance criteria, files, test plan. You say "go".
2. **Write tests first.** Mocks for Notion, GitHub and the `claude` CLI; a real temporary git repo for anything with git.
3. **Build** it, using the safe helpers.
4. **Run the five checks** (tests, eval, build, plugin validate, marketplace validate). CI repeats them on Windows and Linux.
5. **Real-world check** on a throwaway project if it touches Notion, GitHub or a live session, and write down the result.
6. **Commit** small, **push a branch**, **open a pull request**, tick the task in `BUILD-PLAN.md` with notes on what we learned.
7. **Report:** what changed, how it was verified, what you must do by hand.

At the end of each stage: run Anthropic's `plugin-validator` and `skill-reviewer` agents, update both guides, tag a version, and write the CHANGELOG entry.

---

## 7. What we need from you, and the main risks

**Decisions needed soon**
- Approve (or change) the **template addendum** (S0.10), which is spec text.
- Approve the **ADRs** in S0.4, especially dropping WSL as the default and how `init` relates to template duplication.
- Provide a **throwaway Notion workspace and token**, and later a throwaway GitHub repo and a machine account, for the real-world checks. Without them, Notion and GitHub behaviour stays unproven.
- Say whether a **Claude smoke run** (a few cents of usage) is fine for S0.2.

**Risks**
- **Notion's API may behave differently from our simulation.** Mitigation: S0.2 and S0.3 come first.
- **Usage limits on a single seat.** Five unattended stories a day may hit the limit; the runs pause and resume, and the budgets are estimates. We calibrate after the first real week.
- **Hook guards are pattern-based and can be bypassed by obfuscation.** They are a second layer behind per-role tool lists and an allow-list environment; nothing relies on them alone, and for developer and QA runs they are advisory (see section 1).
- **Size.** Nine agents and eighteen commands is more than any single Anthropic plugin we looked at (the largest has 9 agents in one plugin and 13 commands in another). We keep each file small, move detail to references, and test every file's structure automatically.
- **The spec has gaps** (the 48 missing template definitions; `stacks/` versus D-12). We flag each one as an ADR instead of guessing.
