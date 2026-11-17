# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --runs 3 --timeout-min 8`
Case-set version: 1
Build SHA: d7082194873df64c9f26c757de499dad0aa2fee7
Core versions: unknown

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 30 | 30/30 100.0% [88.6%, 100.0%] | 2/6 33.3% [9.7%, 70.0%] INSUFFICIENT | 1 | 0 | 0 | 126307 | 78.1 |

No ranking: a cell has n below 30. Do not draw a conclusion from it.
