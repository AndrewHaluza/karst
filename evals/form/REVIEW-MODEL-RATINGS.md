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

## Case set v4 (test files in c14 and c15)

Commit after this note adds a test file to `c14` and `c15`, widens the `c14` defect to lines 7 to 12, and raises the case-set version to 4. Do not compare v4 cells with v3 cells for these two cases.

Run of claude on `c14` and `c15`, 5 runs each (`review-references/claude-sonnet-5-5-c14-c15-v4/`): recall 10/10, 0 blocking false findings, 9 seconds per run. The runs with a false finding fell from 10 of 10 to 5 of 10. The rest are low comments on a negative `count`, the magic number 3, and the `visibility` type. A defect case does not fail on a false finding, so these do not change the score. Only a blocking false finding or a clean-case false finding counts against a core. The cases are good enough to use.

Runs on case set v4, `c11` to `c18` (reports in `review-references/*-c11-c18-v4/`):

| Core | Model | Recall | Clean cases with a false finding | Blocking false | Calls with `ok` | Seconds per run |
|---|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | 21/21 | 0/6 | 0 | 24 of 24 | 79.4 |
| opencode2 | opencode-go/mimo-v2.6-flash | 13/13 | 1/3 | 0 | 14 of 16 | 157.1 |

Antigravity had no blocking false finding on v4, against 6 on v2 and v3. The fixes to `c14` and `c15` worked for this core. Opencode2 timed out on 2 of 16 calls at 10 minutes (`c12` run 2 and `c17` run 1). It found the `c12` defect in run 1, which it missed in the earlier 1-run batch. Its clean-case false finding was in `c18` run 2. Every cell has n below 30.

Clean-case runs on case set v4: the 4 clean cases (`c09`, `c10`, `c17`, `c18`), 8 runs each (`review-references/*-clean-n32-v4/`). This is the first cell with n of 30 or more.

| Core | Model | Clean cases with a false finding | 95% interval | Calls with `ok` | Seconds per run |
|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | 0/32 | 0.0% to 10.7% | 32 of 32 | 62.9 |
| opencode2 | opencode-go/mimo-v2.6-flash | 10/31 | 18.6% to 49.9% | 31 of 32 | 200.7 |

The two intervals do not overlap, so antigravity has fewer false findings than opencode2 on these cases. The conclusion holds only for these 4 cases, and it is a statement about clean cases, not about recall. Recall is still n below 30 for every core.

Opencode2 failed `c17` in 7 of 8 runs and `c18` in 3 of 7. In 6 of the 7 `c17` runs the finding says the new test file imports `vitest` but the repo has no `package.json` or dependency for it. That is a flaw in the case, not only in the core. Without `c17` the opencode2 result is 3 of 23. Decision needed: add a minimal `package.json` that lists `vitest` to `c17` (case set 5), then rerun `c17`.

## Case set v5 (c17 has a package.json and tsconfig)

Commit `f3d265ac5` adds a `package.json` (with `vitest`) and a `tsconfig.json` (target ES2022) to the base of `c17`. Opencode2 on `c17`, 8 runs (`review-references/opencode2-mimo-v2.6-flash-c17-v5/`): 4 of 8 runs had a false finding, against 7 of 8 before. The `vitest` and ES2022 findings are gone. The rest are design remarks: a UTF-8 BOM, inconsistent error classes, and a `__proto__` key. A case named "clean-tempting" invites these. I stopped tuning the case. The `c17` cell stays a measure of nitpicking, not of real false alarms.

Recall runs on v5: the 14 defect cases (`c01` to `c08`, `c11` to `c16`), 2 runs each, 34 seeded defects (`review-references/*-recall-n34-v5/`). This is the first recall cell with n of 30 or more.

| Core | Model | Recall | 95% interval | Calls with `ok` | Seconds per run |
|---|---|---|---|---|---|
| antigravity | gemini-3.8-flash-medium | 34/34 | 89.8% to 100% | 28 of 28 | 73.0 |
| opencode2 | opencode-go/mimo-v2.6-flash | 34/34 | 89.8% to 100% | 28 of 28 | 101.0 |

Both cores found every seeded defect, and no call timed out. The recall intervals are the same, so recall does not separate these two cores. The clean-case rate does (see above). Claude has no n of 30 cell yet.

## Case set v6 (six harder cases, c19 to c24)

Case set 6 adds `c19` to `c24`. Each has one seeded defect that needs more than a local read: a unit mismatch with an unchanged file (`c19`), a race (`c20`), an offset that disagrees with a correct helper (`c21`), a path prefix check (`c22`), regex `lastIndex` state (`c23`), and a changed contract with an unchanged caller (`c24`). Every case has a test file that passes on the defective code.

Opencode2, 3 runs per case, 18 calls (`review-references/opencode2-mimo-v2.6-flash-hard-c19-c24-v6/`): recall 15/18 (83.3%, interval 60.8% to 94.2%, INSUFFICIENT), 18 of 18 calls ok, 2 blocking false findings, 110.5 seconds per run. The easy cases gave 34/34, so these cases separate the core from 100%.

| Case | Found in 3 runs | Note |
|---|---|---|
| `c19-unit-mismatch` | 3 | |
| `c20-lost-update` | 2 | Run 1 described the race, but the finding has no file and no line. The matcher cannot score it. |
| `c21-pagination` | 2 | Run 3 is a real miss. It reported only a `NaN` page. |
| `c22-path-prefix` | 3 | |
| `c23-regex-state` | 3 | |
| `c24-contract-break` | 2 | Run 3 found the break, but it put the finding on the caller, `handler.ts:10`. The case accepts only `parseId.ts`. |

So 1 of the 3 misses is a real miss. 1 is a finding without a location, which a user cannot act on. 1 is a correct finding at a different location. I did not change the matcher to fit this result. A later change may accept the caller line for `c24`.

Defect cases also drew 0 to 3 false findings per run. They do not count against the core.

Second run of the same 6 cases, 3 runs each (`review-references/opencode2-mimo-v2.6-flash-hard-c19-c24-v6-run2/`): 18 of 18 calls ok, recall 16/18, 123.6 seconds per run. The two runs together have 36 calls, all ok, which gives n of 36. This is the first n of 30 or more on the hard cases.

| Case | Found in 6 runs |
|---|---|
| `c19-unit-mismatch` | 6 |
| `c20-lost-update` | 5 |
| `c21-pagination` | 5 |
| `c22-path-prefix` | 6 |
| `c23-regex-state` | 6 |
| `c24-contract-break` | 3 |

Recall on the hard cases: 31/36 (86.1%, interval 71.3% to 93.9%), 4 blocking false findings, 117.1 seconds per run. The easy cases gave 34/34, so the hard cases do separate opencode2 from 100%.

`c24` explains 3 of the 5 misses. In all 3 runs the finding is correct, but it points to the caller `handler.ts` (line 9 or 10) and the case accepts only `parseId.ts`. If the case accepted the caller line, recall would be 34/36 (94.4%). I report the strict number. A later case-set version may accept the caller line. Of the 2 other misses, one is a finding without a file and a line (`c20`), and one is a real miss (`c21`).

## Findings

- Recall is 100% for every core on v1, so v1 cannot rank the cores.
- The new clean case `c17-clean-tempting` is the first case that separates a core. Claude reports false findings on it.
- The slow cores time out on the harder cases at 10 minutes. Opencode2 has 6 timeouts in 8 calls. Its recall on v2 is not measured.
- A run writes its report only at the end. A stopped run loses its data. Add a partial write if long runs are common.

## Next steps

1. Confirm the opencode2 hang cause (load is the likely one). Rerun with `--runs 3` for n.
2. Read the claude false findings on the fixed `c17`.
3. Add cases until each cell reaches n of 30.
