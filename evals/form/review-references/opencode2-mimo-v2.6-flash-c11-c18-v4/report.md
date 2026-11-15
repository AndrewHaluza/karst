# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --only c11-stale-closure,c12-tz-boundary,c13-swallowed-error,c14-mutated-arg,c15-auth-inverted,c16-two-subtle,c17-clean-tempting,c18-clean-refactor --runs 2 --timeout-min 10`
Case-set version: 4
Build SHA: 9abc0fb7b79adff93cea03a869145a7c6f17e960
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 16 | 13/13 100.0% [77.2%, 100.0%] INSUFFICIENT | 1/3 33.3% [6.1%, 79.2%] INSUFFICIENT | 0 | 0 | 2 | 135446 | 157.1 |

opencode2: 2 of 16 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
