# Form rejudge

- judges: `claude-haiku-5-5` (effort medium); seed 1; sources 2 result file(s); no producer was called.
- deterministic checks recomputed with the current checkers (checks.mjs + intentChecks.mjs @ current checkout). `LOW` = n cases < 10. `self-family` = judge vendor equals producer vendor (self-preference risk). Old = the judge stored in the saved run.
- unavailable(no-input): 0; no output to judge (call error / degraded): 0.

## intent pass

### judge `claude-haiku-5-5`

| producer | n cases | runs | coverage raw | coverage improved:builtin | full-covered tasks | unsupported/charter | judge errors | flag |
|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 (claude, low) | 6 LOW | 1 | 66.7% (old 60.0%, Δ +0.067) | 72.2% (old 37.5%, Δ +0.347) | 6 | 0.00 (old 0.27) | 0 | self-family |
| claude-sonnet-5-5 (claude, high) | 6 LOW | 1 | 41.7% (old 66.7%, Δ -0.250) | 75.0% (old 80.0%, Δ -0.050) | 7 | 0.08 (old 0.25) | 0 | self-family |

## Possible blinding leaks (judged as-is)

none
