# START HERE

**ARIMA** is a Claude Code plugin that runs a software project through gated phases with role agents. Notion holds the plan, GitHub holds the code, and a human approves the gates. Today only the foundations exist (config, safety, Notion sync, `init`/`status`/`pause`); the agents and the daily run are not built yet.

## Read in this order (and nothing else, unless a step sends you somewhere)

1. **`docs/build/STATE.md`**: one page: where the build is, what is next, what needs the owner.
2. **`docs/build/README.md`**: a table saying which file to open for which question.
3. Only then the file `STATE.md` names under "Next action".

## Where everything lives

| What | Where | Read it? |
| --- | --- | --- |
| The plan and how to continue | `docs/build/` | Yes, via `STATE.md` |
| The product specification (what ARIMA is) | `docs/spec/ARIMA-Master-Spec.md` | Only the sections a task cites |
| Decisions and spec issues | `docs/build/06-decisions-risks.md` (index), `docs/adr/`, `docs/process/spec-issues.md` | When a choice seems open |
| Review reports of earlier work | `docs/process/reviews/` | History; skip unless asked |
| The code | `plugins/arima/scripts/src/` (tests in `test/`) | When changing it |
| Older planning files | `docs/BUILD-GUIDE.md`, `docs/BUILD-PLAN.md`, `docs/KICKOFF-PROMPT.md` | **Ignore** (superseded) |
| User-facing guides | `docs/INSTALL.md`, `docs/PRODUCT-GUIDE.md`, `docs/NOTION-TEMPLATE.md` | For using ARIMA, not building it |

## Paste one of these into a new session

**Review everything**
> Read `START-HERE.md`, `docs/build/STATE.md` and `docs/build/README.md`. Then act as the independent judge described in `docs/process/JUDGE.md` on the whole of `docs/build/` and the code it describes: find contradictions, steps a new session could not follow, and claims the code does not back up. Work read-only on a copy in a temp folder. Report in the JUDGE.md format and save it under `docs/process/reviews/`.

**Continue the build**
> Read `START-HERE.md` and `docs/build/00-handoff.md`, then `docs/build/STATE.md`. Do the "Next action" exactly as the handoff says, one work package at a time, on a branch, never on `main`. Ask me before any decision that is mine.

**Clean up the documentation**
> Read `START-HERE.md` and `docs/build/README.md`. Without deleting history, propose a smaller structure: what to merge, what to archive under `docs/archive/`, what to cut. Show me the plan and wait for my approval before moving anything. Keep `plugins/arima/scripts/test/build-docs.test.ts` passing.
