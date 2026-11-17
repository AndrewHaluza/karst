# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider antigravity --model gemini-3.8-flash-medium --only c09-clean-rename,c10-clean-chunk,c17-clean-tempting,c18-clean-refactor --runs 8 --timeout-min 15`
Case-set version: 4
Build SHA: bfbf0be220019005faf13cfd6645210b95c2cb64
Core versions: antigravity 1.5.9

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | default | 32 | n/a | 0/32 0.0% [0.0%, 10.7%] | 0 | 0 | 0 | n/a | 62.9 |

antigravity: 0 of 32 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
