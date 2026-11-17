# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider claude --model claude-sonnet-5-5 --only c17-clean-tempting,c18-clean-refactor --runs 5 --timeout-min 10`
Case-set version: 2
Build SHA: 90cae0bb55eed0c46eec1abbcc59a4f7f4bdd5db
Core versions: unknown

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | default | 10 | n/a | 3/7 42.9% [15.8%, 75.0%] INSUFFICIENT | 0 | 0 | 3 | 69448 | 17.4 |

claude: 3 of 10 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
