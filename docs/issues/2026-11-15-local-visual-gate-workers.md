<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
   grep -F "## [@" docs/issues/2026-11-15-local-visual-gate-workers.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:WORKERS-02'):
   awk "/^## \[@issue:WORKERS-02\]/,/END_DOC_BLOCK: \[@issue:WORKERS-02\]/" docs/issues/2026-11-15-local-visual-gate-workers.md
-->
# Local visual gate: worker count measurements (2026-11-15)

This record holds the measurements behind the worker default of the local docker visual gate (`@ui:WORKERS`). It is a snapshot, not a current rule.

## [@issue:WORKERS-01] First measurement: 1, 2 and 3 workers, by file (PERF-MEASURE-2-3-PLAYWRIGHT)

This block is the earlier `@ui:WORKERS` measurement, moved here without a change. At that time `fullyParallel` was not set, so Playwright parallelized by file, and the layout chain was one serial spec file of 712 tests.

**Method.** Pinned image `mcr.microsoft.com/playwright:v1.63.0-noble`, Docker VM about 7 GB and 6 CPUs, full sweep, `.tmp/` removed before each run, runs interleaved (1, 2, 3 workers, three rounds). Peak memory is the highest `docker stats` sample (2 s interval) of the container. Wall is the whole `npm run -s test:visual:docker` command. Playwright is the duration in the JSON report. **The host was not idle:** the load average was about 55 at the start, because other agents were running. Treat the times as noisy.

| Workers | Round | Wall (s) | Playwright (s) | Peak memory (MiB) | Exit | Unexpected (diffs/failures) |
|---|---|---|---|---|---|---|
| 1 | 1 | 703 | 689 | 1196 | 0 | 0 |
| 1 | 2 | 439 | 430 | 1159 | 0 | 0 |
| 1 | 3 | 407 | 402 | 1169 | 0 | 0 |
| 2 | 1 | 493 | 481 | 1616 | 0 | 0 |
| 2 | 2 | 228 | 223 | 1738 | 0 | 0 |
| 2 | 3 | 367 | 358 | 1597 | 0 | 0 |
| 3 | 1 | 415 | 405 | 2055 | 0 | 0 |
| 3 | 2 | 890 | 257 | 2055 | 0 | 0 |
| 3 | 3 | 370 | 362 | 2040 | 0 | 0 |

Every run: 1662 expected, 1038 skipped, 0 unexpected, 0 flaky, no 137 exit.

**Result.** Median Playwright time: 1 worker 430 s, 2 workers 358 s (17% saving), 3 workers 362 s (16% saving). Median wall time: 439 s, 367 s (16%), 415 s (5%). Memory grows with the count (about 1.2, 1.6 and 2.05 GiB) and stays far below the VM limit. Safety was fine: zero diffs, zero kills at every count. The saving was the problem. It is below 25%, and the run-to-run spread at one count (228 s to 493 s at 2 workers) is larger than the gap between counts. Run 6 (3 workers, round 2) lost about 630 s outside the test run. The cause was not found.
END_DOC_BLOCK: [@issue:WORKERS-01]

## [@issue:WORKERS-02] Second measurement: scoped A/B runs, 1 worker against the new default, with --fully-parallel

**Method.** Scoped runs of `npm run -s test:visual:docker` on the branch of this change (after #1114), with `KARST_GATE_FULL=1`, so that the repeat memo does not skip the run. A comment-only change under `src/ui/<view>/` selects the view. Run A sets `KARST_VISUAL_WORKERS=1`. Run B and run C use the new default (`min(4, docker CPUs - 2)`). Each log holds the `visual:` worker line, the `visual server: <step> <ms>` lines, `Fixture views: ...` and the `visual timing:` line.

The runs were made one after the other on 2026-11-15, 11:20 to 11:36, on the 6-CPU Docker VM. The host had other agents in operation. A hung karst gate held the host lease, so the runs set `KARST_GATE_LEASE_HELD=1` and a separate `KARST_DB` folder for the slot file. No other sweep ran in the VM during the runs. Peak memory was not measured. Playwright time is the `N passed (...)` line.

| Run | Scope | Workers | Tests | Wall (s) | Playwright (s) | `visual timing` sweep (s) | `visual server: fixtures` (ms) | Exit | Unexpected |
|---|---|---|---|---|---|---|---|---|---|
| A | dashboard, status | 1 | 1342 | 655 | 642 | 651.9 | 10308 | 0 | 0 |
| B | dashboard, status | 4 | 1342 | 252 | 246 | 249.0 | 8050 | 0 | 0 |
| C | settings | 4 | 244 | 52 | 43 | 47.9 | 1277 | 0 | 0 |

Each run printed `Fixture views: <view>` for its scope only and passed the layout ledger verdict. No run had a 137 exit.

**Result.** Run B saved 62% of the wall time of run A (655 s to 252 s). This is more than the 25% rule. The fixture step of the settings scope (run C) took 1.3 s, against 8.1 s for the dashboard scope (run B).
END_DOC_BLOCK: [@issue:WORKERS-02]
