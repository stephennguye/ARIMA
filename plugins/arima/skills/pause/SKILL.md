---
name: pause
description: Pause or resume ARIMA by setting or clearing the kill switch - the "Pause ARIMA" to-do on the Notion root page and the PAUSE file on the state branch.
argument-hint: "[--resume] [reason]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-pause.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-status.mjs *)
---

Set or clear ARIMA's kill switch. While it is on, every scheduled or manual run stops at preflight (exit 12).

- `$ARGUMENTS` containing `--resume` means resume; anything else means pause, and any other words are the reason.
- Pause: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-pause.mjs" --reason "<reason>"` (leave `--reason` out if none was given).
- Resume: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-pause.mjs" --resume`.

The script sets or clears both switches. If Notion cannot be reached it still sets the PAUSE file, which is enough to stop runs. When resuming, if it reports that the Notion switch could not be cleared, tell the user to untick "Pause ARIMA" on the Notion root page themselves. Do not edit `.arima/PAUSE` or Notion by hand.

Afterwards say plainly whether ARIMA is now paused or running, and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/arima-status.mjs"` to confirm.
