# Form rejudge

- judges: `claude-sonnet-5-5` (effort high); seed 1; sources 1 result file(s); no producer was called.
- deterministic checks recomputed with the current checkers (checks.mjs + intentChecks.mjs @ current checkout). `LOW` = n cases < 10. `self-family` = judge vendor equals producer vendor (self-preference risk). Old = the judge stored in the saved run.
- unavailable(no-input): 0; no output to judge (call error / degraded): 0.

## intent pass

### judge `claude-sonnet-5-5`

| producer | n cases | runs | coverage raw | coverage improved:builtin | full-covered tasks | unsupported/charter | judge errors | flag |
|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 (claude, high) | 6 LOW | 1 | 85.7% (old 66.7%, Δ +0.190) | 65.0% (old 80.0%, Δ -0.150) | 7 | 0.36 (old 0.25) | 1 | self-family |

## Possible blinding leaks (judged as-is)

none
