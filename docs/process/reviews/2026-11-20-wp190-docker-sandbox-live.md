# WP-190: Docker sandbox, live check (2026-11-20)

Real Docker 29.1.2 (Docker Desktop, Windows), image `node:22-slim` plus git, built locally; the real `openSandbox` and `sandbox.dockerArgs`, a shell script as the role command. No `claude` was run in the container (no seat token for unattended use is configured; ADR-0006 open point, spec S15).

| Check | Result |
| --- | --- |
| What `/` holds | the image's own folders plus `/work` (the per-run clone) and `/plugin` (read-only); no host paths |
| Docker socket, `~/.claude` | absent |
| `/work/.git` | a real directory (G-14), so `git commit` inside the container works; the commit came back to the host worktree by fast-forward (1 commit) |
| Environment | `ARIMA_ROLE`, `ARIMA_RUN_ID`, `ARIMA_PROJECT_DIR=/work`, `HTTPS_PROXY`; a host variable `AWS_KEY` and any GitHub or Notion token were not there |
| Direct egress (raw TCP to 1.1.1.1:443) | `ENETUNREACH` (the run network is `--internal`) |
| Through the proxy sidecar | `api.anthropic.com` and `registry.npmjs.org`: 200 Connection Established; `example.com`: 403 Forbidden |
| Role's outbox entry written in the clone | imported by the host through `enqueue` (run and role binding applied) |
| After `finish()` | no `arima-*` container and no `arima-net-*` network left |

Not verified: a real `claude -p` inside the image (needs `claude setup-token` and the owner's confirmation on unattended seat use), start-up time and clone cost on a large repository (ADR-0006 open point), and the Linux/WSL uid mapping (`--user` is set only where `process.getuid` exists; on Windows Docker Desktop the container user is the image's `node`).
