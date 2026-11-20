# WP-142: Notion views, @mentions and the Urgent page, live check on the dev Notion workspace (2026-11-20)

Throwaway workspace and project (`D:\GitHub\arima-dev`). The `team.yaml` there holds the owner's real Notion user id, so the mentions below notified the owner in their own workspace.

| Step | Result |
| --- | --- |
| `arima-notion views` | **10 created, 0 failed**: Board (stories, board layout grouped by Status), Approval inbox in Gates, Questions, Releases, Change Requests and Decisions, RTM (Requirements), Milestone burn (Milestones and Stories), Open bugs (Bugs); each with its filter and sort |
| `arima-notion views` again | 0 created, 10 already there |
| `arima-notion notify --dry-run`, then `notify` | one item was awaiting the owner (the old probe gate): a comment on its page, mention first, posted through the comments API (no fallback needed); a second `notify` sent 0 |
| a P1 incident opened (throwaway, engine entry), `notify` | the **Urgent page** was created under the root, and two mentions were posted on it: the incident, and the red health day that the open P1 caused; a second pass sent 0; the root holds exactly one page named Urgent |
| the incident closed again | applied |

**Design points**
- `arima-notion views` is idempotent by name and never alters or deletes a view (a view a person made with the same name is left alone); a failing view does not stop the others. The database must be in the Notion map.
- An "Approval inbox" is a view of one database, so it is the same-named view in each of the five databases that can hold something waiting for the owner. The Decisions one uses "the past week" (the API has no "past day").
- Notifications are `@mention` comments on the item's own page (gates, questions, production approvals, change requests, pull requests that passed QA), and mentions on the Urgent page for a P1 or P2 incident, a production approval waiting while an incident is open (a hotfix), and a red health day. Once per state an item waits in (`.arima/state/notifications.json`; a gate that is edited and returns to the queue is announced again), at most 20 per run, text is ids and a short quote and is secret-scanned, a person with no real Notion user id is skipped with the reason (never guessed). If the integration may not insert comments, the mention goes into the page as a paragraph instead. ARIMA sends no email; Notion's own notifications deliver the mention.
- The daily run posts them in step 9 after the outbox push; a failure is a warning, never a failed run.
- Found while testing: **`Status` is engine-only on every database, Incidents included**, so an incident must be created through an engine entry (the future incident flow, WP-403, does). Not a defect; recorded so the next package knows.

**Not done, said plainly**
- The Portfolio page (a public overview) is not created by ARIMA; `docs/NOTION-TEMPLATE.md` says so.
- The Board is not filtered to the current milestone (a view cannot name a milestone that does not exist yet); the guide says to add that filter.
- Reminders at the SLA and the escalation to the sponsor at twice the SLA are WP-301.
- The approval inbox is five views, not one page; arranging them on one page is a manual step.
- Left in the dev workspace: ten views, the Urgent page with two comments, a comment on the probe gate, incident `INC-002` (Closed).
