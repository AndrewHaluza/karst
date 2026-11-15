# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider claude --model claude-sonnet-5-5 --only c14-mutated-arg,c15-auth-inverted --runs 5 --timeout-min 10`
Case-set version: 4
Build SHA: d4ea8ab3d0518b796e7fe26c2f53a56a12357160
Core versions: claude 2.1.325 (Claude Code)

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | default | 10 | 10/10 100.0% [72.2%, 100.0%] INSUFFICIENT | n/a | 0 | 0 | 0 | 75384 | 8.7 |

claude: 0 of 10 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
