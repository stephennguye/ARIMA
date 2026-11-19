# 04 Agent and feature build protocol

The fixed procedure for taking **one** agent (or one skill with its script) from a spec card to a proven component. It is the "go deep" half of the plan: Stage 1 builds the scaffolding that makes these steps possible; Stages 2 to 4 apply this protocol once per component, in the order of `02-stages.md`.

A component is built by **one session at a time**; a different session may take the next step, because every step leaves its result in a file named below.

## Preconditions (a card is "ready to build" only when all are true)

- Its work package in `work-packages.yaml` has all dependencies `done`.
- The card (`agents/<role>.md` or `features/<name>.md`) has no `TBD` and cites the spec sections it implements.
- The contracts it uses are frozen (`03-contracts.md`), or the package that freezes them is in its dependency list.
- The owner has answered any owner decision the card lists under "Open decisions".

## The eight steps

| # | Step | Output (file) | Done when |
| --- | --- | --- | --- |
| 1 | **Card review**: read the card against the spec section and the contracts; list what is missing or contradictory; fix the card (or write an ADR if the spec must change) | updated card; ADR if needed | Card's checklist has no open item |
| 2 | **Contract fixtures**: for every input kind, a synthetic fixture (a story, a mirror excerpt, a diff...); for every output, golden **valid** and **invalid** examples, including the adversarial ones in the card (missing evidence, secret in output, forbidden path, instruction hidden in an `untrusted` block) | `test/fixtures/agents/<role>/...` | Validators accept every valid example and reject every invalid one, for the right reason |
| 3 | **Envelope tests**: the role's tool list in `roles.ts` equals the card's tools; a battery of forbidden actions for this role is blocked (by deny rule, by guard, or documented as advisory with the compensating control) | `roles.ts`, `guard-hardening.test.ts` additions | Every forbidden action in the card has a test that tries it |
| 4 | **Stub agent**: a deterministic fake that, for each fixture input, writes the golden outputs; plug it into the engine integration test (`dispatch`, `report collector`, `outbox`) | `test/fixtures/stub-agents/<role>.mjs` | The engine test passes with the stub and **fails** when the stub emits an invalid output |
| 5 | **Agent file**: author `agents/<role>.md` (eight sections, card's Must-nots, untrusted-data rule, report contract, writable folders, citation rule) and the skill (if any) | agent file, `SKILL.md` | Structure test passes (`agents.test.ts`, `skills.test.ts`) |
| 6 | **Real smoke**: one real headless run per mode on the dev project, capped (a few cents to a few tens of cents); its raw result and report are saved scrubbed as a fixture | `test/fixtures/agents/<role>/real-*.json` | Report validates; outputs pass the card's deterministic checks; cost recorded in the card |
| 7 | **Evals**: the card's scenario set (normal, ambiguous, adversarial, failure) run against the real agent; each scenario has deterministic graders; judgment-heavy scenarios add a verifier agent that tries to disprove | `evals/<role>/*.eval.ts`, results table in the card | Pass-rate threshold in the card met on N runs; failures analysed and fixed or accepted in writing |
| 8 | **Judge checkpoint and flip**: an independent read-only agent attacks the component (reads card, code, tests; attempts bypasses and mutations); findings answered; docs and `STATE.md` updated; package marked `done` | `docs/process/reviews/<date>-<component>.md` | No open blocker or major; `05-verification.md` definition of done holds |

Steps 1 to 4 need no model call. Step 5 needs none. Steps 6 and 7 are the only ones that spend money; they run last, so a defect in the contract is found before any money is spent.

## Rules that apply to every component

1. **Separation of duties.** A component that produces a result is never the component that grades it. Developer ≠ reviewer ≠ QA; the eval grader is code first, a verifier agent second, never the same agent that produced the output.
2. **Inputs are data.** The packet's `untrusted` blocks, Notion text, issue text and web pages are quoted and never followed as instructions. Every card names its adversarial fixtures (an instruction planted in a story description, in a file, in a PR comment).
3. **Outputs are validated before they matter.** The report, the outbox entries and the written files pass schema, template, secret scan and state-machine guard before any state changes.
4. **Every claim has evidence** (`file:line` or item id); guesses are marked as assumptions and surface in the digest.
5. **Questions beat inventions.** Where the card says "escalates when", the correct behaviour is a question record, and a fixture asserts that the agent raises it instead of guessing.
6. **Budget is a contract.** Each card states the run cap, the turn cap and the expected cost; an eval records actual cost and the card is updated if it is more than 1.5 times the estimate.
7. **Idempotence.** Re-running the same work unit (retry after a lost response, a re-dispatched item) must not duplicate artifacts, outbox entries or Notion rows; a test covers it.
8. **No hidden state.** Nothing the agent needs may live outside the packet, the repo and the mirror; a test runs the agent with an empty environment except the packet.

## Card structure (every file in `agents/`; `features/` uses the same headings where they apply)

`agents/_card-template.md` is the template; the build-docs test requires each agent card to contain these headings:

1. Identity and purpose
2. Triggers and preconditions (conditions as IF/THEN; the state the world must be in)
3. Inputs and input handling (exact files and ids; how each is validated; what is untrusted; what the agent must not read)
4. Processing outline (the steps an agent follows; where it must stop and ask)
5. Outputs (artifacts, folders, formats, report fields, outbox entries; what validates each)
6. Tools and permissions (exact allow-list, denied tools, protected paths; enforcement and compensating controls)
7. Conditions and rules (profile-dependent behaviour, size limits, ordering, hand-offs to and from other roles)
8. Failure handling and escalation (what each failure looks like, who sees it, what state results)
9. Budget and cost
10. Test and eval plan (fixtures, graders, scenarios, thresholds)
11. Dependencies (work packages, contracts, other agents)
12. Open decisions and status
