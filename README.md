# ARIMA

**A gated, agent-run software lifecycle for web apps, packaged as a Claude Code plugin.**

ARIMA runs a client-grade delivery process (phases 0–8: initiation → discovery → design → setup → build → stabilization → release → hypercare → operations) with role agents (BA, UX, architect, tech lead, developers, QA, security, DevOps) coordinated by an orchestrator. Notion is the project-management layer, GitHub the engineering layer. Runs happen daily on their own; humans decide at approval gates, approve every PR and every production deploy.

> Status: **v0.1 (foundations) is built and tested against mocked Notion and real git; it has not yet been run against a real Notion workspace.** It can initialise a project (`/arima:init`), report status (`/arima:status`) and pause (`/arima:pause`). The agents that build software arrive in v0.2 and later. See `docs/BUILD-PLAN.md`, and `docs/INSTALL.md` to try it.

## Why

- Every role can be an agent or a person (`team.yaml`), so the same setup serves a solo builder and a team.
- Every requirement is traceable to stories, tests and releases; every run is costed and timed.
- Humans keep the judgment calls: gates, merges, production, money, legal.

## Repository layout

```
.claude-plugin/marketplace.json   # this repo is a plugin marketplace
plugins/arima/                    # the plugin itself
  .claude-plugin/plugin.json
  skills/ agents/ hooks/          # Claude Code components (built in v0.1+)
  scripts/                        # TypeScript sources; bundled output in scripts/dist/
  schemas/                        # JSON Schemas for config, ledger, events, outbox
  profiles/                       # solo-lite, client-project, regulated
  templates/                      # artifact templates (spec §8.2)
docs/spec/                        # master specification
docs/adr/                         # ARIMA's own architecture decisions
docs/BUILD-PLAN.md                # ordered build tasks
examples/                         # sample arima.yaml, team.yaml, brief
evals/                            # eval scenarios + expected outcomes (npm run eval)
```

## Install

```
/plugin marketplace add stephennguye/ARIMA
/plugin install arima@arima
```

Full setup (Notion integration, token, first project): `docs/INSTALL.md`. The Notion workspace is described in `docs/NOTION-TEMPLATE.md`.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
