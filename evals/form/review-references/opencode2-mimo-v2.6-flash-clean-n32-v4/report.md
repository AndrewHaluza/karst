# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --only c09-clean-rename,c10-clean-chunk,c17-clean-tempting,c18-clean-refactor --runs 8 --timeout-min 10`
Case-set version: 4
Build SHA: bfbf0be220019005faf13cfd6645210b95c2cb64
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 32 | n/a | 10/31 32.3% [18.6%, 49.9%] | 0 | 0 | 1 | 158775 | 200.7 |

opencode2: 1 of 32 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
