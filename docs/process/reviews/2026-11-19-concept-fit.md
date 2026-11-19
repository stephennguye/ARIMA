# Concept-fit review of the plan (2026-11-19)

Question put to an independent read-only reviewer: does the plan, from the concept down to the agent cards, serve the owner's idea (ARIMA replicates a company team building a greenfield web app, with carefully produced and measured artifacts and communications), or has it drifted into an engine? Verdict: **proceed after fixes**; confidence medium-high. The concept, roles, gates, 58-artifact trail, communication model and measurement are all explicit; it drifted in the build order and at the seams between roles.

| Finding | Response |
| --- | --- |
| B1 Preview environment (guard of In Review to In QA) had no owner | **Fixed**: WP-218; QA and `/arima:run` depend on it |
| B2 G3 checked the runbook before the package that produced it | **Fixed**: runbook and rollback plan moved into WP-401 |
| B3 The v0.3 eval could pass without testability review, Phase 0, baseline freeze, QA and devops legs | **Fixed**: WP-350 depends on WP-315, WP-321, WP-331, WP-314; WP-320 on WP-315 and WP-213 |
| B4 Phase 3 legs (conventions, e2e skeleton, security CI checks, skeleton kind) had no owner | **Fixed**: WP-219 |
| M5 No integration of ba-written stories until the showcase | **Fixed**: WP-351 integration eval in Stage 3 |
| M6 `/arima:assign` before human tasks | **Fixed**: moved to Stage 3 |
| M7 Design-QA guard existed before the ux verdict | **Fixed**: WP-311 acceptance; Stage 2 eval uses non-UI stories, stated in `02-stages.md` |
| M8 Measurement gaps (13.5 alerts, TCO, ci_minutes, DORA timing) | **Fixed** in WP-131, WP-132, WP-403 acceptance; stale F05 note corrected |
| M9 Human interface partly on paper (views, @mentions, Urgent page) | **Fixed**: WP-142 |
| M10 Retro double-owned; learning loop missing until Stage 4 | **Fixed**: WP-217 owns lessons and overrides from Stage 2; WP-403 holds the retro meeting |
| M11 WP-403 overloaded; CRs apply from G1 | **Fixed**: change requests split into WP-336 (Stage 3) |
| M12 User guide and FAQ had no builder | **Fixed**: WP-402 acceptance with the ba author kind |
| M13 Doc drift the test missed | **Fixed** (F05, F07, WP-312 dependency) and two new tests: every package must lead to WP-505, and the Stage 3 evals must depend on every Stage 3 package |
| Minor: DoD page, risk register upkeep, bug triage, ADR approval path, story map | **Fixed** in acceptance, or recorded as open design questions in `06-decisions-risks.md` |
| Role-shaped multi-kind agents vs Anthropic's task-shaped agents | **Rule added** to `CONCEPT.md` section 6: every kind has its own section, fixtures, evals and owner package; split the file if it nears the cap |
| Three dangerous ambiguities (card open decisions; who orchestrates pre-build phases; evals that can pass while legs are missing) | Open decisions must be answered before step 1 of a card's build; playbook split proposed in `06`; the evals now depend on every leg |
