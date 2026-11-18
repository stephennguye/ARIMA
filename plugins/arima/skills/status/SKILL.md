---
name: status
description: Show where an ARIMA project stands - phase, gate states, open questions, the story board, budget used against the caps, and recent runs.
allowed-tools: Read Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-status.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-notion.mjs pull *)
---

Report the project's current state from ARIMA's local data. This is read-only.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-status.mjs"` from the project root and show the user the result in a compact form.
2. If it warns that there is no Notion mirror, or the user asks for the latest state, refresh with `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-notion.mjs" pull` (needs the Notion token in the environment; never ask for it or print it) and run status again.
3. Add a short reading of it: what phase the project is in, what is waiting for a human (gates ready for review, blocking questions), whether the budget is healthy, and whether ARIMA is paused.

If status reports an invalid config (exit 10), show the `file:line` errors and offer to fix them. Do not change anything else.
