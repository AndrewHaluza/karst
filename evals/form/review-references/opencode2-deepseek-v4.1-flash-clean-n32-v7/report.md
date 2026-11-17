# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/deepseek-v4.1-flash --only c09-clean-rename,c10-clean-chunk,c17-clean-tempting,c18-clean-refactor --runs 8 --timeout-min 10`
Case-set version: 7
Build SHA: ae02143d5447b3f992ecef692562700f86a7091c
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/deepseek-v4.1-flash | default | 32 | n/a | 13/31 41.9% [26.4%, 59.2%] | 0 | 1 | 0 | 144572 | 49.4 |

opencode2: 1 of 32 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
