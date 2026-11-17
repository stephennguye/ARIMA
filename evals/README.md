# Evals

Each increment adds a folder of scenarios that must pass before release (spec §15.4).

- `v0.1/`: `npm run eval` runs `/arima:init` on `v0.1/brief.md` against a mocked Notion and real git, and checks the result against `v0.1/expected.json`: all 19 databases mapped, brief, charter and budget plan written, G0-G4 pages opened with the G0 checklist, one valid ledger row and the event log committed to the `arima-state` branch, `/arima:status` output, and the hard stops (kill switch, human-only fields, Notion delete, secret files, read-only mirror). No network and no model calls, so it costs nothing and runs in CI.
