# Feature spec: <feature name>

> Status: <built | partly built | planned>. Work packages: <WP-nnn, ...>. Spec: <section numbers of `docs/spec/ARIMA-Master-Spec.md`>. Contracts: <sections of `03-contracts.md`>. ADRs and owner decisions: <ADR-nnnn, D-nn, Snn>.
>
> Tags in this file: `[BUILT]` exists in code and has tests; `[SPEC]` required by the master spec, not built; `[PROPOSED]` introduced by this document set and frozen by the work package named next to it. Every statement cites a file (and a line or test name where it helps) or a spec section. Where something is unknown, write an open decision under section 12; never invent behaviour.

This file is the template for `docs/build/features/*.md`. A feature spec is one command, one script or one engine component. It uses the same discipline as an agent card (`04-agent-build-protocol.md`) but for deterministic code. Copy the headings below unchanged; delete this paragraph and the guidance in italics.

## 1. Purpose and spec refs

_What the feature is for, in two or three sentences, and what "good" means (observable). List the spec sections and decisions it implements, and the sections it deliberately does not implement._

## 2. Command or entry point and arguments

_The skill (`/arima:...`) if any, the script (`arima-...`, bundle path under `scripts/dist/`), and every argument and environment variable it reads, with default, type and who may pass it. Say which of these an agent role may never run (`roles.ts`, guard)._

## 3. Preconditions (IF/THEN)

_Rules written as "IF <state> THEN <action>; ELSE <action>". Each names the file or test that enforces it, or says `NOT ENFORCED YET` with the work package that will._

## 4. Inputs and input handling (validation, trust)

| Input | Source | Validation before use | Trust | Why |
| --- | --- | --- | --- | --- |

_Mark what is untrusted (Notion text, PR text, tool output, agent output) and where it is quoted or scanned. Say what the feature must not read._

## 5. Processing steps

_Numbered, in execution order. Mark each point where it stops or refuses with **STOP** and the exit code or result it produces. Mark each point where it takes a lock, spends money or calls the network._

## 6. Outputs and side effects

| Output | Location or system | Format | Written by | Validated by |
| --- | --- | --- | --- | --- |

_Cover files under `.arima/`, Notion rows (through the outbox only), git refs and commits, events (type and data), ledger rows, stdout and stderr. State what is idempotent._

## 7. Exit codes

_Must agree with the registry in `03-contracts.md` section 8. One row per code: value, meaning, what the user or calling skill does. A code the registry does not list yet is written `PROPOSED` and added to the registry in the same change that builds it._

| Code | Meaning | Registry status |
| --- | --- | --- |

## 8. Conditions and rules

_Profile-dependent behaviour (`solo-lite`, `client-project`, `regulated`), state-dependent behaviour (item status, gate status), the hard stops involved (spec 11.1; ids in `hardstops.ts`), ordering rules and limits. Separate what is enforced by code from what is advisory._

## 9. Failure handling

| Failure | What it looks like | Result recorded (event, ledger, exit code) | State left behind | Who is told |
| --- | --- | --- | --- | --- |

_Say what is safe to re-run and what is not. A failure must never leave a half-applied write unrecorded._

## 10. Tests and verification

_Existing test files by name (under `plugins/arima/scripts/test/`) and what each proves; then the tests still to write, each as a sentence that can fail. Say which checks need a real Notion workspace or a real GitHub repository (the live tier) and which run on mocks and temporary git repositories. Windows and Linux CI both apply to anything touching paths, processes or git._

## 11. Dependencies

_Work packages (from `work-packages.yaml`), contracts, other features, owner decisions._

## 12. Status and open decisions

_One line per capability tagged `[BUILT]`, `[SPEC]` or `[PROPOSED]`. Then the open decisions, each with an id (existing `Snn`, `D-nn`, `Q-nn`, or `OD-<feature>-n` if new), the question, and what is blocked by it. Then the discrepancies found between code, spec and these documents, if any, with file and line._
