# ADR-0005: The PreToolUse guard fails closed inside an ARIMA project

- Status: Proposed (needs the owner's confirmation)
- Date: 2026-11-18

## Context

Spec principle 10 says ARIMA fails closed on hard-stop matters. The guard hook (T-13) was written to fail open on any problem: malformed input, an internal error, a timeout, or Node missing from the machine (a missing `node` makes the shell return 127, which Claude Code treats as a non-blocking error). The independent review (blocker 3) pointed out that a hard stop which silently turns itself off contradicts principle 10 and the spec's own rule that no agent may weaken a hard stop.

## Decision

- **Inside an ARIMA project** (a folder with `arima.yaml` above the working directory), the PreToolUse guard **blocks** (exit 2, with a plain message) when it cannot decide: an unreadable payload, an internal error, or Node not found. The hook command first checks `command -v node` and exits 2 if it is missing.
- **Outside an ARIMA project** the hook does nothing, so installing the plugin does not change behaviour in other repositories.
- **Audit hooks** (PostToolUse, Stop, SubagentStop) stay fail-open: losing a log line must never wedge a session.
- A guard timeout is not covered: Claude Code treats a timed-out hook as non-blocking unless the hook sets `onFailure: block`. The guard is fast (no network, no model call), but the timeout setting and a latency budget are checked in step S0.9.

## Consequences

- A bug in the guard can stop an agent's tool calls until the plugin is fixed. That is the intended trade: a stopped session is recoverable, a bypassed hard stop may not be.
- The launcher assumes a POSIX shell for hooks (`command -v`). It worked in the live Windows session (Git Bash). If Claude Code ever runs hooks through PowerShell, this changes and needs a launcher script instead.
- Tests: unreadable payload and internal error block inside a project and allow outside it; the launcher contains the Node check before the call.
