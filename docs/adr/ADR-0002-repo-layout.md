# ADR-0002: Marketplace at repo root, plugin in `plugins/arima/`, templates outside `skills/`

- Status: Accepted
- Date: 2026-11-17

## Context

Spec §15.1 sketches the plugin at the repo root with templates in `skills/_templates/`. Claude Code reads `skills/` as a directory of `<name>/SKILL.md` folders, does not load a `CLAUDE.md` placed in a plugin root, and lets a marketplace point to a plugin in a subdirectory with a relative `source`.

## Decision

- Repo root = marketplace (`.claude-plugin/marketplace.json`), holding `CLAUDE.md`, `docs/`, `examples/`, `evals/`.
- Plugin root = `plugins/arima/` with its own `.claude-plugin/plugin.json`.
- Artifact templates live in `plugins/arima/templates/`, not `skills/_templates/`, so they are not mistaken for skills.

## Consequences

- Install command: `/plugin marketplace add <owner>/arima` then `/plugin install arima@arima`.
- Spec §15.1 should be updated to this layout at the next spec revision.
