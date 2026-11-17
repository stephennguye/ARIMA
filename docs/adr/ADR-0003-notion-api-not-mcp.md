# ADR-0003: Notion access through the public API and ARIMA scripts, not the Notion MCP

- Status: Accepted
- Date: 2026-11-18

## Context

Spec D-02 says Notion is "accessed via MCP", and §3.2 / §5.2 give the orchestrator a "Notion MCP (delete disabled)". Spec §9.4 says the opposite for sync: query tools in the hosted MCP vary by plan, so sync uses the public API with the integration token and ARIMA's own scripts. The build plan (T-09, T-10) and ADR-0001 already assume `@notionhq/client` scripts.

## Decision

- All Notion reads and writes go through ARIMA scripts using `@notionhq/client` and the token in `ARIMA_NOTION_TOKEN`.
- The orchestrator is not granted any Notion MCP tools. It calls the scripts (`arima-notion ...`) and writes proposed changes to the outbox.
- The scripts contain no delete operation, so "Notion delete" (spec §11.1) is impossible by construction rather than by tool permission.

## Consequences

- Behaviour does not depend on the Notion plan or on the hosted MCP's tool set; rate limiting, retries and the human-only field refusals live in one place.
- D-02 and spec §3.2 / §5.2 wording should say "Notion public API" at the next spec revision.
