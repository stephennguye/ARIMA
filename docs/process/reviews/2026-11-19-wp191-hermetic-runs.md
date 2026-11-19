# WP-191: hermetic runs decision (2026-11-19)

Question: what should a role run load of the machine it runs on? Decision: **only the project's settings, plus the ARIMA plugin loaded explicitly**; not `--bare`. Real runs recorded below; Claude Code 2.1.328, seat authentication, default model, three real `claude -p` runs through `runAgent` (the real wrapper), each under a 0.50 USD cap and 4 turns.

## The runs

The prompt was the same each time (developer role): create `note.txt` with the Write tool, then reply `done`. "Hook active" means the PostToolUse audit hook of the ARIMA plugin recorded `tool.used:Write` in `.arima/events.jsonl`.

| Run | Flags beyond the baseline | Result | Turns | Input | Output | Cache read | Cache creation | Context total | Cost (est. USD) | Hook active | `note.txt` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A, not isolated | none (the person's own settings, plugins, MCP servers and slash commands load) | pass | 2 | 4 | 99 | 68,602 | 43,093 | 111,699 | 0.180 | yes | created |
| B, isolated | `--setting-sources project --strict-mcp-config --disable-slash-commands` | pass | 2 | 4 | 101 | 26,444 | 26,627 | 53,071 | 0.220 | yes | created |
| C, isolated, guard hook hung | as B, but the plugin copy's PreToolUse hook sleeps 30 s with `timeout: 2` and `onFailure: "block"` | pass (reply: the hook blocked the call) | 2 | 4 | 338 | 50,950 | 2,134 | 53,088 | 0.034 | n/a (the call was blocked before it ran) | **not created** |

Reading the numbers:

- Isolation **halves the context** a run starts with (111,699 to 53,071 tokens): the person's own plugins, skills and MCP servers were most of it. Fewer tokens mean less to leak or be influenced by, and less to pay for on a cold cache.
- The **cost** of B is slightly higher than A only because A read most of its context from a warm cache (cache reads are cheaper than cache creation). Run C shows the warm-cache cost of the isolated set (0.034). These are estimated consumption on a seat plan, not money, and a single sample each: do not read more into the 0.18 against 0.22.
- The guard's audit hook still fires under isolation (B), so the ARIMA plugin loaded through `--plugin-dir` is not affected by `--setting-sources project`.

## Decision and what it changes

1. **Default:** `ISOLATION_FLAGS = --setting-sources project --strict-mcp-config --disable-slash-commands`, appended to every role run (`run-agent.ts`). Switch off only with `runtime.isolate_user_settings: false` in `arima.yaml`. `hermetic.test.ts` asserts the exact flag set and that `--bare` and `--safe-mode` are never used.
2. **Not `--bare`:** the Claude Code documentation (as summarised by the docs agent, 2026-11-19; quote the exact wording before relying on it: https://code.claude.com/docs/en/headless) says `--bare` skips hook auto-discovery and does not run hooks from a `--plugin-dir` plugin. ARIMA's guard is such a hook, so `--bare` would switch off the safety envelope.
3. **Guard failure mode:** `hooks/hooks.json` now sets `"onFailure": "block"` on the PreToolUse guard (the key exists from Claude Code 2.1.295; `claude plugin validate --strict` accepts it). **Verified live in run C**: a hung guard (past its timeout) blocked the tool call instead of letting it through. The audit hooks (PostToolUse, Stop, SubagentStop, PermissionDenied) stay fail-open on purpose, because they must never stop work. `hermetic.test.ts` checks both.
4. **Scrub script:** `scripts/scrub-fixture.mjs` (tested) removes session ids and other UUIDs, absolute paths, user and host names, e-mail addresses and token-shaped strings from a recorded `claude -p` result, keeping shape and numbers, before it is committed as a fixture.

## Not verified (said plainly)

- **The default fail-open behaviour** (a hung hook without `onFailure` lets the call through) is from the documentation only; no fourth run was spent on it.
- **Whether `--setting-sources project` also drops a user-level hook** was not tested: the person's settings carry no ARIMA-relevant hook in this environment. The flag set is what the documentation describes (load only user, project or local sources; here only project).
- **Seat usage:** the three runs used about 0.43 estimated USD of the owner's seat; no API key was used.
- The runs were made in a scratch project outside the repository, which was removed afterwards; no raw result is committed (it would hold a session id and local paths; the scrub script exists for the next recording).
