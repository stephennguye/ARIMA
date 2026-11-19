# Cold-start review of `docs/build/` (2026-11-19)

A fresh read-only agent, with no prior knowledge, followed `docs/build/00-handoff.md`, answered eight questions from the documents alone, and attacked the set. Verdict: **conditional**: a fresh session could start WP-101 but would meet contradictions. Confidence medium (it read the core files, three cards and F02 in full; the other cards and features it only sized).

Answers: next package (partly answered: no file list for WP-101), developer prerequisites (steps full, preconditions partly), run packet and report (mostly), who may write Status / merge / push / pause (full, with enforcement status), Blocked conditions (mostly, with a counter conflict), unattended-run conditions (full), QA agent (full), definition of done (full, with a loophole on falsifiability).

| Finding | Response |
| --- | --- |
| Major 1: `attempt` counter described three ways | **Fixed**: invalid report and failed run increment `run_failures`; only changes-requested and QA-failed increment `attempt`; cards, F02, F06, architecture aligned |
| Major 2: spec says 8 statuses, contract 10 | Noted (G-67): spec 7.1 uses Blocked and Cancelled in its table |
| Major 3: exit code 3 vs 4 for "nothing to do" | **Fixed** in F02 |
| Major 4: WP-210/211/212 omit WP-201 | **Fixed**, and a test now asserts it |
| Major 5: developer needs TCs that QA writes | **Fixed**: hand-written test cases until WP-211 (card, 02-stages) |
| Major 6: acceptance criteria that cannot fail | **Fixed** (seven rewritten) and a test rejects the bare forms |
| Major 7: tech-lead reads `.arima/` while forbidden | **Fixed**: packet inlines prior findings |
| Major 8: contract says every id comes from `arima-ids` | **Fixed**: contracts section 1 lists which ids are counter-based |
| Major 9: G-06 / G-07 overstated | **Fixed**: the guard already blocks those file-tool writes; narrowing the role pattern is defence in depth |
| Major 10: sandbox and independence advisory in Stage 2 | Noted honestly in cards; WP-190 stays a Gate U prerequisite (G-68) |
| Minors | Fixed: `--project` flag, garbled sentence, `state/ids.json`, developer outbox rule, WP-232 and WP-314 in the stage tables, scratch-path rule, stale "open" items marked resolved. Noted: turn-cap estimates differ (cards authoritative) |
| Gaps: error taxonomy, item data model | **Fixed**: contracts sections 9a (item counters) and 9b (reason codes) |
| Gaps: deployment, observability, Windows sandbox, QA authoring mode, tech-lead conventions mode | Recorded in `07-known-gaps.md` (G-68, G-70); deployment and observability belong to WP-213/402/405 |
| Not read by the reviewer | ba, ux, architect, security, devops, orchestrator cards and F01, F03 to F08, F10: structure is test-checked; content was written against the spec by independent writers and their contradictions are in `07-known-gaps.md` |
