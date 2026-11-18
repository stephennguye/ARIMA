# Installing ARIMA (v0.1)

This takes you from nothing to a working `/arima:status` on a new project. It assumes you can use a terminal and have a Claude Code account.

## 1. What you need

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 22 or newer (LTS) | `node --version` |
| git | any recent | `git --version` |
| GitHub CLI | any recent, signed in | `gh auth status` |
| Claude Code | current | `claude --version` |
| A Notion account | Free plan is enough for one project | |

ARIMA runs on **Windows (PowerShell or Git Bash), macOS and Linux**. WSL 2 also works and is what the spec recommends once scheduled runs arrive in v0.2, because Claude Code's sandboxed command execution is supported there. Nothing in v0.1 needs WSL.

Sign in to Claude Code once, interactively (`claude`). ARIMA's headless runs draw on that account's usage limits; they never use an API key unless you configure one (`runtime.auth` in `arima.yaml`).

## 2. Install the plugin

In Claude Code:

```
/plugin marketplace add stephennguye/ARIMA
/plugin install arima@arima
```

Check it loaded: `/plugin` should list `arima`, and `/arima:status` should appear in the command list. If `/plugin` shows an Errors tab entry for `arima`, fix that first.

## 3. Connect Notion

ARIMA reads and writes Notion through its own scripts with an **integration token**. It does not use a Notion MCP server.

1. Go to <https://www.notion.so/profile/integrations> and create an **internal** integration. Give it read, update and insert content capabilities. Copy its token (it starts with `ntn_` or `secret_`).
2. In Notion, create an empty page for the project, for example "Tasty App". Open it, choose **Connections** and add your integration. This page is the **root page**.
3. Put the root page's ID somewhere handy: it is the 32-character string at the end of the page URL.
4. Build the ARIMA workspace on that page. Until the public template is published, ARIMA builds it for you:

   ```
   node "<plugin>/scripts/dist/arima-notion.mjs" bootstrap --parent <root page id>
   ```

   (`<plugin>` is the plugin folder; `/plugin` shows where it is installed.) This creates the 19 databases, their relations, formulas and rollups. It is safe to run twice. It prints a short list of steps to do by hand if Notion refused anything; see [NOTION-TEMPLATE.md](NOTION-TEMPLATE.md) for those and for the views.

   Once a template is published you can instead duplicate it into your workspace, share the duplicate with your integration, and use that page as the root page.

### Keep the token out of your repo and your chat

Set it as an environment variable. Never paste it into Claude, a file in the repo, or Notion.

- **PowerShell (Windows)**, persistent for your user:

  ```
  [Environment]::SetEnvironmentVariable("ARIMA_NOTION_TOKEN", "<token>", "User")
  ```

  Open a new terminal afterwards.
- **macOS, Linux, WSL, Git Bash**: put `export ARIMA_NOTION_TOKEN=<token>` in a file only you can read (for example `~/.config/arima/env`, `chmod 600`) and `source` it from your shell profile.

Agents are not given this token: only the orchestrator's environment has it, and ARIMA's hooks block reading that file or printing the variable.

## 4. Set up the project

Create (or open) the git repository for your app and open Claude Code in it. A repository needs a first commit before ARIMA can save its state.

Write a project brief, or let `/arima:init` interview you for one. A brief has seven sections: Problem, Target users, Goals and KPIs, Must-have features, Out of scope, Constraints, Known risks (`examples/brief.md` is a sample).

Then:

```
/arima:init brief.md
```

If `arima.yaml` and `team.yaml` do not exist yet, it copies the examples and asks you for the project key, name, client, profile, repo, your name and Notion user ID, and the root page ID. It then:

1. checks the brief and asks you to fill any gaps;
2. validates the configuration;
3. checks the kill switch, the budget and that no other run is active;
4. maps your Notion workspace;
5. writes the project brief, a charter skeleton, the budget plan and the gate pages (G0 to G4, or G1 and G3 for the `solo-lite` profile);
6. records the run in `.arima/ledger.jsonl` and `.arima/events.jsonl` and commits them to the `arima-state` branch.

Afterwards, in Notion, set **Approvers** on each gate page. ARIMA never writes that field.

## 5. Check it works

```
/arima:status
```

You should see the project name, `Phase: 0 Initiation`, each gate as `Not ready`, an empty board, and the budget at zero.

`/arima:pause` stops ARIMA at its next preflight and `/arima:pause --resume` lets it run again.

## Troubleshooting

Run the scripts directly to see exact messages. Preflight and init share these exit codes:

| Exit | Meaning | Fix |
| --- | --- | --- |
| 2 | Usage error, or the Notion token variable is not set | Set `ARIMA_NOTION_TOKEN` in the shell that starts Claude Code, then restart it |
| 3 | The brief has gaps | Fill the sections the message lists (write "None" where there is nothing) |
| 4 | The Notion workspace does not match the template | `arima-notion map --migrate` adds missing properties; anything else you must fix in Notion |
| 5 | Some Notion writes did not apply | Run `/arima:init` again; it finishes what is missing |
| 10 | `arima.yaml` or `team.yaml` is invalid | The message gives `file:line`; `arima-config validate` re-checks |
| 11 | Another run holds `.arima/run.lock` | Wait for it; a lock from a crashed run is replaced automatically after `max_run_minutes` plus 30 |
| 12 | The kill switch is on | `/arima:pause --resume`; also untick "Pause ARIMA" on the Notion root page |
| 13 | The daily or project budget is used up | Raise `budget` in `arima.yaml` or wait for tomorrow |
| 14 | A required environment variable is missing | The message names it |

Other problems:

- **"git repository" errors from state saving**: `.arima/` is kept on an orphan `arima-state` branch of your app repo, so the project folder must be the root of a git repository with at least one commit. Add a remote and `arima-state push --run-id <id>` to publish it.
- **ARIMA seems to ignore a file**: its guard hooks block reading `.env*`, key files and credential files, and writing the Notion mirror and logs. That is intentional.

## Billing and limits

ARIMA's budgets are estimates of consumption, not money spent, when you use a Claude seat. If the seat's usage limit is reached, a run stops cleanly and is recorded as paused, not failed. Usage credits stay off unless you set `runtime.allow_usage_credits: true`.

## What is not here yet

Daily scheduled runs, the build loop and the other agents arrive in v0.2 and later; see `docs/BUILD-PLAN.md`.
