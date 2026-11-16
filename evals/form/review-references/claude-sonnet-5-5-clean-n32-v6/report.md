# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider claude --model claude-sonnet-5-5 --only c09-clean-rename,c10-clean-chunk,c17-clean-tempting,c18-clean-refactor --runs 8 --timeout-min 10`
Case-set version: 6
Build SHA: 8d4cf4314dabeefaaa2274ac29e9ebe6499a2a51
Core versions: claude 2.1.325 (Claude Code)

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | default | 32 | n/a | 3/32 9.4% [3.2%, 24.2%] | 0 | 0 | 0 | 74312 | 5.8 |

claude: 0 of 32 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
