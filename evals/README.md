# Evals

Each increment adds a folder of scenarios that must pass before release (spec §15.4).

- `v0.1/`: run `/arima:init` on `examples/brief.md` against a mocked Notion; check that config validates, the Notion map is written, brief/charter/budget plan are in the outbox and applied, the G0 page exists with its checklist, and `.arima/ledger.jsonl` and `events.jsonl` hold valid rows. Built in task T-14.
