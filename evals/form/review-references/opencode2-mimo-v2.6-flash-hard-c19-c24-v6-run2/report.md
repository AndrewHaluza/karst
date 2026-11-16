# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --only c19-unit-mismatch,c20-lost-update,c21-pagination,c22-path-prefix,c23-regex-state,c24-contract-break --runs 3 --timeout-min 10`
Case-set version: 6
Build SHA: 1bc1d0989ac102790204e3e483d7c7e5ab329e6c
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 18 | 16/18 88.9% [67.2%, 96.9%] INSUFFICIENT | n/a | 2 | 0 | 0 | 137124 | 123.6 |

opencode2: 0 of 18 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
