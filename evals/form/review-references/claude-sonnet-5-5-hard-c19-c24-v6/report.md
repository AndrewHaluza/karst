# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider claude --model claude-sonnet-5-5 --only c19-unit-mismatch,c20-lost-update,c21-pagination,c22-path-prefix,c23-regex-state,c24-contract-break --runs 6 --timeout-min 10`
Case-set version: 6
Build SHA: 8d4cf4314dabeefaaa2274ac29e9ebe6499a2a51
Core versions: claude 2.1.325 (Claude Code)

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | default | 36 | 30/36 83.3% [68.1%, 92.1%] | n/a | 6 | 0 | 0 | 100529 | 9.9 |

claude: 0 of 36 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
