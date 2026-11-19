# Feature spec F09: the safety envelope

> Status: built except the sandbox. Work packages: WP-005 (done), WP-190 (planned, Docker sandbox), with edges in WP-104, WP-105, WP-111, WP-112, WP-160, WP-402, WP-404. Spec: 4.4, 5 ("Tools"), 11.1 to 11.3, principle 10, 7.12. ADRs and decisions: ADR-0003, ADR-0005 (Proposed; the owner confirms it at checkpoint J1, RD-F09-9), ADR-0006 (accepted in principle by D-37, design only, amended by F08 RD-F08-9), D-36, D-37, D-38, D-39, D-42, D-44 to D-48, S4, S16, S18. Contracts: `03-contracts.md` sections 2, 5, 7. Code: `scripts/src/{roles,hooks,run-agent,killswitch,preflight,hardstops,state}.ts`, `lib/secrets.ts`, `cli/{hook-cli,run-agent-cli}.ts`, `bin/arima-hook.ts`, `hooks/{hooks.json,guard.sh}`.
>
> Tags: `[BUILT]` in code with tests; `[SPEC]` required, not built; `[PROPOSED]` frozen by the named WP. Each layer is marked **enforced** (code refuses regardless of the model) or **advisory** (works only if the agent stays inside the tools the guard can see).

## 1. Purpose and spec refs

Make an unattended or semi-attended agent unable to do the things spec 11.1 names, and unable to leak secrets (11.3), by layers that do not rely on the model behaving: a per-role tool allow-list and deny-list, a PreToolUse guard that fails closed, a scrubbed child environment, a secret scanner, a private-remote check for the state branch, a three-source kill switch, and a fixed hard-stop registry. Honest limit (D-36, `01-architecture.md` section 5): until WP-190 lands, local layers are advisory for roles that can run project scripts (developer, QA, and tech-lead through `npm run`), because a script the agent writes and runs is invisible to the guard.

## 2. Command or entry point and arguments

| Part | Entry | Notes |
| --- | --- | --- |
| Launcher and guard | `hooks/hooks.json` PreToolUse, matcher `*`, `sh "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" pre-tool-use`, timeout 10 s; guard calls `arima-hook.mjs pre-tool-use` | active in any folder with `arima.yaml` above it |
| Audit hooks | PostToolUse (`Write\|Edit\|MultiEdit\|NotebookEdit\|Bash`), PermissionDenied, SubagentStop, Stop to `arima-hook.mjs` | fail open |
| Run wrapper | `arima-run-agent --role --item --budget --max-turns --prompt-file ...` | builds tool lists and child env, re-checks kill switch and budgets |
| Preflight | `arima-preflight` (exit 10-14) | kill switch, lock, budget, env |
| Kill switch | `arima-pause` (F01) | human only; the guard blocks `arima-pause\|arima-init` for any role |
| State push privacy | `arima-state push` | F01, spec 9.4 |

## 3. Preconditions (IF/THEN)

- IF a tool call arrives and no `arima.yaml` is found up the tree (also via `ARIMA_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`) THEN every hook allows and logs nothing (`findProjectDir`, `handleHook`). Outside a project the plugin is invisible.
- IF the call is inside a project and the guard cannot decide (unreadable payload, internal error, bundle missing or crashing, Node missing or too old, any exit code other than 0 and 2) THEN exit 2 (block). `guard.sh` (`in_project`, `block`), `hook-cli.ts` (`failsClosed`), `bin/arima-hook.ts` (`failureExit`). Tests: `guard-hardening.test.ts` (real bundle). ADR-0005.
- IF `ARIMA_ROLE` is set THEN the stricter rules apply (it is how a headless run is told apart from a human session). IF it is lost in a headless run the actor is logged `unknown`, never `human` (`actorFor`); the strict agent rules would then not apply, which is why the wrapper always sets it (`childEnv`).
- IF a run is dispatched THEN `assertMayDispatch` first re-checks kill switch and budgets (section 5.6).

## 4. Inputs and input handling (validation, trust)

| Input | Source | Treatment |
| --- | --- | --- |
| Hook payload (tool name, input, cwd) | Claude Code on stdin | parsed; non-object or bad JSON blocks inside a project |
| Shell command strings | agent | tokenised (`parseCommands`: quotes, backslashes, separators, `$()` and parentheses become separate commands, dynamic words flagged); wrappers like `env`, `sudo`, `nohup` unwrapped (`expandCommands`, depth limited); commit-message text blanked before matching (`withoutMessages`) |
| Paths | agent | `canon()`: forward slashes, NUL removed, alternate data stream and trailing dots stripped, `..` resolved, lower-cased |
| Everything an agent writes | files, outbox, report | untrusted until validated (invariant 3); secret scan at each boundary (section 5.4) |
| Environment of the parent | host process | allow-listed, not copied wholesale (section 5.3) |

## 5. Processing steps

### 5.1 Role tool lists (`roles.ts`) `[BUILT]`, enforced by Claude Code permission rules, `--permission-mode dontAsk`

`buildClaudeArgs` passes `--allowedTools allowedTools(role)` and `--disallowedTools deniedTools(role)`. Anything not allowed is denied. Summary (exact lists in code; test `hardstops.test.ts`, `guard-hardening.test.ts` "role allow-list x guard matrix"):

| Role | Writes | Shell and other |
| --- | --- | --- |
| orchestrator | `.arima/**`, `docs/spec/**` | read-only git and gh; scripts `arima-config, -preflight, -ids, -notion, -state, -status` only; WebFetch. Never `arima-pause`, `arima-init` |
| ba | `docs/spec/drafts/**`, outbox | WebFetch |
| ux | `design/**`, outbox | `mcp__playwright__*`, WebFetch |
| architect | `docs/architecture/**`, `api/**`, outbox | WebFetch |
| tech-lead | outbox; `docs/architecture/adr/**` and `docs/engineering/conventions.md` (D-44, WP-219; scoped grant) | read git/gh, `npm test\|run\|ci`, WebFetch. No `gh pr review` or `gh pr comment`: the host posts its findings (F08 RD-F08-1) |
| developer | `Edit`, `Write` (scoped to its worktree or clone; confinement by working directory until WP-190) | read git, `git add\|commit\|switch\|checkout`, `gh pr view`, npm, WebFetch. `git push` and `gh pr create` are removed by WP-111 |
| qa | `tests/**`, outbox | npm, `npx playwright`, `mcp__playwright__*` |
| security | outbox | read git, `npm audit`, WebFetch |
| devops | `infra/**`, `.github/**`, `docs/ops/**` | read git/gh, `git add\|commit`, `gh workflow list\|view`, `npm test\|run build\|run lint`; no `git push`, no Docker daemon access (host scripts run Docker, F06 RD-F06-3) |

Denied for every role: `mcp__*notion*` (ADR-0003), `.env*`, `*.pem`, `*.key` reads and writes, `arima.yaml`, `team.yaml`, `.claude/**`, `.githooks/**`, `.arima/PAUSE`, `.arima/run.lock`, `gh pr merge`, `gh api`, `gh workflow run`, `gh release`, `gh secret`, `gh repo`, `gh auth`; `.github/**` writes denied except devops. No role has `npx` except `npx playwright` for qa.

### 5.2 Guard rules (`guardTool`, `guardBash`, `guardGit`, `guardGh`) `[BUILT]`, enforced for the tools the guard sees

Rule ids and what they stop: `secret-file` (secret paths via file tools, globs that would reach them, and shell mentions of `.env`, keys, `.ssh`, `.aws`, `.npmrc`, `gh/hosts.yml`, `/proc/*/environ`); `secret-env` (referencing token-like env vars, `printenv`, env listing, in bash, PowerShell and cmd forms); `notion-delete` (Notion MCP delete tools; `api.notion.com` DELETE or `in_trash`); `protected-state` (write tools on `.arima/` except top-level `outbox/*.json`; shell writes touching `.arima/`; `--allow-status-writes` from a role); `protected-config` (`arima.yaml`, `team.yaml`, `.claude`, `.githooks`, `.husky`, `.git`, `.mcp.json`, `.npmrc`, `CLAUDE.md`, `.github` except devops; roles only); `kill-switch` (`arima-pause`/`arima-init` from a role); `vcs` (no `--no-verify`, no dangerous `-c` keys or `git config` for hooks, aliases, credentials, remotes; push needs explicit remote and branch, only `-u`, never `main|master|trunk` or the configured default branch; agents only branches `feat|fix|hotfix|chore|docs/...`; no remote changes; `gh pr merge`, `gh api` writes, `gh workflow run`, `gh release|secret|repo|auth` blocked).

### 5.3 Child environment (`childEnv`, `run-agent.ts`) `[BUILT]`, enforced for the child process

Allow-list of names (PATH, home and profile, temp, locale, proxies, certificate paths, a few XDG and display variables) plus prefixes `LC_`, `CLAUDE_`, `OTEL_`. `ANTHROPIC_*` only when `runtime.auth: api_key`. The Notion token only for the orchestrator (`mayHoldNotionToken`). The GitHub token (as its own name and as `GH_TOKEN`) for developer, tech-lead and devops (`mayHoldGithubToken`) today; WP-111 changes this to nobody (only the host scripts hold it, D-37, RD-F09-5). Always set: `ARIMA_PROJECT_DIR`, `ARIMA_RUN_ID`, `ARIMA_ROLE`, `ARIMA_ITEM`, `OTEL_RESOURCE_ATTRIBUTES`. Escape hatch: a human may name variables in `ARIMA_PASSTHROUGH_ENV` to pass them through as given (`run-agent-cli.ts`), used by tests. Tests: `secrets-dispatch.test.ts` "the child environment is an allow-list".

### 5.4 Secret scanner and allow-list (`lib/secrets.ts`) `[BUILT]`

Patterns: Notion tokens (`ntn_`, `secret_`), GitHub tokens (classic and fine-grained), Anthropic keys (entropy at least 3.4 bits), AWS access keys, private key blocks, Slack, Stripe, Google API keys, JWTs, npm tokens, bearer tokens (entropy at least 3.3), and credential assignments (`api_key=`, `password:` ... with a random-looking value of 20+ characters, entropy at least 3.5). Placeholders (`example`, `your-`, `changeme`, `<...>`) are ignored. The scan also runs on a copy with JSON escapes undone. Findings carry a rule name and a `sha256:` 16-hex fingerprint, never the secret. Heuristic: it prefers false alarms. Applied at: event details (`describe` in `hooks.ts`, withheld if secret-like), run report (`writeRunReport`), outbox `enqueue` and push, `arima-init` brief (exit 6), state push (staged files, 64 MB cap). Allow-list: `.arima/secret-allowlist.txt`, one fingerprint per line; written by a human only (guard protects `.arima/`); **honoured only by the state push today**; WP-104 makes one function (`findSecretsAllowed`) honour it at every scan point: outbox enqueue and push, init, run report, state push (RD-F09-4). Not applied: files an agent writes into the product repo or the PR (CI secret scan is a spec 10.3 requirement, not built; F08 adds a diff scan at publish) `[SPEC]`.

### 5.5 Public-remote refusal (`pushState`, `checkRemotePrivacy`) `[BUILT]`

Before pushing `arima-state`: `gh repo view <owner/repo> --json isPrivate`. Public: refuse. Unknown (gh missing or signed out, URL unparseable, github.com URL with odd characters): refuse. Both bypassed only by `github.allow_public_state: true`. A remote that is not github.com is **refused** unless `github.allow_unchecked_remote: true` is set by the owner (RD-F09-6, WP-111; today it is pushed unchecked). No remote: commit locally and warn. Tests: `state-privacy.test.ts`.

### 5.6 Kill switch, three sources (`killswitch.ts`, `preflight.ts`, `run-agent.ts`) `[BUILT]`

Sources: the "Pause ARIMA" to-do on the Notion root page; `.arima/PAUSE`; `PAUSE` on the remote state branch (fetched with a 15 s timeout, no prompts, only when the file is absent and Notion could not answer). ON when: file present; Notion to-do checked; Notion to-do missing (a deleted switch must not mean running); remote state PAUSE present; or Notion is unreachable and the remote could not be read (D-39, S18, `judge4.test.ts`). Checked in `runPreflight` (exit 12) and again in `assertMayDispatch` before every `claude` spawn (exit 12, event `hardstop.hit` with stop `kill_switch`); **during a run** (RD-F09-2, WP-120): the PreToolUse guard blocks every tool call once `.arima/PAUSE` exists (a single file-exists check, no network), and the run wrapper polls all three sources every 30 s and kills the process tree when the switch turns on (result `paused`, reason `kill_switch`); budget exhaustion there gives exit 13 and `hardstop.hit` stop `budget_exceeded`. Pause sets whichever of Notion or file it can (F01).

### 5.7 Hard-stop registry (`hardstops.ts`) `[BUILT]` as ids; enforcement varies

Sixteen ids, fixed in code; `autonomy.hard_stops` in `arima.yaml` is documentation and the validator warns when it differs (`config.ts`, D-42). Enforcement today:

| Id | Enforced now | By |
| --- | --- | --- |
| `kill_switch` | yes | preflight, dispatch re-check |
| `budget_exceeded` | yes | preflight check, dispatch re-check |
| `notion_delete` | yes | no delete op (`outbox.schema.json`), guard, tool deny |
| `secrets_change` | enforced for tools the guard sees; advisory for scripts | guard, deny rules, env allow-list |
| `missing_credential` | partly | preflight env check, exit 14; `hardstop.hit` recorded by WP-120 (G-11) |
| `G0`..`G4` | partly | human-only gate fields in outbox; gate logic and approver check `[SPEC]` WP-330 |
| `story_budget` | no | WP-105 |
| `prod_deploy` | no (no deploy script) | WP-213 stub, WP-402 |
| `prod_data_migration`, `new_paid_service`, `licence`, `critical_finding` | no | WP-404 |

Only `kill_switch` and `budget_exceeded` are ever written to `hardstop.hit` (`run-agent.ts:362`). Test: `hardstop-ids.test.ts`.

## 6. Outputs and side effects

Events: `tool.blocked` (rule and reason; permission-rule refusals via PermissionDenied), `tool.used` (state-changing tools; read-only shell skipped), `agent.stop`, `hardstop.hit`, `preflight.fail`, `budget.alert`. Event logging is capped at 1.5 s so a held lock cannot delay a block (`log()` in `hooks.ts`). Exit 2 with a plain reason on stderr is the block. Run report `.arima/runs/<run_id>.json` is scanned before writing.

## 7. Exit codes

| Script | Codes | Registry |
| --- | --- | --- |
| `arima-hook` | 0 allow, 2 block, 1 usage | listed |
| `guard.sh` | 0 or 2 only (any other code from the bundle becomes 2 inside a project) | consistent |
| `arima-preflight` | 0, 2, 10 config, 11 locked, 12 kill switch, 13 budget, 14 environment | listed |
| `arima-run-agent` | 0, 1, 2, 3, 12, 13, 75 | listed |
| `arima-preflight` with sandbox | docker not running: 14 with check name `docker` | PROPOSED (WP-190) |
| `arima-state` push to an unchecked remote | 1 (refused, the existing failure code) | `[BUILT]` code, new reason `remote_unchecked` (WP-111) |

## 8. Conditions and rules

Advisory versus enforced, plainly:
- **Enforced:** hard-stop ids and `hardstop.hit` for kill switch and budget; Notion delete (no op exists); human-only fields in the outbox; secrets into Notion, events, run report and state commits; state branch to public or unknown GitHub remote; child environment contents; guard fail-closed inside a project.
- **Advisory** (works only while the agent uses tools the guard parses): a developer or QA run that writes and runs its own script can read files the guard lists by path but not by other means, use ambient credentials (OS credential store, `gh` keyring), edit files outside its worktree (the developer's `Edit` and `Write` carry no path scope; confinement is by working directory only), or call the network (`WebFetch` and `mcp__playwright__*` are unrestricted). `npm run` executes arbitrary scripts. Compensating controls: branch protection on the default branch, no push credential (WP-111), CI, human PR review, the sandbox (WP-190).
- **Cannot be removed by configuration:** the hard-stop list, the guard (hooks load from the plugin, and `--plugin-dir` in `buildClaudeArgs` loads it explicitly).

## 9. Failure handling

| Failure | Result |
| --- | --- |
| Guard crashes or Node missing inside a project | block (exit 2), message to ask the human |
| Guard slow past the 10 s hook timeout | Claude Code treats a timed-out hook as non-blocking unless `onFailure: block` (ADR-0005); the guard does no network or model work, and a held event lock cannot delay it (`guard-hardening.test.ts`); `hooks.json` sets no `onFailure` (verified in the WP-191 smoke run, RD-F09-3) |
| Audit write fails | session continues; line lost (fail open by design) |
| Notion unreachable | other kill-switch sources decide; none readable means paused |
| Secret found at a boundary | refuse that write; name the rule and fingerprint, never the value |
| Usage limit hit | run result `paused`, exit 75 |

## 10. Tests and verification

Existing: `hooks.test.ts`, `hardstops.test.ts`, `hardstop-ids.test.ts`, `guard-hardening.test.ts` (launcher, bundle, bypass corpus, role x guard matrix, case and traversal), `secrets-dispatch.test.ts`, `state-privacy.test.ts`, `killswitch-hardening.test.ts`, `dispatch-recheck.test.ts`, `preflight.test.ts`, `run-agent.test.ts`, `killtree.test.ts`, `judge4.test.ts`, `packaging.test.ts`. Independent reviews: `docs/process/reviews/2026-11-18-judge-2.md`, `-judge-3.md`.

To write: a test that proves the allow-list is advisory for scripts (control) and is closed by the sandbox once built; `status` honours the kill switch (F01); `hardstop.hit` for `missing_credential`; the allow-list is honoured at every scan point (WP-104); a test that a pause during a run blocks the next tool call and ends the run with `paused` (RD-F09-2, WP-120); role lists contain no `git push`, no `gh pr review` or `comment`, no Docker (WP-111, WP-212, WP-213); a non-GitHub remote is refused without the config flag (WP-111); sandbox tests below.

## 11. Dependencies

WP-004, WP-005 (done). Not yet done: WP-103 (report collector), WP-111 (credentials), WP-190 (sandbox; deps WP-103, WP-111), WP-105, WP-330, WP-402, WP-404. Gate U (`02-stages.md`) requires WP-190 before any unattended run (D-41).

## 12. Status, the sandbox design (WP-190) and resolved decisions

**Sandbox, from ADR-0006 `[SPEC]`, design only, no code, no config key** (`runtime.sandbox` appears in no schema or source file):
- New key `runtime.sandbox: docker | none`, default `none`. With `docker`, `arima-run-agent` starts the headless `claude -p` run inside a Docker sandbox. With `none`, runs stay on the host and every guide keeps calling local layers advisory.
- The container gets: a per-run local **clone** of the repository (read-write; not a linked worktree, RD-F08-9), the plugin folder (read-only), a scrubbed environment with the role tokens only (none for GitHub, none for Notion unless the role is the orchestrator, which stays on the host), and no push credential (S16). It never gets `~/.config/arima`, `~/.claude` credentials, the main checkout, the Docker socket, or any `production` Compose resource.
- Authentication: a long-lived token from `claude setup-token`, kept on the host as `CLAUDE_CODE_OAUTH_TOKEN` in `~/.config/arima/env`, passed only to the container process, never written to the repo or printed.
- Preflight runs `docker info` and refuses to dispatch a sandboxed role if Docker is down (exit 14, check `docker`).
- Network: egress through an allow-list proxy container that permits the Anthropic API, the package registry and the local preview host only (RD-F09-8).
- Acceptance (`work-packages.yaml` WP-190): a role run sees only its clone; `git commit` works inside; no push credential or Notion token inside; preflight refuses if Docker is not running. Tests `sandbox.test.ts` plus a live check.

Status: layers 5.1 to 5.7 `[BUILT]`; sandbox `[SPEC]`; credential removal `[SPEC]` (WP-111). Decided under `09-owner-decisions.md`:

| Decision | Reason | Implemented by |
| --- | --- | --- |
| RD-F09-1: sandboxed roles work in a per-run local clone, not a mounted linked worktree; the host fetches the branch from the clone to publish | A linked worktree `.git` file points into the main `.git`; the container cannot commit without seeing it (G-14). Needs an ADR-0006 amendment (proposed, owner confirms at J1) | WP-190, WP-110 |
| RD-F09-2: kill switch during a run: the guard blocks every tool call once `.arima/PAUSE` exists; the wrapper polls the three sources every 30 s and kills the tree; spec 11.1 wording is kept ("exits immediately") because this makes it true | Closes the in-flight gap (G-04) | WP-120 (wrapper), guard change in `hooks.ts` with a test, WP-103 (result mapping) |
| RD-F09-3: hook failure semantics: `hooks.json` keeps the fail-closed launcher; the real smoke run of WP-191 includes a deliberately slow hook to see what Claude Code does on timeout, and the guard sets `onFailure: block` if the current hooks documentation has that key; the finding is recorded in the package review | CLAUDE.md: verify plugin keys against the docs before use; no key is invented here | WP-191 |
| RD-F09-4: the secret allow-list is honoured at every scan point through one function | Consistency (G-09); the file stays human-written | WP-104 |
| RD-F09-5: no role holds a GitHub token or a push command; `roles.ts` and `mayHoldGithubToken` change | D-37 (G-05) | WP-111 |
| RD-F09-6: a non-GitHub remote is refused unless `github.allow_unchecked_remote: true` | Privacy cannot be checked elsewhere | WP-111 |
| RD-F09-7: spec 11.1 text becomes "sixteen hard stops" and the comment in `hardstop-ids.test.ts` is corrected; spec 11.2 is aligned to `roles.ts` with these changes: devops and security gain `npm test` and `npm run build\|lint`; orchestrator and ux gain none (the host runs builds); nobody merges or tags (host scripts) | D-42, D-38; each agent gets what its whole job needs and no more (09 section 1) | spec edit; WP-213, WP-313; `hardstop-ids.test.ts` |
| RD-F09-8: sandbox network policy v1 is an egress proxy container with a domain allow-list (Anthropic API, npm registry, `host.docker.internal` preview ports); Windows path mapping uses the WSL 2 file system for clones; container start cost is measured in the WP-190 smoke and recorded | Needed before Gate U; not before Stage 2 exit | WP-190 |
| RD-F09-9: ADR-0005 is confirmed Accepted by the owner at checkpoint J1 (the guard is built and tested); `agents/orchestrator.md` lines 21 and 25 are corrected, since init and pause are human skills (G-08) | Closes the status discrepancy without blocking work | J1 checkpoint (Stage 1 exit criterion 5), WP-102 |
| RD-F09-10: devops runs no Docker against the daemon; staging, preview and production run through host scripts (F06, F08) | Daemon access would reach the production project on the same machine | WP-213, WP-218, WP-402 |
| RD-F09-11: the OS credential store and `gh` keyring stay reachable by a role script until the sandbox exists; the interim control is the empty per-run home (F08 RD-F08-2), and the documentation keeps calling the local layers advisory | Honest limit (D-36) | WP-111, WP-190 |

**OWNER (Gate U only, not blocking Stage 1 or 2):** seat terms and billing for unattended or scheduled runs (S15) are a money and terms matter; the owner confirms them at Gate U before WP-230 (`02-stages.md` section 5). Nothing else in this feature needs the owner.
