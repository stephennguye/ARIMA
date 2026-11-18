# ADR-0004: "Item" references are ID text, not relations

- Status: Proposed (needs the owner's confirmation)
- Date: 2026-11-18

## Context

Spec §9.1 lists an `Item (story, gate, CR)` relation on Decisions, `Item` on Questions and Human tasks, and `Items` on Risks. A Notion relation property points at exactly one database, so a relation that can target a story, a gate or a change request is not possible. The spec's Cost log row says "Story or Bug" with the same problem.

## Decision

- On Decisions, Questions, Human tasks, Risks and Cost log, `Item` / `Items` is a text property holding the ARIMA ID (US-112, G1, CR-006, BUG-045). IDs are unique across entity types (spec §2), so the text identifies the item unambiguously and agents already reference items only by ID.
- Where the target is always one database, a real two-way relation is used: Questions ↔ Stories (`Story`), Cost log ↔ Stories (`Story`), Cost log ↔ Milestones, and all the relations listed in §9.1 that have a single target.
- Reverse relation properties that §9.1 does not list but Notion creates for two-way relations are part of the template (for example `Releases` on Stories, `Incident actions` on Stories).

## Consequences

- No live relation view from a decision or risk to its item; filtering is by the ID text. The RTM view (Requirements, Stories, Test Cases, Bugs) is unaffected because those are real relations.
- If a later version needs navigation from Decisions to items, add one relation per target type (Decisions → Stories, Decisions → Gates, ...) in a template schema_version 2 with a migration.
- Spec §9.1 should say "Item ID (text)" at the next revision.
