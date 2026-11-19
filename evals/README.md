# Evals

Each increment adds a folder of scenarios that must pass before release (spec §15.4). Three tiers, by what they cost:

| Tier | Where | Run | Cost |
| --- | --- | --- | --- |
| Stub evals | `v0.1/`, `stage1/`, `devops/`, `lib/` | `npm run eval` (in CI) | none: a fake Notion, real temporary git repos, a local bare remote, a fake `gh`, stub roles |
| Real-agent evals | `agents/<role>/*.real.eval.ts` | `npm run build`, then `ARIMA_REAL_EVALS=1 npm run eval:agents` (never in CI) | seat usage per run; a per-file cap (`ARIMA_REAL_EVALS_CAP_USD`, default 3) |
| The judge | `npm run judge -- --checkpoint J2 --paths <file> --questions <file>` | by hand at a checkpoint | at most 5 USD per review (hard cap) |

## The stub evals

- `v0.1/`: `/arima:init` on `v0.1/brief.md` against a mocked Notion and real git, checked against `v0.1/expected.json`: all 19 databases mapped, brief, charter and budget plan written, G0-G4 pages opened with the G0 checklist, one valid ledger row and the event log committed to the `arima-state` branch, `/arima:status` output, and the hard stops.
- `stage1/` (WP-121, WP-150): the scenarios of `docs/build/features/F10-evaluation-and-judge.md` 5.3, driven through the real dispatcher with stub roles.
  - **E-S1** five stories Backlog to Done: legal edges only, one ledger row per run, cost equal to the ledger and the Notion Cost log, an agent `Status` write rejected, `main` never pushed, five squash merges, the digest in the template's order with each story shipped once, a second run the same day changes nothing, and a refusal before the Phase 3 exit (exit 5).
  - **E-S2** failure loops: an invalid report, three review rejections, a used-up story budget, a run that ends on its turn cap. (The flaky-CI variant is a todo until WP-215.)
  - **E-S3** hard stops: kill switch (file, and unreadable), daily and project budget, a secret in agent output, nine guard-hook refusals, the commit attribution check, an agent `Status` write, and `arima-merge` refusing without the human approval and with CI red. Each variant has a negative control (the allowed form works) and a side-effect snapshot (a refusal changes nothing).
  - **E-S4** human edits win: a conflict keeps the human's value; a veto of a story in PO Acceptance reopens it with a BUG, and auto-acceptance does not undo it.
- `lib/graders.ts` holds the deterministic graders (event subsequence, state trace, ledger, cost, attribution, duplicates, side-effect snapshot, negative control); `lib/graders.eval.ts` proves each one fails on bad data. `devops/graders.ts` is the devops card's grader set.

Not covered yet: a UI story with design screens (the queue plans no `design-qa` unit until the ux agent, WP-311).

## Writing a scenario

Build a `world()` (`stage1/support.ts`), script the stub roles (`stubRoles`, or files in `w.stub` per role and kind), drive `day(w, n)` and the scripted human (`w.approved`, `w.humanAway`, `w.ci`), then grade the end state with the graders. A refusal scenario also runs the allowed form (`withNegativeControl`), so a harness that refuses everything cannot pass.
