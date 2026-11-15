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

## Case set v2 (cases c11 to c18, 1 run each, except claude)

The case `c17-clean-tempting` was wrong in the first v2 run. Its code cast parsed JSON without a check. The fix is commit `db2cd3d39`. The claude row for v2 below used the old `c17`.

| Core | Model | Recall | Clean cases with a false finding | Calls with `ok` | Note |
|---|---|---|---|---|---|
| claude | claude-sonnet-5-5 | 51/51 (18 cases, 3 runs) | 3/12 | all | All 3 false findings came from the old `c17`. A run of the fixed `c17` gave 0/2 false findings and 1 timeout. Reports in `review-references/claude-sonnet-5-5-v2/` and `claude-sonnet-5-5-c17-fixed/`. |
| antigravity | gemini-3.8-flash-medium | 5/5 | 0/2 | 6 of 8 | `c13` and `c14` timed out at 10 minutes. Report in `review-references/antigravity-gemini-3.8-flash-medium-c11-c18/`. |
| opencode2 | opencode-go/mimo-v2.6-flash | 1/1 | 1/1 | 2 of 8 | Six calls timed out at 10 minutes. The core answered a test call in 10 seconds, so a load on the machine may be a cause. Report in `review-references/opencode2-mimo-v2.6-flash-c11-c18/`. |

Rerun of the fixed `c17` and `c18`, claude, 5 runs each (`review-references/claude-sonnet-5-5-c17-c18-fixed/`): 3 of 7 finished clean runs had a false finding, and 3 of 10 calls timed out. The fixed `c17` is still not clean for claude, so check the false findings in `results.json` before you trust the case.

Rerun of opencode2 on `c11` to `c18`, 2 runs each, 15 minute timeout: all 9 calls timed out before I stopped the run. A plain test call to the same model answered in 15 seconds. The slow part is the review call in a checkout. The cause is not known.

## Findings

- Recall is 100% for every core on v1, so v1 cannot rank the cores.
- The new clean case `c17-clean-tempting` is the first case that separates a core. Claude reports false findings on it.
- The slow cores time out on the harder cases at 10 minutes. Opencode2 has 6 timeouts in 8 calls. Its recall on v2 is not measured.
- A run writes its report only at the end. A stopped run loses its data. Add a partial write if long runs are common.

## Next steps

1. Find why opencode2 review calls hang, then rerun it on `c11` to `c18`.
2. Read the claude false findings on the fixed `c17`.
3. Add cases until each cell reaches n of 30.
