# WP-130: the daily digest, live check on the dev Notion workspace (2026-11-20)

Throwaway workspace and project (`D:\GitHub\arima-dev`, solo-lite, project cap 50 USD), after the WP-216 check had left five synthetic stories and `MS-01` there.

| Step | Result |
| --- | --- |
| `arima-digest` | headline `0 Initiation; MS-01: 0 of 11 points done; health green.` (the milestone's stories were found through the real mirror's page-id relations); Awaiting you listed the old probe gate `G-PROBE` ("waiting 35 h", so not yet a hard stop over 48 h); Decisions made listed `DEC-0001` from the WP-141 probe with its veto box; exit 0, local copy `.arima/digests/2026-11-20.md` |
| `arima-notion push`, `pull` | one Digests row `2026-11-20` created with the page body, `Summary`, `Spend today` 0, `Month to date` 0; `Reviewed by` empty and `Minutes spent` empty (they are human-only now) |
| `arima-digest` again | "queued an update of the Notion row"; push: 2 applied (the update and an appended "Rebuilt" section), 0 rejected; still one row for the date |

**Design points to know**
- Every number is computed in `src/digest.ts`; no model writes or counts anything (RD-F05-1). The page is the template's eight headings in the template's order, each list capped at ten with "and N more".
- Health (spec 12.1) is strict at its edges and tested there: exactly 80% of a budget is amber, exactly 100% red; a blocker of exactly 24 h is green, 24 h and a minute amber; a hard stop waiting exactly 48 h is green, 48 h and a minute red; an open P1 or P2 incident is red. A hard stop here is a gate ready for review, a production approval, or a question with a hard-stop id.
- A rebuild of the same date updates the row and **appends** a "Rebuilt" section; the earlier page body stays, because ARIMA never deletes in Notion. The local copy is always the fresh one.
- `Reviewed by` and `Minutes spent` are now human-only in the template (the outbox refuses them); the template test lists them.
- The dispatcher writes the digest in step 9 of every run (before the push) and reports it in step 10; a failure to write it is a warning, never a failed run. `arima-digest` is an interactive command: it waits for a live run (exit 11) unless `--no-push`.
- E-S1 now has its digest grader: every run's digest has the template headings in order, lists capped, and each story is shipped exactly once (Shipped means reaching staging, PO Acceptance; the later move to Done is not listed again).
- 16 mutants (every health boundary, cap, ordering, the overflow line, the secret scan, the rebuild branch, Shipped including Done, month-to-date, the future-date and lock checks): all killed.

**Not done, by design or gap (said plainly)**
- Preview links: the page says "preview link not available yet" for a PR awaiting approval (the preview environment is WP-218).
- The red-health `@mention` on the Urgent page (spec 12.3): WP-142.
- `schedule.timezone` is not used: the date is the machine's local date (RD-F05-6 stays open); "ready by `schedule.digest_ready_by`" is ignored until a scheduler exists (Gate U).
- Tomorrow's plan does not read GitHub (no PR state), so it can under-report review and QA units; the page says so. The run itself reads GitHub.
- "New or changed risks" is approximated by listing open and mitigating risks, newest first.
- Human wait hours come from the delivery metrics and read "not available yet" until items have status events.
- Left in the dev workspace: one Digests row (`2026-11-20`) with its body; there is no retire status for digests.
