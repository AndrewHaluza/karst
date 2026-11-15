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

Rerun after the test file was added to `c17` (claude, 5 runs each, `review-references/claude-sonnet-5-5-c17-with-test/` and `claude-sonnet-5-5-c18-rerun/`): `c17` gave 0 false findings in 5 of 5 calls, and `c18` gave 0 false findings in 5 of 5 calls. No call timed out. The "no tests added" finding is gone, so the earlier false findings on `c17` came from the missing test file. The 3 of 7 result above is replaced by this run.

Rerun of opencode2 on `c11` to `c18`, 2 runs each, 15 minute timeout: all 9 calls timed out before I stopped the run. A plain test call to the same model answered in 15 seconds. The slow part is the review call in a checkout. The cause is not known.

Rerun of opencode2 on `c12` to `c18`, 1 run each, 6 minute timeout (`review-references/opencode2-mimo-v2.6-flash-c12-c18/`): all 7 calls finished ok, 0 timeouts, 156 seconds per run (66 to 243). Recall was 5/6. The core missed the defect in `c12-tz-boundary` and gave 3 false findings there, 1 blocking. It gave 1 false finding on `c14-mutated-arg`. The clean cases `c17` and `c18` had 0 false findings. The earlier hangs did not repeat, so the cause is likely machine load. This is not proven. Every cell has n below 30.

Rerun of antigravity on `c11` to `c18`, 3 runs each, 15 minute timeout (`review-references/antigravity-gemini-3.8-flash-medium-c11-c18-rerun/`): all 24 calls finished ok, 0 timeouts, 72 seconds per run. Recall was 21/21. The clean cases `c17` and `c18` had 0 false findings in 6 of 6 calls. The core gave the same false findings in every run of two defect cases: 1 on `c14-mutated-arg` and 2 on `c15-auth-inverted`, 6 blocking in total. Read these in `results.json`. They may be real issues in the seeded code, or a matcher window miss. The earlier 2 timeouts did not repeat.

## Case set v3 (c14 and c15 changed)

The antigravity rerun gave the same false findings on `c14` and `c15` in every run. The seeded code had real extra issues: `renderBoard` listed all tasks as the rest, and the `visibility` type and the admin rule drew comments. Commit after this note changes the code of both cases and raises the case-set version to 3. Do not compare v3 cells with v2 cells for `c14` and `c15`.

Run of claude on `c14` and `c15`, 5 runs each (`review-references/claude-sonnet-5-5-c14-c15-v3/`): recall 10/10, 0 blocking false findings, 10 seconds per run. Every run still had 1 or 2 false findings of low or medium severity. Two kinds remain: low comments about no tests or no input validation (the same cause as the old `c17`), and a medium finding on line 12 of `c14` that says `renderBoard` depends on the hidden sort mutation. That second finding is a true consequence of the seeded defect, but it is outside the 3-line window. Decision needed: add a test file to both cases, and widen the `c14` defect to lines 7 to 12.

## Findings

- Recall is 100% for every core on v1, so v1 cannot rank the cores.
- The new clean case `c17-clean-tempting` is the first case that separates a core. Claude reports false findings on it.
- The slow cores time out on the harder cases at 10 minutes. Opencode2 has 6 timeouts in 8 calls. Its recall on v2 is not measured.
- A run writes its report only at the end. A stopped run loses its data. Add a partial write if long runs are common.

## Next steps

1. Confirm the opencode2 hang cause (load is the likely one). Rerun with `--runs 3` for n.
2. Read the claude false findings on the fixed `c17`.
3. Add cases until each cell reaches n of 30.
