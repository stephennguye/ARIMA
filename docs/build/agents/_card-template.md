# Agent card: <role>

> Status: planned | stub | built | verified. Work package: WP-xxx. Spec: section 5.x and the phase sections named below. Contracts: `03-contracts.md` sections used (list them). Do not copy spec text; cite it, and say precisely what is added.

## 1. Identity and purpose

One paragraph: what this role is responsible for, in the spec's words, and the single sentence that says what "good" looks like.

## 2. Triggers and preconditions

| Trigger (work-unit `kind`) | Preconditions (IF ... THEN dispatch) | Hand-off in | Hand-off out |
| --- | --- | --- | --- |

Conditions are rules the dispatcher checks **before** starting a run; each names the item state and the data that must exist.

## 3. Inputs and input handling

| Input (path or id) | Source | Validation before it enters the packet | Trust | Why the role needs it |
| --- | --- | --- | --- | --- |

Then: what the role must **not** be given or read (and the control that enforces it), and the adversarial inputs this card tests (an instruction planted in a story, a file, a PR comment, a web page).

## 4. Processing outline

Numbered steps the agent follows, with the point at which it must stop and raise a question. Not a prompt; the behaviour the prompt must produce.

## 5. Outputs

| Output | Location / outbox entry | Format and required content | Validated by |
| --- | --- | --- | --- |

Include the agent-report fields this role must and must not fill (`03-contracts.md` section 3.3) and the exact Notion properties it may propose.

## 6. Tools and permissions

Exact allow-list (from `roles.ts`), denied tools, protected paths, and for each forbidden action: the control that stops it (deny rule, guard rule, sandbox, branch protection) and whether it is enforced or advisory today.

## 7. Conditions and rules

Profile-dependent behaviour (solo-lite, client-project, regulated), size and ordering limits, interaction with other roles, and the separation-of-duties rule that applies.

## 8. Failure handling and escalation

| Situation | What the run looks like | Result recorded | Item state | Who is told |
| --- | --- | --- | --- | --- |

## 9. Budget and cost

Run cap, turn cap, expected cost per run and per item (estimate until measured), and where the measurement is recorded.

## 10. Test and eval plan

Fixtures (valid, invalid, adversarial), graders (deterministic first), scenarios with expected outcomes, pass threshold, number of runs, verifier agent if judgment-heavy, and the results table (empty until step 7 of `04-agent-build-protocol.md`).

## 11. Dependencies

Work packages, contracts, scripts and other agents this card needs.

## 12. Resolved decisions and status

A table of decisions (Decision | Reason | Implemented by) and a checklist of the eight protocol steps with their state. An item stays open only if it is a critical blocker for the owner (`09-owner-decisions.md` section 1), marked OWNER.
