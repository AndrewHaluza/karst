# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --only c11-stale-closure,c12-tz-boundary,c13-swallowed-error,c14-mutated-arg,c15-auth-inverted,c16-two-subtle,c17-clean-tempting,c18-clean-refactor --runs 1 --timeout-min 10`
Case-set version: 2
Build SHA: db2cd3d397fb1ed4cf31eca2671f947f78b21bf6
Core versions: unknown

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 8 | 1/1 100.0% [20.7%, 100.0%] INSUFFICIENT | 1/1 100.0% [20.7%, 100.0%] INSUFFICIENT | 0 | 0 | 6 | 112657 | 90.2 |

No ranking: a cell has n below 30. Do not draw a conclusion from it.
