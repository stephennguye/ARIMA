# Feature spec F08: git engine (worktree manager, host publish, merge, PR template and commit hook)

> Status: planned; none of the four scripts exists. Work packages: WP-110 (worktree manager), WP-111 (host publish script), WP-112 (merge script), WP-113 (PR template and ID-in-commit hook). Spec: 2 (ID rule), 10.2, 10.3, 11.1, 11.2, 11.3, 5.7, 5.6. Contracts: `03-contracts.md` sections 7, 8, 9. Decisions: D-21, D-29, D-30, D-37, D-38, S4, S9, S16, S6 (Windows), ADR-0006.
>
> Tags: `[BUILT]` exists and tested; `[SPEC]` required by the spec, not built; `[PROPOSED]` introduced here and frozen by the named WP. Everything below the "Built today" list is `[SPEC]` or `[PROPOSED]`.

## 1. Purpose and spec refs

Give every role run its own branch and worktree, and make exactly two host-side scripts the only code that talks to GitHub with write power: one pushes the story branch and opens the pull request, one merges (D-37, D-38, S4, S16). No agent holds a push credential and none merges; GitHub Free private repos have no branch protection or required reviewers, so ARIMA enforces this itself (spec 10.3, D-29). Good means: a developer run cannot reach the default branch even by writing its own script, and a merge happens only with CI green, QA passed and the human's approving review.

Built today (the parts this feature builds on):
- Guard rules for `git` and `gh` (`hooks.ts` `guardGit`, `guardGh`): no `--no-verify`, no dangerous `-c` keys, push needs explicit `remote branch`, only `-u`, never `main`, `master`, `trunk` or the configured default branch, agents only `feat|fix|hotfix|chore|docs/...` branches, `gh pr merge` and `gh api` writes blocked. `[BUILT]`, tests `hardstops.test.ts`.
- `.arima/` as a git worktree of the orphan `arima-state` branch (`state.ts` `ensureWorktree`), secret-scanned commits, private-remote-only push. `[BUILT]`.
- `killTree` (taskkill `/T /F` on Windows) (`run-agent.ts`, `killtree.test.ts`). `[BUILT]`.
- Interim state: `roles.ts` still grants `git push` and `gh pr create` to developer (lines 136-137), `git push` to devops (line 166), and `mayHoldGithubToken` is true for developer, tech-lead and devops (line 215). The role lists change in WP-111.

## 2. Command or entry point and arguments

| Component | Entry point `[PROPOSED]` | Arguments | Run by |
| --- | --- | --- | --- |
| Worktree manager (WP-110) | library `worktree.ts` plus `arima-worktree create\|remove\|list\|prune` | `--branch`, `--base`, `--run-id`, `--project` | dispatcher (WP-120); never a role |
| Host publish (WP-111) | `arima-publish` | `--run-id`, `--item`, `--branch`, `--project`, `--dry-run` | orchestrator session after a valid agent report |
| Merge (WP-112) | `arima-merge` | `--pr <n>` (or `--item <US-nnn>`), `--project`, `--dry-run` | orchestrator session only |
| PR template and hook (WP-113) | `.github/pull_request_template.md`, `.githooks/commit-msg`, a PR-body validator | n/a | installed in the app repo by `/arima:setup` (WP-214) |

Roles are denied all three: `allowedTools` lists no `arima-publish`, `arima-merge` or `arima-worktree` (the orchestrator list names scripts one by one; the new names are added only for the orchestrator). The GitHub token variable (`github.machine_token_env`) is passed to the publish and merge processes only.

## 3. Preconditions (IF/THEN)

- IF the kill switch is on THEN publish and merge refuse (`checkKillSwitch`, exit 12), because a hard stop must "exit immediately" (spec 11.1). `[PROPOSED]` Open: OD-F08-5.
- IF the item is not in the state the transition table requires THEN refuse: publish only for `In Progress` with a valid report; merge only for `In QA` (contracts section 9). Depends on WP-107.
- IF `github.machine_token_env` is unset in the host environment THEN refuse with exit 14 (preflight already requires it, `preflight.ts:168`).
- IF the branch name does not match `feat|fix|hotfix|chore|docs/<ID>-slug`, or equals the default branch THEN refuse push (reuse the `AGENT_BRANCH` pattern in `hooks.ts:245`).
- IF CI is not green, or QA has not passed, or no human approving review exists on the current head commit THEN `arima-merge` exits 30 and merges nothing.

## 4. Inputs and input handling (validation, trust)

| Input | Source | Validation | Trust |
| --- | --- | --- | --- |
| Branch and commits | the role's worktree | name pattern; diff checked against protected paths and secrets before pushing | Untrusted (agent output) |
| Agent report (`criteria_map`, `summary`) | `.arima/runs/<run_id>.report.json` (WP-103) | schema-valid; `done` status | Untrusted text; goes into the PR body |
| PR body and title | rendered by the script from the template and report | secret scan; length cap; `@` mentions neutralised (GitHub notifies any `@name`) | Untrusted |
| Remote URL | `arima.yaml` `github.repo`, not the worktree's `.git/config` | slug pattern (as `githubSlug`, `state.ts`) | Trusted config |
| CI and review facts | GitHub API (`gh pr checks --json`, `gh pr view --json reviews,headRefOid`) | read fresh at merge time; compare review commit to head sha | Data |
| QA result | Notion mirror (story and test case `Last result`) after a fresh `pull`, plus QA's validated report | all test cases `Pass`; story `In QA` | Data |
| Approver identity | `team.yaml` `people.<name>.github` (`schemas/team.schema.json`) | reviewer login must belong to a human with the approving role; not the machine account | Trusted config |

Not read: other worktrees, the main checkout's uncommitted files, anything in `.arima/` except the run report.

## 5. Processing steps

### 5.1 Worktree manager (WP-110)

1. Compute path `../<repo>-wt/<branch>` (spec 10.2) beside the project, branch from the item (`feat/US-112-slug`); slug limited to ASCII and 40 characters.
2. `git worktree add -b <branch> <path> <base>` from the base commit; verify clean tree at the expected base. **STOP** if the path exists with another branch, or the branch exists unexpectedly.
3. Exclude the `.arima/` state worktree from list and prune (`git worktree list --porcelain`).
4. Remove: kill any leftover process tree first, then `git worktree remove --force` with retry and backoff; `git worktree prune`. Crash cleanup: on dispatcher start, remove worktrees whose run has no live lock or ledger row.

### 5.2 Publish (WP-111)

1. Check kill switch, item state, valid report. **STOP** otherwise.
2. In the worktree: confirm HEAD is on the expected branch, tree clean (agents commit; the script does not).
3. Diff against the base: **STOP exit 31** if it touches protected paths (`.github/` unless role devops, hooks, `arima.yaml`, `team.yaml`, `.claude/`, `.git/`; `isProtectedConfigPath`) or `scanSecrets` finds a secret. This closes the gap that file tools are guarded but scripts the agent ran are not.
4. Push `<branch>:<branch>` to the URL built from config, fast-forward only (no force). Token supplied only in this process's environment (for example through `GH_TOKEN` and a one-off credential helper). **STOP exit 32** if GitHub refuses.
5. If a PR already exists for the head branch, update its body; else `gh pr create` with title `<ID>: <title>`, body from the template, labels `role:<agent>`, `type:story|bug|hotfix|chore` (spec 10.2). Idempotent.
6. Record event `pr.published` (PROPOSED, new type, schema and registry in WP-111) with PR number and head sha; write the PR link to the outbox for the story's `PR link`.

### 5.3 Merge (WP-112)

1. Check kill switch. Refresh the Notion mirror.
2. Gather four facts: required CI checks all success on the head sha (spec 10.3 list); the story is `In QA` with every test case `Pass` and, for UI stories, design QA passed (contracts section 9); the tech-lead verdict is `approve` (spec 10.3 names it, see OD-F08-4); at least one review in state APPROVED by a listed human, whose commit equals the current head sha, and who is not the machine account.
3. IF any is missing THEN **STOP exit 30**, naming each missing condition, event `merge.refused` (PROPOSED in contracts section 5).
4. `gh pr merge --squash --match-head-commit <sha>` (squash only, linear history; `--match-head-commit` makes a push after the checks a refusal, not a merge of unreviewed code; flag availability to verify against current `gh`).
5. Event `merge.done`; engine moves the story `In QA` to `PO Acceptance` (WP-107/108); remove the worktree; devops staging deploy follows (WP-213).

### 5.4 PR template and commit hook (WP-113)

- `pull_request_template.md` sections (spec 10.2): linked items; acceptance-criteria mapping (criterion, code, test); screenshots for UI; risk and rollback; DoD checklist. A validator checks the rendered body has every section and that every criterion in `criteria_map` appears (the "DoD check before ready").
- `commit-msg` hook: on `feat/`, `fix/`, `hotfix/` branches the subject must match Conventional Commits with the item id as scope, for example `feat(US-112): ...` (ids US, BUG, INC, CR; spec 2). Exempt per S9 (accepted): `chore/`, `docs/`, dependency PRs, release commits, `arima-state`; these must still carry a run id (`r-YYYYMMDD-HHMM-NN`) or an ADR or task id. `chore(state): run r-...` (`state.ts`) already complies. A CI check repeats the rule on PR titles, because a hook alone can be skipped and `core.hooksPath` is local. Agents cannot edit `.githooks/` or git config (`isProtectedConfigPath`, `DANGEROUS_GIT_KEY`).

## 6. Outputs and side effects

| Output | Where | Written by |
| --- | --- | --- |
| Worktree directory and branch | `../<repo>-wt/<branch>` | worktree manager |
| Remote branch, pull request, labels | GitHub | publish |
| Merge commit (squash) on the default branch | GitHub | merge |
| Events `pr.published`, `merge.done`, `merge.refused` (and `tool.blocked` from the guard) | `.arima/events.jsonl` | scripts |
| Outbox entries: story `PR link`; `Status` only by the engine | `.arima/outbox/` | orchestrator |
| Ledger | no row: these are not model runs; cost 0 (OD-F08-6) | n/a |

## 7. Exit codes

Registry (`03-contracts.md` section 8) reserves only `arima-merge` 0 merged, 30 refused. All others below are PROPOSED and added to the registry by the WP that builds them.

| Script | Code | Meaning | Status |
| --- | --- | --- | --- |
| `arima-worktree` | 0 / 1 / 2 | ok / git failure / usage | PROPOSED (WP-110) |
| `arima-publish` | 0 | pushed and PR opened or updated | PROPOSED (WP-111) |
| | 2 / 12 / 14 | usage / kill switch / missing token | PROPOSED, same meaning as preflight |
| | 31 | refused by policy (branch, protected path, secret) | PROPOSED |
| | 32 | GitHub or network failure | PROPOSED |
| `arima-merge` | 0 | merged | reserved in registry |
| | 30 | refused: CI, QA or human review missing | reserved in registry |
| | 2 / 12 / 32 | usage / kill switch / GitHub failure or head changed | PROPOSED |

## 8. Conditions and rules

- Separation of duties: developer never reviews or merges; tech-lead reviews and cannot push or merge; the human approves on GitHub from their own account (D-30); the machine account opens PRs.
- Profile: the same merge conditions in all three profiles (`profiles/*.yaml` change only gates). Review queue limit `review.max_prs_awaiting_human` (spec 10.3, D-21) is applied by the queue (WP-109), not here.
- Hard stops involved: kill switch, G-gates (not merged past an unapproved gate), `critical_finding` (merge blocked while an open critical finding has no accepted risk, WP-404), `secrets_change`.
- Enforcement honesty: until the Docker sandbox exists (WP-190), a developer or QA run can run its own scripts; ambient credentials of the human (git credential manager, `gh` keyring, `~/.config/gh/hosts.yml`) are not removed by "role env contains no GitHub token". The guard blocks reading `.config/gh/hosts.yml` but not the OS credential store. See OD-F08-2.
- Windows considerations (spec S6, D-15, D-36):
  - Path length: `..\<repo>-wt\feat\US-112-slug` plus `node_modules` can exceed 260 characters; set `core.longpaths true` for the worktree and recommend `LongPathsEnabled`; keep the slug short; test with a deep path (WP-110 acceptance "Windows long paths").
  - Branch names contain `/`, so the worktree path is nested; handle `\` versus `/` through `path`, pass `git -C <path>`, and compare paths with `canon()` (`hooks.ts`, lower-cased for case-insensitive file systems).
  - Open handles: a killed `claude` tree or antivirus can lock files, so removal retries; call `killTree` first (`taskkill /T`).
  - Mixed git: a worktree created by Windows git has an absolute `gitdir: D:/...` pointer that WSL git cannot follow, and `/mnt/d` is slow. Use one environment per project; the attended default is native Windows (S6).
  - Hooks run through Git Bash (ADR-0005 assumption); `.githooks/commit-msg` must be POSIX `sh`; set `.gitattributes` `eol=lf` for it (OD-F08-7).
  - Line endings: `core.autocrlf` noise in diffs would confuse the size limits (spec 7.1); app repos should carry `.gitattributes`.

## 9. Failure handling

| Failure | Result | State left |
| --- | --- | --- |
| Push refused by GitHub (non fast-forward, auth) | exit 32; event; item stays In Progress | branch unchanged; safe to re-run |
| PR exists already | body updated, exit 0 | none |
| Protected path or secret in diff | exit 31; unit fails like an invalid report (`01-architecture.md` section 7); attempt counts | nothing pushed |
| Merge refused | exit 30 listing missing conditions | PR untouched, story stays In QA "Awaiting you" |
| Head sha changed between checks and merge | exit 32, nothing merged | re-check on next run |
| Worktree remove fails | retried; leftover reported; pruned on next dispatcher start | directory may remain |
| Crash after push, before PR | next publish finds the pushed branch and creates the PR | idempotent |

## 10. Tests and verification

Existing: `hardstops.test.ts` (role lists, git and gh guard rules, default branch from `arima.yaml`), `guard-hardening.test.ts` (bypass corpus), `state.test.ts` (real git worktree, push never touches main), `killtree.test.ts`.

To write (all on real temporary repositories with a local bare repository as remote and a stub `gh` executable, like `fixtures/stub-claude.mjs`; run on Windows and Linux CI, `02-stages.md` section 4 condition): `worktree.test.ts` (create, remove, crash cleanup, deep path, `.arima` excluded); `publish.test.ts` (role env has no GitHub token, push to default refused, protected path and secret refused, second publish updates not duplicates, real PR opened on the dev project once); `merge.test.ts` (one test per missing condition returns 30, stale approval refused, machine-account approval refused, no agent role can merge, merge with all four present); `commit-hook.test.ts` (S9 exemptions, `chore(state)` accepted); a test that `allowedTools` for every role contains none of the new scripts and no `git push`.

## 11. Dependencies

WP-110 (deps WP-001); WP-111 (WP-110, WP-005); WP-112 (WP-111, WP-107); WP-113 (WP-111). Feeds WP-120, WP-190 (the container has no route to GitHub), WP-210, WP-212, WP-213. Needs WP-103 (report), WP-101 (event additions).

## 12. Status and open decisions

All `[SPEC]`/`[PROPOSED]`. Open decisions and discrepancies:
- OD-F08-1: how the tech-lead posts review comments (`gh pr review`/`comment` need a token, `roles.ts` tech-lead list) once agents hold no credential: host posts the verdict from the validated report, or a separate token scoped to pull-request comments only (fine-grained token permissions to be verified).
- OD-F08-2: ambient human credentials on the host (Credential Manager, `gh` keyring) are reachable from an agent script until WP-190; decide the interim control.
- OD-F08-3: which human roles count as "the human" (`po`, `sponsor`) for the approving review.
- OD-F08-4: spec 10.3 lists four merge conditions (green checks, tech-lead review, QA pass, human approval) but D-38, S4 and WP-112 list three. This spec checks all four; confirm.
- OD-F08-5: kill switch blocks publish and merge (proposed yes).
- OD-F08-6: ledger row for non-model scripts (proposed none).
- OD-F08-7: location and installation of `.gitattributes` and `core.hooksPath` (`/arima:setup`, WP-214).
- Discrepancy: `03-contracts.md` section 7 says the GitHub token goes to "roles allowed to hold it"; code gives it to developer, tech-lead and devops (`roles.ts:215`), contradicting D-37 until WP-111 lands.
