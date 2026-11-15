# Review findings bench

Command: `npm run -s eval:form -- --pass review --provider opencode2 --model opencode-go/mimo-v2.6-flash --only c17-clean-tempting --runs 8 --timeout-min 10`
Case-set version: 5
Build SHA: f3d265ac540b4d193bc898b58bed36ba943229b2
Core versions: opencode2 opencode v2.2.7

| core | model | effort | runs | recall | clean cases with a false finding | blocking false | errors | timeouts | tokens/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode2 | opencode-go/mimo-v2.6-flash | default | 8 | n/a | 4/8 50.0% [21.5%, 78.5%] INSUFFICIENT | 0 | 0 | 0 | 172285 | 325.0 |

opencode2: 0 of 8 calls did not finish.
Recall and false-finding rates count only the runs that finished ok.

No ranking: a cell has n below 30. Do not draw a conclusion from it.
