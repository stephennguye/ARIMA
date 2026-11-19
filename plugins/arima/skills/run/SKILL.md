---
name: run
description: Run ARIMA's daily build loop (Phase 4 and operations only) - plan the day, dispatch the role agents, apply your Notion answers, publish and merge, and keep the cost log. Use --dry-run to see the plan first.
argument-hint: "[--dry-run] [--only <item>]"
disable-model-invocation: true
allowed-tools: Read Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-dispatch.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-status.mjs *)
---

Run the daily loop for the project in the current directory. This spends money (estimated consumption on the seat), so only run it when the user asked for it.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-dispatch.mjs" --dry-run $ARGUMENTS` first and show the plan: each unit with its rank, kind, role and item, and what was skipped and why. This writes nothing.
2. If the plan is empty or the user only wanted the plan, stop here.
3. In `assisted` mode (`autonomy.mode` in `arima.yaml`) ask the user to confirm the plan, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-dispatch.mjs" $ARGUMENTS --yes-plan <hash>` with the hash from step 1. In `autonomous` mode run it without `--dry-run` once the user said to go. Never pass `--yes-plan` without showing the plan.
4. Read the exit code:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | The run finished | Show the summary and the warnings. Tell the user what is waiting for them in Notion (questions, pull requests to approve). |
| 1 | The run finished but the Notion push or state save failed | Say so plainly; the outbox is kept and goes out next time. |
| 2 | Bad arguments, or the plan changed since it was confirmed | Show the message. |
| 4 | Nothing to do (nothing Ready, everything Blocked, or the review queue is full) | Say which, from the skipped list. |
| 5 | Not in Phase 4 or operations | Show the command it names (`/arima:setup`, `/arima:design`, `/arima:release`). Do not try to start anyway. |
| 10 | Config invalid | Show the `file:line` errors. |
| 11 | Another run holds the lock | Tell the user; never remove the lock. |
| 12 | The kill switch is on | Tell the user ARIMA is paused; `/arima:pause --resume` resumes it. |
| 13 | A budget is used up | Say which cap; the sponsor raises it or waits. |
| 14 | An environment variable is missing | Name it (never its value). |
| 75 | The seat's usage limit was reached | The rest of the plan waits for the next run. |

Next command: `/arima:status`.
