# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider claude --model claude-sonnet-5-5 --runs 3 --timeout-min 8`
Case-set version: 2
Build SHA: d7082194873df64c9f26c757de499dad0aa2fee7
Core versions: unknown

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | default | 54 | 51/51 100.0% [93.0%, 100.0%] | 3/12 25.0% [8.9%, 53.2%] INSUFFICIENT | 0 | 0 | 0 | 75914 | 7.9 |

No ranking: a cell has n below 30. Do not draw a conclusion from it.
