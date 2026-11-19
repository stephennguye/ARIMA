# 01 Architecture

ARIMA is a Claude Code plugin made of **deterministic code, narrow agents and a safety envelope**. The architecture rule that governs everything else: *judgment goes to the model, everything that can be computed goes to tested code, and nothing the model does is trusted until code has checked it.*

## 1. Layers

Each layer may depend only on layers below it. A layer is "done" when its contract (`03-contracts.md`) is frozen and its tests pass.

| Layer | Contents | Status | Lives in |
| --- | --- | --- | --- |
| **L0 Packaging and tooling** | Marketplace root, plugin folder, TypeScript scripts bundled into single files, CI on Windows and Linux, plugin validation, licence and frontmatter checks | `[BUILT]` | `.claude-plugin/`, `plugins/arima/`, `scripts/`, `.github/` |
| **L1 Contracts** | JSON Schemas, ID scheme, event types, ledger row, outbox entry, hard-stop ids, profiles, artifact catalog, templates and their required sections | `[BUILT]` for config, ids, events, ledger, outbox, profiles, catalog; `[PROPOSED]` for run packet, agent report, question, finding, decision records (WP-101) | `plugins/arima/schemas/`, `profiles/`, `catalog/`, `templates/` |
| **L2 Deterministic engine** | Preflight, kill switch, run lock, budget, ledger, event log, ID issuer, state branch, Notion port, mirror, outbox, init; then: ticket state machine, queue rules, worktree manager, merge script, dispatcher, digest, cost roll-up, gate-check, RTM | partly `[BUILT]` (everything before "then:"), rest `[SPEC]` | `plugins/arima/scripts/src/` |
| **L3 Safety envelope** | Per-role tool allow-lists, PreToolUse guard (fails closed in a project), audit hooks, env allow-list, secret scanner, public-remote refusal, Status-write refusal, optional Docker sandbox | `[BUILT]` except sandbox (`[SPEC]` D-37, WP-190) | `roles.ts`, `hooks.ts`, `hooks/`, `lib/secrets.ts` |
| **L4 Agents** | Nine agent files (eight spec sections each) and the run packets that feed them | orchestrator `[BUILT]`; eight `[SPEC]` | `plugins/arima/agents/` |
| **L5 Process** | Skills (commands), phase playbooks, gates, meetings, question protocol, human interface (Notion views, digest, GitHub reviews) | `init`, `status`, `pause` `[BUILT]`; rest `[SPEC]` | `plugins/arima/skills/`, Notion template |
| **L6 Evaluation** | Unit tests, fixture and stub-agent evals, the live tier, the independent judge | unit, eval v0.1, live tier, judge `[BUILT]`; stub-agent harness `[SPEC]` (WP-150) | `test/`, `test-live/`, `evals/`, `docs/process/` |

## 2. Component model (what each kind of component is for)

| Component | Use it for | Never use it for | Rule |
| --- | --- | --- | --- |
| **Script** (TypeScript, bundled to `scripts/dist/*.mjs`) | Anything deterministic: counting, ordering, validating, rendering, state transitions, API calls, git operations | Judgment, free-text decisions | Strict TS, ESM, Node 22. Exit codes documented and tested. Reads and writes only through the safe helpers (locked append, atomic write, validated JSON). Committed bundle must equal a fresh build (`check:dist`). |
| **Agent** (`agents/<role>.md`) | One role's judgment in one bounded run: reading inputs, producing an artifact or a verdict | Orchestration, counting, writing to Notion, anything that needs a secret | Eight spec sections; least-privilege tool list; the folders it may write are named in its body; guesses must be marked as guesses; citations required (`file:line` or item id). |
| **Skill** (`skills/<name>/SKILL.md`) | A command a human runs, or a phase playbook | Logic of its own | Thin: calls a tested script and explains its exit codes. `disable-model-invocation: true` for anything with side effects; `allowed-tools` lists exact script paths, never bare `Bash`. Ends by naming the one next command. Long tables go to `references/`. |
| **Hook** (`hooks/hooks.json` + scripts) | Things that must always happen: guards, hard stops, audit | Business logic | Command hooks; exit 2 blocks; explicit timeouts; no-op outside an ARIMA project; the PreToolUse guard fails closed inside one. Hooks run in parallel, so none may depend on another. |
| **Template** (`templates/*.md`) | The required sections of a document artifact | Behaviour | Required sections live in the artifact catalog; a validator fails a document missing one; the code that renders a template fails on an unfilled or unused placeholder. |
| **Schema** (`schemas/*.json`) | Every JSON ARIMA writes or reads across a boundary | Documentation | All JSON written by ARIMA validates against a schema. A schema change bumps `schema_version` and ships a migration (see section 6). |
| **State** | Everything an agent must remember | The model's context | Agents keep nothing between runs. State is files: `.arima/` on the `arima-state` branch, Notion, the repo. |

## 3. Runtime model

```
human ──(Notion pages, GitHub reviews)──► ARIMA
                                             │
   /arima:* skill or (later) scheduler ──► orchestrator session (host process, holds the Notion token)
                                             │ 1. preflight (config, kill switch, lock, budget, env)
                                             │ 2. sync in (Notion → .arima/mirror, GitHub → status)
                                             │ 3. plan the day (pure code: state machine + queue rules)
                                             │ 4. for each work unit: build run packet → arima-run-agent
                                             ▼
                      role-agent run (headless `claude -p`, own worktree, scrubbed env,
                      per-role tool list, hooks active, optional Docker sandbox)
                                             │ writes: product files in its allowed folders,
                                             │         proposals to .arima/outbox/, an agent report
                                             ▼
                      orchestrator validates every output (schemas, templates, state machine,
                      secret scan) ──► applies outbox to Notion ──► ledger row + events
                                             │ 5. gates, meetings, digest, state push, release lock
```

Invariants of the runtime (each is a test target):

1. **One writer to Notion**: only the orchestrator process holds the token and calls `arima-notion push`. Agents propose through the outbox.
2. **One run per work unit**, with a role, an item, a dollar cap, a turn cap and a worktree. Every run produces exactly one ledger row, whatever happened.
3. **Outputs are untrusted until validated.** An agent report, an outbox entry and a written artifact are checked by code before they change any state. A failed validation is a failed run, not a partial success.
4. **No agent holds push credentials or merges** (D-37, D-38): a host script pushes the story branch and opens the pull request; one merge script merges after CI green, QA pass and the human's approving review.
5. **Stop on uncertainty** (principle 10, D-39): unreadable kill switch, missing credential, over budget, unknown privacy of the state remote: refuse and ask.
6. **Human edits win** (spec 3.3): conflicts are detected by property value, not timestamps, and the entry goes to `outbox/conflicts/`.

## 4. Anthropic practices as enforceable rules

Studied from Anthropic's own plugin repository (`plugin-dev`, `code-modernization`, `claude-security`) and the Claude Code documentation. Each practice is a rule with an owner test.

| Practice | Rule in this repo | Enforced by |
| --- | --- | --- |
| Everything the plugin needs lives in its folder | `plugins/arima/` has its own LICENSE, NOTICE, README, CHANGELOG; nothing references files outside it at runtime; templates under `templates/` not `skills/` (ADR-0002); no `CLAUDE.md` inside the plugin | `packaging.test.ts`, `claude plugin validate --strict` |
| Validate the way Anthropic does | CI runs strict plugin validation alone and inside a throwaway marketplace; actions pinned by commit SHA | `.github/workflows/ci.yml` |
| Agents: least privilege, clear triggers | Each agent file sets `name`, trigger-style `description` ("Use this agent when…", plus "not for direct invocation" for agents ARIMA starts itself), `model`, `color`, only the tools it needs | `agents.test.ts`, `roles.ts` tests |
| Agents: brief to a colleague | Second person, eight spec sections, under 10,000 characters, writable folders named, citations required | `agents.test.ts` |
| Skills: discoverable and small | Third-person description with the phrases a user says; imperative body; under ~2,000 words; detail in `references/`; ends with "Additional resources" | `skills.test.ts` |
| Skills: safe by default | Side effects → `disable-model-invocation: true`; exact script paths in `allowed-tools` | `skills.test.ts` |
| Commands end on one next step | Every skill finishes with the exact next command | `skills.test.ts` |
| Hooks: hard stops are plain scripts | Exit 2, timeouts, quiet outside projects, guard fails closed in a project, latency budget (median under 1 s) | `hooks.test.ts`, `guard-hardening.test.ts` |
| Deterministic work in code, judgment in the model | Counting, tallying, ordering, sharding, rendering, rule checks (gates, coverage, budgets) are scripts with tests | review rule + judge checkpoint |
| Verification by a second, sceptical agent | Where a result matters (review, QA verdict, security finding, gate recommendation) a separate agent tries to disprove it; no agent checks its own work | `04-agent-build-protocol.md`, judge |
| State lives in files, not chat | A fresh session plus `/arima:status` is enough to continue | `STATE.md`, `status` skill |
| Big fan-out is gated | Discovery, design and release testing show plan and cost, ask once, pilot one unit, fall back to sequential | playbook skills (Stage 3) |
| Say what happens to your data | Plugin README states what leaves the machine, where state lives, what it costs, no telemetry unless enabled | `packaging.test.ts` (README sections) |
| Marketplace hygiene | `$schema`, immutable plugin slug, semver + changelog | validate, CHANGELOG check |

Two deliberate departures from Anthropic habit: the eight-section agent layout (the spec requires it) and machine state in `.arima/` (Anthropic's `.local.md` is for hand-edited settings).

## 5. Trust boundaries

| Boundary | Trusted side | Untrusted side | Control |
| --- | --- | --- | --- |
| Notion → ARIMA | ARIMA's own schema and ids | Page text, property values, comments | Read through the mirror as data; secret scan before any write back; never executed or followed as instruction |
| Agent → repo | The worktree it was given | Everything it writes | Tool allow-list + guard + review + CI; protected paths (`.github/`, hooks, `arima.yaml`, `team.yaml`, `.arima/`) |
| Agent → Notion | Nothing | Every outbox entry | Outbox schema, human-only fields refused, `Status` writes refused without a human flag, secrets refused, conflict check |
| Agent → network | Allow-listed tools | Web content (`WebFetch`) | Data only; no write tools exposed to the web path |
| Host → child process | The orchestrator | The child's environment | Env allow-list; the Notion token only to the orchestrator; the GitHub token only to roles that may hold it (and, by D-37, only to the host push script) |
| State branch → GitHub | Private remote | Public remote, unknown remote | Push refused unless private (or explicit owner override) |
| Human → gate | Listed approver | Anyone else with page access | Placeholder check now (D-40); real check = S1 mechanism, built in Stage 3 |

Honest limit (D-36, D-37): until the Docker sandbox exists, the local layers are advisory for roles that can run project scripts (developer, QA). Branch protection on the default branch and "agents never hold push credentials" are the real barriers.

## 6. Extension rules (how to add things without breaking the architecture)

- **New agent**: follow `04-agent-build-protocol.md`; add the role to `ROLES`, `roles.ts`, `configKey`, the permissions matrix test, the card in `agents/`, the agent file, an eval scenario set. The roster in the spec changes only by owner decision.
- **New skill**: card in `features/`; thin `SKILL.md`; logic in a script; structure test.
- **New script or exit code**: add to the exit-code registry in `03-contracts.md` in the same change; document and test each code.
- **New event type**: add to `events.ts`, `schemas/event.schema.json` and the registry; never reuse a type for a different meaning.
- **New JSON file or field written by ARIMA**: schema first; bump `schema_version` if existing readers could break; add a migration and a test that loads the previous version.
- **New Notion database or property**: `notion/schema.ts` data, bump `template_schema_version`, migration in `map --migrate`, `docs/NOTION-TEMPLATE.md`, test against the fake and then a real workspace.
- **New hard stop**: add the id to `hardstops.ts`, the config schema enum and the spec table; implement the enforcement; add a test that tries to break it; mark `NOT ENFORCED YET` anywhere it is documented until then.
- **New dependency**: ask the owner first; Apache-2.0-compatible licence only.
- **Changing a frozen contract** (anything in `03-contracts.md` tagged frozen): ADR first, then migration, then code.

## 7. Failure policy (one table, used by every component)

| Situation | Response | Where defined |
| --- | --- | --- |
| Hard-stop matter and uncertain | Refuse, record `hardstop.hit`, ask the human | spec 11.1, `hardstops.ts` |
| Audit write fails | Never block the session (audit hooks fail open); log to stderr | `hook-cli.ts` |
| Guard cannot decide inside a project | Block (exit 2) | ADR-0005 |
| Agent run errors | Retry once; second failure → item Blocked + question | spec 7.12 |
| Output fails validation | Run result `fail`; output discarded; rework reason `other`; counts as an attempt | `03-contracts.md` |
| Run hits budget or turn cap | Result `blocked`; item Blocked with cost-so-far question | spec 7.12 |
| Notion transient error | Reads retry (twice); writes never retried blindly; entry deferred to the next push | `throttle.ts`, `port.ts` |
| Notion permanent refusal (4xx) | Entry rejected with the reason; others continue | `outbox.ts` |
| Human edit conflicts with entry | Entry to `conflicts/`; human value kept; orchestrator re-reads and re-proposes or asks | `outbox.ts` |
| Usage limit | Run result `paused`; resume at next run | `run-agent.ts` |
| Unknown / unreadable kill switch | Counts as paused | D-39, `killswitch.ts` |
