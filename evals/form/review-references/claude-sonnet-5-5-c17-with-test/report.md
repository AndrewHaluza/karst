# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider claude --model claude-sonnet-5-5 --only c17-clean-tempting,c18-clean-tempting --runs 5 --timeout-min 10`
Case-set version: 2
Build SHA: afe7389c83ad8c9b53374173c03818504e496433
Core versions: claude 2.1.325 (Claude Code)

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | default | 5 | n/a | 0/5 0.0% [0.0%, 43.4%] INSUFFICIENT | 0 | 0 | 0 | 75277 | 6.0 |

claude: 0 of 5 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
