# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider antigravity --model gemini-3.8-flash-medium --only c11-stale-closure,c12-tz-boundary,c13-swallowed-error,c14-mutated-arg,c15-auth-inverted,c16-two-subtle,c17-clean-tempting,c18-clean-refactor --runs 1 --timeout-min 10`
Case-set version: 2
Build SHA: db2cd3d397fb1ed4cf31eca2671f947f78b21bf6
Core versions: unknown

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | default | 8 | 5/5 100.0% [56.6%, 100.0%] INSUFFICIENT | 0/2 0.0% [0.0%, 65.8%] INSUFFICIENT | 1 | 0 | 2 | n/a | 78.1 |

No ranking: a cell has n below 30. Do not draw a conclusion from it.
