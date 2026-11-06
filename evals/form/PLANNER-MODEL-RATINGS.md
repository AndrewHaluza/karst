# Planner Model Ratings (`eval:form --pass plan`)

The pass gives the real karst planner a public Multi-SWE-bench TS issue (title and body only). The planner runs headless in a copy of the repo at the base sha. The judge is blind to the model and sees the hidden gold patch and the F2P tests. Lower notDone and unrequested are better. Higher F2P coverage is better.

Design: `@arch:FORMEVAL-PLAN` in `docs/arch/prompt-metrics.md`. Run: `npm run -s eval:form -- --pass plan --models <id> --judge-model <id>`.

CAUTION: `--publish` replaces this whole file with one generated table. The tables below are kept by hand. Do not use `--publish` on this file unless you restore them.

This file has two separate comparisons. The leaderboard has no added rules. The repeat comparison has added rules. Do not compare values between the two.

## Leaderboard (6 cases, 1 run each)

| Rank | Model | Effort | Provider | Judge | Scored | notDone / case | Unrequested / case | F2P coverage | Static defect rate | Timeouts + errors | Planner tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **claude-opus-5-5** | low | `claude` | claude-sonnet-5-5 (high) | 6/6 | 0.50 | 0.67 | 81% | 0% | 0 | 0.97M |
| 2 | **claude-sonnet-5-5** | high | `claude` | claude-opus-5-5 (low) | 6/6 | 0.67 | 0.67 | 69% | 0% | 0 | 2.38M |
| 3 | **gemini-3.8-flash-medium** | medium | `antigravity` | claude-sonnet-5-5 (high) | 5/6 | 1.00 | 0.80 | 67% | 0% | 1 | n/a |
| 4 | **claude-haiku-5-5** | medium | `claude` | claude-sonnet-5-5 (high) | 6/6 | 1.33 | 1.00 | 38% | 0% | 0 | 1.92M |

- No planner edited the checkout. No row has a judge error or a run with no draft.
- Gemini has 5 scored cases. The 6th case (`vuejs/core:pr-9213`) timed out at 10 minutes. The runner excludes a timeout and never scores it 0. Its means are not comparable to the other rows.
- A judge never scored its own model. The judges differ between rows. Opus was first judged by `gemini-4-argon-medium` (notDone 0.67, unrequested 0.17, F2P 75%). The row above is the Sonnet rejudge of the same drafts. The rank did not change.
- Planner tokens include cache tokens. The Gemini row shows `n/a` because the Antigravity adapter does not report them.

## Per case (notDone / unrequested / F2P: C covered, P partial, - none)

| Case | claude-opus-5-5 | claude-sonnet-5-5 | gemini-3.8-flash-medium | claude-haiku-5-5 |
|---|---|---|---|---|
| mui/material-ui:pr-23806 | 2 / 2 / - | 2 / 2 / - | 3 / 2 / - | 3 / 0 / - |
| vuejs/core:pr-9213 | 1 / 0 / PC | 2 / 1 / PC | timeout | 4 / 2 / -- |
| vuejs/core:pr-8470 | 0 / 0 / C | 0 / 0 / C | 0 / 0 / C | 0 / 1 / C |
| vuejs/core:pr-8785 | 0 / 2 / CC | 0 / 1 / PP | 2 / 2 / PP | 1 / 2 / -- |
| mui/material-ui:pr-23778 | 0 / 0 / C | 0 / 0 / C | 0 / 0 / C | 0 / 0 / C |
| mui/material-ui:pr-24010 | 0 / 0 / C | 0 / 0 / C | 0 / 0 / C | 0 / 1 / C |

## Repeat comparison with added rules (6 cases, 3 runs each)

Opus and Sonnet have 18 runs each. All 36 runs have status `ok` and a judge score. Each run used the rules below with `--plan-extra`:

```text
Rules for this draft:
1. Find the root cause first. Trace the failing behavior in the code to the place that causes it. Name that file in the draft. Do not plan a workaround.
2. List only the work that the issue asks for. Do not add refactors or extra tests.
3. In the constraints field, state the behavior that a test must check.
```

| Model | Effort | Judge | Scored | notDone / case | Unrequested / case | F2P coverage | Static defect rate | Planner tokens | Planner cost | Planner time |
|---|---|---|---|---|---|---|---|---|---|---|
| **claude-opus-5-5** | low | claude-sonnet-5-5 (high) | 18/18 | 0.67 | 0.61 | 77% | 0% | 4.28M | $5.34 | 19 min |
| **claude-sonnet-5-5** | high | claude-opus-5-5 (low) | 18/18 | 1.11 | 0.28 | 65% | 6% | 7.28M | $4.24 | 24 min |

- The planner cost excludes the judge calls. It uses $4 / $20 per 1M input / output tokens for Opus and $2 / $10 for Sonnet. Both models use $0.20 per 1M cache read tokens.
- The cost also uses a cache write price of 1.25 times the input price. At 2 times the input price, the cost is $7.18 for Opus and $5.29 for Sonnet.
- The Sonnet defect is one `invented-path` (`docs/arch`) on `vuejs/core:pr-9213`.

Per case, run by run (F2P: c covered, p partial, n none, with one letter per test):

| Case | Opus notDone | Sonnet notDone | Opus unrequested | Sonnet unrequested | Opus F2P | Sonnet F2P |
|---|---|---|---|---|---|---|
| mui/material-ui:pr-23806 | 3, 2, 3 | 2, 3, 2 | 1, 4, 4 | 0, 0, 0 | n, n, n | n, n, n |
| vuejs/core:pr-9213 | 1, 0, 0 | 3, 2, 2 | 0, 1, 1 | 1, 0, 1 | pc, pc, pc | np, pc, pc |
| vuejs/core:pr-8785 | 0, 1, 2 | 2, 1, 3 | 0, 0, 0 | 2, 0, 1 | cc, cc, pp | pp, pp, pp |
| vuejs/core:pr-8470 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | c, c, c | c, c, c |
| mui/material-ui:pr-23778 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | c, c, c | c, c, c |
| mui/material-ui:pr-24010 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | c, c, c | c, c, c |

Result: Opus at low effort has fewer missing items and higher F2P coverage. Sonnet at high effort has a lower cost and fewer unrequested items. Most Opus unrequested items (9 of 11) are on `mui/material-ui:pr-23806`.

Limits of this comparison:

- Each model has a different judge, because a judge cannot score its own model. No rejudge with one judge exists yet.
- Three of the 6 cases show no difference. One or two cases control most of the result.
- The Sonnet runs were on 2026-11-02. The first 3 Opus runs were on 2026-11-02 and the other 15 were on 2026-11-05 and 2026-11-06. Use the time values with care.
- The first 3 Opus runs cover `vuejs/core:pr-8470`, `vuejs/core:pr-9213`, and `mui/material-ui:pr-23806`. The Opus runs are therefore not one batch.

Commands (`$S` holds the rules file). The results are in `evals/form/plan-references/`:

```sh
# Sonnet, 3 times. Results: plan-2026-11-02T23-42-00-314Z, plan-2026-11-02T23-50-28-570Z, plan-2026-11-02T23-59-39-884Z
npm run -s eval:form -- --pass plan --provider claude --models claude-sonnet-5-5 --effort high --judge-model claude-opus-5-5 --judge-effort low --timeout-min 10 --plan-extra "$S/plan-extra.md"

# Opus, 2 times. Results: plan-2026-11-05T23-47-38-825Z, plan-2026-11-05T23-55-26-311Z
npm run -s eval:form -- --pass plan --provider claude --models claude-opus-5-5 --effort low --judge-model claude-sonnet-5-5 --judge-effort high --timeout-min 10 --plan-extra "$S/plan-extra.md"

# Opus, the 3 cases with no earlier run. Result: plan-2026-11-06T00-03-18-295Z
npm run -s eval:form -- --pass plan --provider claude --models claude-opus-5-5 --effort low --only vuejs/core:pr-8785,mui/material-ui:pr-23778,mui/material-ui:pr-24010 --judge-model claude-sonnet-5-5 --judge-effort high --timeout-min 10 --plan-extra "$S/plan-extra.md"

# Opus, the 3 earlier cases. Result: plan-2026-11-02T23-37-41-936Z
npm run -s eval:form -- --pass plan --provider claude --models claude-opus-5-5 --effort low --only mui/material-ui:pr-23806,vuejs/core:pr-9213,vuejs/core:pr-8470 --judge-model claude-sonnet-5-5 --judge-effort high --timeout-min 10 --plan-extra "$S/plan-extra.md"
```

## Known gaps

These gaps apply to the leaderboard.

- n is 6 cases and 1 run each. Use the table as an example, not as a trend. Two runs of one model can differ.
- The 6 cases are easy for the stronger models. Three of the 6 are clean for every model except Haiku, which adds unrequested items on two of them.
- The hard cases (`vuejs/core:pr-9213`, `mui/material-ui:pr-23806`) lose points for every model. Opus and Sonnet both chose a `_fb` key suffix on `vuejs/core:pr-9213`, not the gold fix in `renderer.ts`.
- The instructions arrive in the prompt, not in the system channel. The kickoff has the added line "No user is present. Propose the draft now."
- The rank key is notDone, then F2P coverage. The judge can change a score on one case. Different judges agreed on the clean cases and on the Opus ranking.
