> **History.** A new session should start from `docs/build/00-handoff.md`.

# Kickoff prompt for Claude Code

Open a terminal in WSL 2 at the repo root and start Claude Code. Paste:

---

You are building ARIMA in this repo. First read, in this order: `CLAUDE.md`, `docs/spec/ARIMA-Master-Spec.md`, `docs/adr/`, `docs/BUILD-PLAN.md`.

Then:
1. Summarize ARIMA in 5 lines and list anything in the spec, ADRs or build plan that looks contradictory or underspecified for v0.1. Do not write code yet.
2. Wait for my answers.
3. Start task T-01. Before coding, restate its acceptance criteria and list the files you will create. After I confirm, implement it, run the checks, commit, tick the task in BUILD-PLAN.md, and stop for review.

Continue one task at a time. Never skip the review stop.

---

Tip: for later sessions, start with "Continue the build plan from the first unticked task."
