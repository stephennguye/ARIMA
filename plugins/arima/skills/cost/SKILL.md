---
name: cost
description: Show what the project has cost so far - per story, role and phase, estimate accuracy by size, rework share, cost alerts and total cost of ownership. All amounts are estimated consumption on the seat, not money spent.
argument-hint: "[--by role|phase|item] [--milestone MS-nn]"
allowed-tools: Read Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-cost.mjs *)
---

Report the project's cost from ARIMA's run ledger. This is read-only.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-cost.mjs" $ARGUMENTS` from the project root and show the result in a compact form. Pass `--json` only when you need to compute something from it.
2. Say plainly that the figures are estimated consumption, not spend, when the user asks about money.
3. Read it for the user: where most of the cost went, whether any story is far above the typical cost for its size, whether rework is eating the budget, and whether the estimates by size are holding (a size with fewer than three stories is reported as "too few", not guessed).

What the exit codes mean for the user:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Done | Show the result. "no runs yet" means nothing has been spent. |
| 1 | The ledger or `.arima/manual-costs.json` is unreadable | Show the message; it names the line. Do not edit the ledger. |
| 2 | Bad arguments | Show the usage line. |
| 10 | `arima.yaml` is invalid | Show the `file:line` errors. |

Never write to the ledger and never run `--sync` here: queuing the Notion Cost log is done by the daily run.

Next command: `/arima:status`.
