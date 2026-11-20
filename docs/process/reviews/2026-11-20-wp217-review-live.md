# WP-217: the milestone review and the learning loop, live check on the dev Notion workspace (2026-11-20)

Throwaway workspace and project (`D:\GitHub\arima-dev`). `MS-01` and `US-001` to `US-005` were left there by the WP-216 check. For this check `US-001` to `US-004` (the stories of `MS-01`) were put into PO Acceptance by engine Status writes (a throwaway shortcut: the state machine moves a story one step per run), and a Lessons row was created as Approved.

| Step | Result |
| --- | --- |
| a review tick | `{"opened":["MS-01"]}`: the milestone's stories were found through the real mirror's page-id relations; the retro inputs were written to `.arima/retro/MS-01.md` |
| `arima-notion push` | three Decisions rows (`DEC-0002` to `DEC-0004`, one per story, `Item` set, veto box unticked and human-only) were created; **one was rejected** ("Decisions already has a row DEC-0001": the id counter of this workspace was reset by the WP-141 probe, a known leftover, not a defect), and **the milestone's `Status` write was rejected and lost** (finding 1 below) |
| `arima-review status` | `MS-01 ... review open (closes by itself in 24 h)` |
| `arima-lessons apply` | two approved lessons became `.arima/overrides/LES-001.md` and `LES-002.md` (role `developer`); `arima-lessons show developer` prints them |
| `arima-review close MS-01`, plain `arima-notion push` | 7 applied, 0 rejected: `US-001` to `US-004` Done, `MS-01` Done, both lessons `Applied` |

**Finding 1, fixed:** the commands that tell the person "run `arima-notion push`" (a review opening or closing, a lesson applied) queue Status writes of their own, and a plain `arima-notion push` refused them (the entry moves to `rejected/` and is lost): only the dispatcher's push allowed engine writes. The plain push now applies exactly the engine's entries: the `st-` prefix AND a registration in the protected engine-entry registry (an agent cannot write that file, so it cannot forge one). `--allow-status-writes` still lets a human force anything. `notion-cli-status.test.ts` tries a forged `st-` entry, a registered entry without the prefix and an agent-style entry (all refused), and mutations of the default were killed.

**Finding 2, noted:** `moveItem` decides from the mirror's status, so one story can move only one step per run until the engine's queued write has been pushed and pulled. That is how the daily run works (one step per run), and it is why auto-accept and the review follow the engine's last event rather than the mirror, but it means a script cannot chain moves.

**Not verified:** a veto of a real Decisions row (the box is human-only; E-S5 covers the flow on the fake Notion, E-S4 and `inbox.test.ts` cover the veto itself), the review page body on the real Milestones page (the append went in the first push; not read back), and a real approval by the tech-lead agent (it does not exist yet: the approval of a lesson is the person setting its Status to Approved).

**Left in the dev workspace:** four Decisions rows, two Lessons rows (both Applied), `MS-01` Done with its four stories Done.
