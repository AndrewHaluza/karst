# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider antigravity --model gemini-3.8-flash-medium --only c01-loop-bound,c02-sql-concat,c03-null-guard,c04-expiry,c05-missing-await,c06-path-join,c07-math-two,c08-retry-cache,c11-stale-closure,c12-tz-boundary,c13-swallowed-error,c14-mutated-arg,c15-auth-inverted,c16-two-subtle --runs 2 --timeout-min 15`
Case-set version: 5
Build SHA: f3d265ac540b4d193bc898b58bed36ba943229b2
Core versions: antigravity 1.5.9

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | default | 28 | 34/34 100.0% [89.8%, 100.0%] | n/a | 0 | 0 | 0 | n/a | 73.0 |

antigravity: 0 of 28 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
