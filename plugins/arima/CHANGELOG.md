# Changelog

All notable changes to the ARIMA plugin. Versions follow semantic versioning.

## 0.1.1 (unreleased)

- Safety: fail-closed guard launcher, tokenizer-based command guard, credential-file and path protections, state-branch privacy refusal (unknown counts as refuse), dispatch re-check of the local PAUSE file, the Notion switch and the remote state branch, required budget caps.
- `arima-notion push` refuses `Status` writes unless `--allow-status-writes` (humans and `init` only).
- `arima-pause` exits non-zero when the state could not be saved.
- Outbox: human edits are detected by property value, not by minute-rounded timestamps.
- Notion template: `Coverage` formula uses `contains()`.
- Kill switch: if Notion and the remote state branch are both unreadable, ARIMA counts as paused.
- Notion reads retry transient network errors (never writes); `PermissionDenied` hook logs permission-rule refusals.
- Artifact catalog (58), 28 draft templates, document validator, profile checks; charter, budget and gate pages render from templates.
- Tooling: live test tier (`npm run test:live`), scrubbed real-response fixtures.

## 0.1.0

- First build: config validation, IDs, event log, run ledger, headless run wrapper, preflight, kill switch, state branch, Notion bootstrap/map/mirror/outbox, orchestrator agent, `init`, `status` and `pause` skills.
