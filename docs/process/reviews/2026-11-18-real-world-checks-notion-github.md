# Real-world checks: Notion and GitHub (Stage 0, S0.3 / S0.5 / S0.6), 2026-11-18

Dev workspace and the private throwaway repo `ARIMA-Test` only. No token value appears here.

## Notion (S0.3)

| Check | Result |
| --- | --- |
| Bootstrap, map, `init`, mirror, outbox | Already done on the dev workspace (19 databases, charter/brief/budget docs and gates created); `npm run test:live` re-verifies map, update and conflict handling: 5 passed |
| `last_edited_time` granularity | Rounded to the whole minute: three writes in a row returned the same `:00.000Z` value |
| Value-based human-edit detection | Works on real Notion: an out-of-band edit in the same minute is caught; a normal update applies |
| Rollup and formula | Rollup `Test results` and formula `Coverage` exist in the real workspace; the formula uses `contains()` |
| Rate limit | 40 sequential reads (about 2.7 per second): no 429 |
| `users.list` | Works; the person from `team.yaml` is visible, so approver ids can be matched |
| `last_edited_by` | The bot after bot writes. It is per page, as the judge said |
| Page duplication via API | **No.** `POST /v1/pages/{id}/duplicate` returns 400 `invalid_request_url` (S5: the owner duplicates a template by hand or runs `bootstrap`) |
| Views via API | **Yes.** `views.create` created a table view (S5: init can create views; one probe view "S0.3 probe view" was left in the Documents database) |
| Bot @mention notifies a person | Not confirmed by me (needs the owner to look at their notifications) |
| **Gate approver identity (S1)** | **Waiting for one human edit.** A probe gate `G-PROBE` exists in the Gates database with Status "Ready for review"; the owner must set Status to Approved in Notion, then the page's `last_edited_by` is read |

## GitHub (S0.5)

| Check | Result |
| --- | --- |
| Token | `gh` signed in with scopes gist, read:org, repo, workflow; repo is private, viewer permission ADMIN |
| Branch protection on a private repo | **Accepted by the API for this account** (pull request with 1 approving review, enforce admins). D-29 says GitHub Free has none; this account evidently has it. It is left ON for `ARIMA-Test` main |
| Direct push to protected main | Rejected: "Changes must be made through a pull request" |
| `gh pr create` | Works; the PR shows BLOCKED / REVIEW_REQUIRED. I did not try to self-approve or merge with admin override (declined by the permission system as bypassing review); merge behaviour with a second account stays untested |
| Worktrees on Windows | `git worktree add/remove`, including a long path, work |
| State push | `arima-state` pushed to the private repo (35 files); privacy check passed through the real `gh` |
| Kill switch round trip | `arima-pause` and `--resume` set and cleared the Notion switch and pushed the PAUSE file; preflight stopped with exit 12 while paused |

## Live tier (S0.6)

`npm run test:live` (needs `ARIMA_LIVE=1`, the token in the environment, `ARIMA_LIVE_PROJECT`). Scrubbed real responses are recorded with `ARIMA_LIVE_RECORD=1` in `test/fixtures/notion-real/` and checked against the fake. The first comparison found real drift (real property values carry an `id`) and the fake was fixed.
