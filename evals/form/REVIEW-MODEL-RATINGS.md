# Review findings bench: model ratings

Date: 2026-11-15. Command: `npm run -s eval:form -- --pass review`. The scoring has no model judge.
Every cell with n below 30 is INSUFFICIENT. Do not rank cores from this table.

## Case set v1 (10 cases, 3 runs each)

| Core | Model | Recall | Clean cases with a false finding | Blocking false | Seconds per run |
|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | 30/30 | 0/6 | 0 | 7.3 |
| antigravity | gemini-3.8-flash-medium | 30/30 | 0/6 | 0 | 60.7 |
| opencode2 | opencode-go/mimo-v2.6-flash | 30/30 | 2/6 | 1 | 78.1 |

The antigravity row comes from the run log. Two runs wrote one report directory, so the report file was overwritten. A later commit fixes the name.
The claude v1 row is a subset of the v2 report. The opencode2 report is in `review-references/opencode2-mimo-v2.6-flash-v1/`.

## Case set v2 (18 cases)

| Core | Model | Recall | Clean cases with a false finding | Note |
|---|---|---|---|---|
| claude | claude-sonnet-5-5 | 51/51 | 3/12 | Case `c17-clean-tempting` failed in 3 of 3 runs. Report in `review-references/claude-sonnet-5-5-v2/`. |
| antigravity | gemini-3.8-flash-medium | not scored | not scored | Stopped before the report. New cases c11 to c16 returned `ok` in 18 of 18 calls. Case c17 run 1 timed out at 8 minutes. |
| opencode2 | opencode-go/mimo-v2.6-flash | not scored | not scored | Stopped before the report. Cases c11 to c15 returned `ok` in 15 of 15 calls. Case c16 timed out in 3 of 3 runs. |

## Findings

- Recall is 100% for every core on v1, so v1 cannot rank the cores.
- The new clean case `c17-clean-tempting` is the first case that separates a core. Claude reports false findings on it.
- The slow cores time out on the harder cases at 8 minutes. Use `--timeout-min 15` for them.
- A run writes its report only at the end. A stopped run loses its data. Add a partial write if long runs are common.

## Next steps

1. Rerun antigravity and opencode2 on `c11` to `c18` with `--timeout-min 15`.
2. Check the false findings of claude on `c17` in `results.json`. Decide if the case or the model is wrong.
3. Add cases until each cell reaches n of 30.
