# ADR-0001: Scripts in TypeScript on Node.js 22, bundled

- Status: Accepted
- Date: 2026-11-18 (proposed 2026-11-17; accepted by the owner 2026-11-18)

## Context

ARIMA needs deterministic code beside its prompts: config validation, ID issuing, Notion sync with an outbox, the run ledger, the event log, the agent-run wrapper, gate checks and the digest builder (spec §15.1 `scripts/`). It runs in WSL 2 now and on GitHub Actions Linux runners later (D-13, D-15). An installed plugin should work without a manual dependency install.

## Decision

- TypeScript (strict, ESM) on Node.js 22 LTS.
- Libraries: `@notionhq/client` (official Notion SDK), `ajv` (JSON Schema 2020-12), `yaml`.
- Tests: Vitest. Lint/format: ESLint + Prettier.
- Bundle each CLI entry point with esbuild into `plugins/arima/scripts/dist/*.mjs` and commit the bundles, so skills and hooks can call `node "${CLAUDE_PLUGIN_ROOT}/scripts/dist/<tool>.mjs"` with no install step.

## Alternatives considered

- Python: good libraries, but adds a second runtime next to Node, which Claude Code users usually already have.
- Plain shell: too fragile for schema validation and API sync.
- Relying on the plugin loader to install `node_modules`: behavior differs by plugin source type; bundling removes the question.

## Consequences

- One build step (`npm run build`) before committing script changes; CI checks that `dist/` is up to date.
- Bundles add some repo weight; acceptable.
