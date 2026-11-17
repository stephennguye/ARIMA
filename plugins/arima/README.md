# ARIMA plugin

ARIMA runs a gated, agent-run software lifecycle for web apps inside Claude Code. An orchestrator plans each day, role agents (business analyst, UX, architect, tech lead, developers, QA, security, DevOps) produce the specs, code, tests and releases, Notion holds project management and GitHub holds engineering. Humans approve gates, every pull request and every production deploy.

Install:

```
/plugin marketplace add stephennguye/ARIMA
/plugin install arima@arima
```

Setup: duplicate the ARIMA Notion template, set `ARIMA_NOTION_TOKEN`, add `arima.yaml` and `team.yaml` to your app repo, then run `/arima:init` with a project brief. Full documentation lives in the repository's `docs/` folder.

Commands in v0.1: `/arima:init`, `/arima:status`, `/arima:pause`. Status: v0.1 foundations, tested against mocks; see `docs/INSTALL.md`.
