# Planner Model Ratings (`eval:form --pass plan`)

The pass gives the real karst planner a public Multi-SWE-bench TS issue (title and body only). The planner runs headless in a copy of the repo at the base sha. The judge is blind to the model and sees the hidden gold patch and the F2P tests. Lower notDone and unrequested are better. Higher F2P coverage is better.

Design: `@arch:FORMEVAL-PLAN` in `docs/arch/prompt-metrics.md`. Run: `npm run -s eval:form -- --pass plan --models <id> --judge-model <id>`.

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

## Known gaps

- n is 6 cases and 1 run each. Use the table as an example, not as a trend. Two runs of one model can differ.
- The 6 cases are easy for the stronger models. Three of the 6 are clean for every model except Haiku, which adds unrequested items on two of them.
- The hard cases (`vuejs/core:pr-9213`, `mui/material-ui:pr-23806`) lose points for every model. Opus and Sonnet both chose a `_fb` key suffix on `vuejs/core:pr-9213`, not the gold fix in `renderer.ts`.
- The instructions arrive in the prompt, not in the system channel. The kickoff has the added line "No user is present. Propose the draft now."
- The rank key is notDone, then F2P coverage. The judge can change a score on one case. Different judges agreed on the clean cases and on the Opus ranking.
