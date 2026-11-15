# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider antigravity --model gemini-3.8-flash-medium --only c11-stale-closure,c12-tz-boundary,c13-swallowed-error,c14-mutated-arg,c15-auth-inverted,c16-two-subtle,c17-clean-tempting,c18-clean-refactor --runs 3 --timeout-min 15`
Case-set version: 4
Build SHA: 9abc0fb7b79adff93cea03a869145a7c6f17e960
Core versions: antigravity 1.5.9

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | default | 24 | 21/21 100.0% [84.5%, 100.0%] INSUFFICIENT | 0/6 0.0% [0.0%, 39.0%] INSUFFICIENT | 0 | 0 | 0 | n/a | 79.4 |

antigravity: 0 of 24 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
