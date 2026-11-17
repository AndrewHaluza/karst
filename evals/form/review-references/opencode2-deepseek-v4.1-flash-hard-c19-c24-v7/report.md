# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/deepseek-v4.1-flash --only c19-unit-mismatch,c20-lost-update,c21-pagination,c22-path-prefix,c23-regex-state,c24-contract-break --runs 6 --timeout-min 10`
Case-set version: 7
Build SHA: ae02143d5447b3f992ecef692562700f86a7091c
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/deepseek-v4.1-flash | default | 36 | 36/36 100.0% [90.4%, 100.0%] | n/a | 0 | 0 | 0 | 151716 | 48.4 |

opencode2: 0 of 36 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
