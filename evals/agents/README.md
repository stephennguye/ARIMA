# Real-agent evals

One real role, one real `claude -p`, one scenario of its card (section 10 of `docs/build/agents/<role>.md`), graded by deterministic graders first (the report validates, only allowed files changed, no secret, no forbidden command in the event log, a clean commit) and, for judgement-heavy scenarios, by a separate verifier agent that tries to disprove the claims. These cost seat usage, so they are **never** part of `npm run eval` or CI and do nothing unless asked.

```
npm run build
ARIMA_REAL_EVALS=1 ARIMA_REAL_EVALS_RUNS=5 ARIMA_REAL_EVALS_CAP_USD=3 npm run eval:agents
```

| Variable | Meaning |
| --- | --- |
| `ARIMA_REAL_EVALS=1` | required; otherwise every file here is skipped |
| `ARIMA_REAL_EVALS_RUNS` | runs per scenario (default 1; the card thresholds assume 5, for example 4 of 5) |
| `ARIMA_REAL_EVALS_CAP_USD` | estimated cost allowed for one test file (default 3); the next run refuses once it is reached |

Files are named `<role>/<scenario>.real.eval.ts` (`vitest.agents.config.ts` picks up only that pattern). `_support.ts` renders the same packet the dispatcher would, runs the built `arima-run-agent`, and returns the final message and the cost. Record the measured pass rate and cost in the role card's results table.

Existing: `devops/env-plan.real.eval.ts` (card scenario: the environment matrix from a synthetic SAD; 1 run on 2026-11-20 passed at about 0.20 USD).
