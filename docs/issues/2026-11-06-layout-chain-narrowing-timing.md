<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
   grep -F "## [@" docs/issues/2026-11-06-layout-chain-narrowing-timing.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:NARROW-01'):
   awk "/^## \[@issue:NARROW-01\]/,/END_DOC_BLOCK: \[@issue:NARROW-01\]/" docs/issues/2026-11-06-layout-chain-narrowing-timing.md
-->
# Layout chain narrowing: test counts and durations (2026-11-06)

This record holds the before and after measurement for ticket T987, which narrows the layout chain in the local `visual` gate (`@ui:LAYOUT-SCOPE`). It is a snapshot, not a current rule.

## [@issue:NARROW-01] Single-view ticket and settings ticket, before and after

| Selection | Run | Tests listed | Layout tests | Passed | Skipped | Playwright duration | Wall time | Layout chain test time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dashboard (single view) | before | 1,284 | 712 | 874 | 410 | 7.7 min | 472 s | 239 s |
| Dashboard (single view) | after | 847 | 275 | 437 | 410 | 4.1 min | 253 s | 95 s |
| Settings | before | 924 | 712 | 809 | 115 | 5.0 min | 321 s | 219 s |
| Settings | after | 319 | 107 | 204 | 115 | 3.6 min | 240 s | 90 s |

- **Result**: the dashboard run took 47% less Playwright time, and the settings run took 28% less. Report the settings case separately, because the chain still covers every Settings route there.
- **Selection**: the dashboard grep comes from `selectViews(['src/ui/dashboard/x.tsx'])`, which selects `dashboard` and `status`. The settings grep comes from `selectViews(['src/ui/settings/x.tsx'])`. `status` has no layout route.
- **Verdict**: each run held one `layout-setup` test and one `layout-teardown` test, and all four runs exited 0.
- **Layout chain test time**: this is the sum of the per-test durations of `layout`, `layout-setup` and `layout-teardown` in the `list` reporter output. It omits the time between tests.
END_DOC_BLOCK: [@issue:NARROW-01]

## [@issue:NARROW-02] How to read these numbers

- **Method**: "before" is merge base `73ea7d1af92` in a temporary worktree, and "after" is `5017fd06cba`. Each run is `npm run -s test:visual:docker` with one worker and an external `KARST_UI_GREP`, so the repeat-pass memo and the selection step did not apply.
- **Host**: one macOS host with 6 Docker CPUs. Other agents ran gates at the same time, and the 1-minute load average went from 24 to 48. The load was not the same across runs, so the durations are estimates. Each row is one run. The test counts do not change with the load.
- **Order**: the runs went in the order before dashboard, after dashboard, after settings, before settings. A repeat of after dashboard came last.
- **Failed attempt**: the first after dashboard run exited 1 after 43 s with `Timed out waiting 30000ms from config.webServer.`, before any test started. The table omits it and shows the repeat, which passed. This record does not identify the cause: the failure did not recur, and the host load was high. The change does not touch `tests/visual/serve.mjs` or the `webServer` configuration.
END_DOC_BLOCK: [@issue:NARROW-02]
