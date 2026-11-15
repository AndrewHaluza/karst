# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --only c12-tz-boundary,c13-swallowed-error,c14-mutated-arg,c15-auth-inverted,c16-two-subtle,c17-clean-tempting,c18-clean-refactor --runs 1 --timeout-min 6`
Case-set version: 2
Build SHA: db7c70f1119edab06c5200fa320b3169666d914f
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 7 | 5/6 83.3% [43.6%, 97.0%] INSUFFICIENT | 0/2 0.0% [0.0%, 65.8%] INSUFFICIENT | 1 | 0 | 0 | 141130 | 155.8 |

opencode2: 0 of 7 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
