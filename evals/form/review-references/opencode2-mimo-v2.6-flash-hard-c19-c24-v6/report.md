# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --only c19-unit-mismatch,c20-lost-update,c21-pagination,c22-path-prefix,c23-regex-state,c24-contract-break --runs 3 --timeout-min 10`
Case-set version: 6
Build SHA: 975146984b68076ef31ddb8c93ead9decd8b9b9e
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 18 | 15/18 83.3% [60.8%, 94.2%] INSUFFICIENT | n/a | 2 | 0 | 0 | 135329 | 110.5 |

opencode2: 0 of 18 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
