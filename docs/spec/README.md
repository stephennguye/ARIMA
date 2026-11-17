# Master specification

Place the master specification here as **`ARIMA-Master-Spec.md`**.

How to get it:

1. Open the "ARIMA Master Specification" doc in Claude.
2. Use the doc's Export menu → **Markdown**.
3. Save the file as `docs/spec/ARIMA-Master-Spec.md` in this repo and commit it.

The two diagrams in the doc (architecture, ticket states) export as text placeholders. Their content is fully described in spec §3.2–3.3 and §7.1, so nothing is lost for the build.

When the spec changes: re-export, commit with message `docs(spec): vX.Y` and bump the version table in spec §0.
