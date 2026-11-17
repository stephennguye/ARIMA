# Setup checklist (human tasks before building)

## Machine (D-15)
- [ ] WSL 2 with Ubuntu on your Windows PC.
- [ ] Inside WSL: Node.js 22 LTS, git, GitHub CLI (`gh`), Claude Code (native installer).
- [ ] Sign in to Claude Code with your Claude Team account (D-14).
- [ ] Clone this repo inside the WSL file system (e.g. `~/code/arima`), not under `/mnt/c`, for speed.

## GitHub (D-26, D-29, D-30)
- [ ] Create the public repo `arima` and push this package.
- [ ] Replace `YOUR-NAME` / `YOUR-GITHUB-HANDLE` in `LICENSE`, `NOTICE`, `README.md`, `.claude-plugin/marketplace.json`, `plugins/arima/.claude-plugin/plugin.json`.
- [ ] (Needed from v0.2) Create a GitHub machine account for agent PRs; check GitHub's current terms on machine accounts first. Generate a fine-grained token limited to the app repos.

## Notion (D-19)
- [ ] Create an internal Notion integration; copy its token.
- [ ] Create a page "ARIMA Template" and share it with the integration (Connections).
- [ ] In WSL, export the token for your shell only, e.g. in `~/.config/arima/env` (chmod 600), sourced from `~/.bashrc`: `export ARIMA_NOTION_TOKEN=...`. Never commit it.

## Spec
- [ ] Export the master spec as Markdown to `docs/spec/ARIMA-Master-Spec.md` (see `docs/spec/README.md`).

## Then
- [ ] Open Claude Code at the repo root and paste `docs/KICKOFF-PROMPT.md`.
