<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: grep -F "## [@" docs/issues/2026-11-07-refresh-cost-archived.md
2. EXTRACT A BLOCK: awk '/^## \[@issue:REFRESH-COST\]/,/END_DOC_BLOCK: \[@issue:REFRESH-COST\]/' docs/issues/2026-11-07-refresh-cost-archived.md
-->
# Sidebar refresh: cost of archived tickets

## [@issue:REFRESH-COST] Archived tickets cost before and after T1009

Date: 2026-11-07. This is a snapshot, not a rule. The test store was synthetic and in memory, with 895 archived and 33 active tickets. This matches the local project 1. The same temporary test ran `buildSidebarState` with the default facets (Archived off) on two checkouts: the base commit `2a5ddfa03cd` (old code) and the T1009 branch (new code). The test was not committed. Each time is the median of 40 builds after one warm-up build.

| Measure per `buildSidebarState` | Old code | New code |
|---|---|---|
| Median time | 9.71 ms | 1.23 ms |
| 90th percentile | 10.19 ms | 1.52 ms |
| `FROM stages` statements | 928 | 1 |

The `git fetch` saving on the gate options path is not in this table. It needs a real repository with a remote. The no-fetch path compares with the existing `origin/<base>` and `origin/<branch>` refs. If the remote branch was deleted, a stale local `origin/<branch>` can stay until the next fetch. A gate run and ship still fetch, so they are not affected. With debug logging on, the Karst output channel shows live numbers in the `[sidebar] buildSidebarState` and `[dashboard] ... pushSnapshot` lines.
END_DOC_BLOCK: \[@issue:REFRESH-COST\]/' docs/issues/2026-11-07-refresh-cost-archived.md
-->
# Sidebar refresh: cost of archived tickets

## [@issue:REFRESH-COST] Archived tickets cost before and after T1009

Date: 2026-11-07. This is a snapshot, not a rule. The test store was synthetic and in memory, with 895 archived and 33 active tickets. This matches the local project 1. Each value is the median of 30 runs. Timing code was a temporary vitest test. It was not committed.

| Step | Before | After |
|---|---|---|
| Archived load: one stage query for each ticket | 9.1 ms | 5.5 ms (one batched query) |
| Archived data outside the Archived facet | 5.5 ms (full rows and stages) | 0.2 ms (`id` and `key` only) |
| `buildSidebarState`, Archived facet off | not measured | 1.4 ms |

The "before" value is raw SQL that repeats the old per-ticket stage query. It is not the old code. The `git fetch` saving on the gate options path needs a real repository. The sidebar and `pushSnapshot` debug timing lines (`[sidebar] buildSidebarState` and `[dashboard] ... pushSnapshot`) give live numbers in the Karst output channel when debug logging is on.
END_DOC_BLOCK: [@issue:REFRESH-COST]
