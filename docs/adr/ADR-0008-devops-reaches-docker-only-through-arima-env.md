# ADR-0008: The devops role reaches Docker only through arima-env

- Status: Proposed (needs the owner's confirmation; implemented in WP-213 because the work package's own acceptance criterion requires it)
- Date: 2026-11-20
- Refines: spec 5.10 "Tools" and the devops card section 6 (decision 15)

## Context

Spec 5.10 gives devops "Bash for git, Docker and Docker Compose against the local preview and staging environments", and the card lists read-only commands (`docker ps|images|inspect|logs`, `docker compose config|ps|logs`) and `docker build`. The work package WP-213 says the opposite in its acceptance: "devops has no Docker daemon access, no gh, no git push".

The two cannot both hold, and the card's list has a real hole. Staging, preview and production are projects on the same Docker daemon (D-47). `docker inspect` of a production container prints its environment, which holds the production credentials; `docker logs` can print them too; `docker build` runs agent-written Dockerfile code on the host daemon. Pattern matching on a command line cannot tell a staging container from a production one (a container id has no name in it). That would break the must-not of spec 5.10 and D-29: the devops agent never reads production credentials.

## Decision

- A devops run holds **no `docker`, `docker compose`, `podman` or `kubectl` command** (not in its allow list, denied for every role, blocked by the guard in any role run, however wrapped in `bash -c`).
- Everything it needs from Docker comes through the host script `arima-env`: `check` (design lint and `docker compose config`), `status`, `logs`, `smoke`, `up`, `down`. The script accepts only `staging` and `preview-<pr>` and refuses everything else with exit 70, so it cannot name a production container, volume or project. `backup` and `restore-test` are host jobs, not in the role list.
- `arima-env` runs Docker with a scrubbed environment (no Notion, GitHub or cloud token reaches Compose interpolation), lints the Compose file of the exact commit it deploys (no privileged, host network, Docker socket, host-path mount, external volume, build context outside the repo, production name, unpinned image, missing health check or memory limit), and passes only names, never values, from the host-side env file.
- The whole `~/.config/arima/` folder is a secret path for file tools and Bash (it holds the host-side staging, preview and production env files).

## Consequences

- The card's read-only Docker list and "docker build under `arima-local/`" are dropped. A devops run diagnoses with `arima-env status` and `logs` (secret-looking lines withheld) and cannot build or inspect anything else. If a later task proves it needs more, `arima-env` grows a subcommand; the role list does not grow a Docker command.
- The spec line 5.10 Tools and the card section 6 should be reworded to "Bash for git and the host script `arima-env`" when this ADR is Accepted. Until then the implementation is stricter than the spec, never looser.
- If the owner rejects this, the alternative is the card's read-only list, with the production-credential exposure above recorded as an accepted risk or closed by running production on a separate Docker context.
