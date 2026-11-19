# ARIMA plugin

ARIMA runs a gated, agent-run software lifecycle for web apps inside Claude Code. An orchestrator plans each day, role agents (business analyst, UX, architect, tech lead, developers, QA, security, DevOps) produce the specs, code, tests and releases, Notion holds project management and GitHub holds engineering. Humans approve gates, every pull request and every production deploy.

Install:

```
/plugin marketplace add stephennguye/ARIMA
/plugin install arima@arima
```

Setup: create a Notion page for the project and let ARIMA build its workspace on it (`arima-notion bootstrap`; a published template to duplicate is planned), set `ARIMA_NOTION_TOKEN`, add `arima.yaml` and `team.yaml` to your app repo, then run `/arima:init` with a project brief. Full documentation lives in the repository's `docs/` folder.

Commands in v0.1: `/arima:init`, `/arima:status`, `/arima:pause`. Status: v0.1 foundations, tested against mocks; see `docs/INSTALL.md`.

## What leaves your machine, where state lives, what it costs

- **Notion:** ARIMA calls the Notion API with your integration token (`ARIMA_NOTION_TOKEN`) to read and write the project workspace you shared with it. Nothing is ever deleted there.
- **GitHub:** the `.arima/` state (a mirror of your Notion data, the event log and the cost ledger) is pushed to a branch of your own repository (default `arima-state`). ARIMA refuses to push it to a public repository or when it cannot tell.
- **Claude:** headless runs use your Claude account's usage limits (or an API key if you configure one). A minimal run costs roughly $0.15 to $0.25.
- **Telemetry:** none, unless you turn on OpenTelemetry yourself in `arima.yaml`.
- **Secrets:** tokens are read from environment variables only and are scanned for before anything is written to Notion, logs or the state branch.
- **Safety limits:** the local guards are advisory for developer and QA runs until a sandbox or branch protection exists; see `docs/BUILD-GUIDE.md`.
