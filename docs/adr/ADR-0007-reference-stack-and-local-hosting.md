# ADR-0007: Reference stack and local hosting for the sample project

- Status: Accepted (the owner delegated the choice on 2026-11-19, decisions D-44 to D-47)
- Date: 2026-11-19
- Resolves: spec issue S11, open question Q-04, work package WP-201

## Context

The v0.2 build loop needs one stack and one place to deploy before the architect agent exists (D-12 says the architect proposes stacks per project). The owner has GitHub, GitHub Actions and Docker only, and the web apps are developed, hosted and used locally. K3s and K8s will come later.

## Decision

- **Reference stack** (shipped as `stacks/default-web`): TypeScript end to end; Node 22; React with Vite for the web UI; Fastify for the API; PostgreSQL in Docker; Vitest for unit and integration tests; Playwright for end-to-end tests; Docker Compose to run everything.
- **Hosting:** no hosting provider. Environments are Docker Compose projects on the owner's machine: `preview-<pr>` per pull request, `staging` following `main`, `production` with a separate data volume. CI is GitHub Actions; deployment is by local host scripts, and production only by the approval-gated script (D-29).
- The architect may propose a different stack per project (D-12); deviating from the reference stack needs an ADR approved by the tech-lead (D-44).
- Design for later K3s/K8s: containerized services, configuration by environment variables, health and readiness endpoints, named volumes, one image per service.

## Consequences

Hosting cost is zero beyond CI minutes; capacity (CPU, RAM, disk, ports) is a stated constraint in each SAD. Previews and staging compete for the owner's machine resources, so the dispatcher limits concurrent previews (default 2). Production on a personal machine has no availability beyond the machine's uptime; the SLO in hypercare is measured accordingly.
