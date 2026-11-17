# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider antigravity --model gemini-3.8-flash-medium --only c19-unit-mismatch,c20-lost-update,c21-pagination,c22-path-prefix,c23-regex-state,c24-contract-break --runs 6 --timeout-min 10`
Case-set version: 6
Build SHA: f213fe63014394d95c96482d9a3c095bf2705174
Core versions: antigravity 1.5.9

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | default | 36 | 35/35 100.0% [90.1%, 100.0%] | n/a | 0 | 1 | 0 | n/a | 78.6 |

antigravity: 1 of 36 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
