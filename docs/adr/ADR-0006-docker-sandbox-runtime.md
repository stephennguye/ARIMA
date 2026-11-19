# ADR-0006: `runtime.sandbox: docker | none` for unattended agent runs

- Status: Accepted in principle by D-37 (2026-11-18); amended 2026-11-19 (D-47, D-49); design only, not yet built (implements decision D-36 and answers the sandbox gap in spec issue S6 and judge review #2, finding 3)
- Date: 2026-11-18

## Context

The local safety layers (role tool lists, guard hook, scrubbed environment) are advisory for developer and QA runs, because those roles run project scripts the guard cannot see. Docker Desktop is installed on the owner's machine (Docker 29.1.2, `docker sandbox` present).

## Decision (design, not yet built)

- New config key `runtime.sandbox: docker | none` (default `none`). With `docker`, `arima-run-agent` starts the headless `claude -p` run inside a Docker sandbox instead of on the host.
- The container gets: a **per-run clone** of the repository at the work unit's branch, made by the host and read-write inside the container (not a mounted worktree, so the main checkout and its `.git` are never mapped in), the plugin folder (read-only), a scrubbed environment (the role's own tokens only), and **no push credentials** (S16, D-49): no role holds any GitHub credential, and the host script pushes branches, opens pull requests and posts comments. The host fetches the commits from the clone after the run. It never gets `~/.config/arima`, `~/.claude` credentials, the main checkout, or the Notion token (the orchestrator stays on the host).
- **No Docker socket** is mounted into any role container, and the container is not privileged, so a role cannot start sibling containers or reach the host's Docker daemon.
- **Egress goes through an allow-list proxy** run by the host: only api.anthropic.com, the package registry and the preview host are reachable; everything else is refused.
- Authentication inside the container uses a long-lived token from `claude setup-token`, stored on the host as `CLAUDE_CODE_OAUTH_TOKEN` in `~/.config/arima/env` and passed only to the container process. It is never written to the repository or printed.
- With `sandbox: none` ARIMA runs `claude` directly on the host and the guides keep saying the local layers are advisory.
- Docker Desktop must be running; preflight checks `docker info` and refuses to dispatch a sandboxed role if it is not.

## Open points

- Whether unattended use of a Team seat's token is permitted and how it is billed (spec issue S15). A web search found only third-party claims that headless `claude -p` is billed from a separate Agent SDK credit pool; Anthropic's own terms were not found. **The owner must confirm before the first unattended run.**
- The exact allow-list of the egress proxy (starting set: api.anthropic.com, the package registry, the preview host).
- Windows path mapping, the cost of a per-run clone and of container start; to be measured.

## Consequences

The status stays design only: nothing in this ADR is built yet. It closes the `npm run` bypass for developer and QA in unattended runs, at the price of Docker as a dependency and slower starts. Nothing changes for interactive use.
