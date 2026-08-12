# Post-Slice-3 Measurement — graph-approach tickets vs the Slice-1 baseline

> Slice-3 Task 12, item 2. Runs the IDENTICAL baseline queries
> (`measurement/baseline.md`, recorded 2026-08-11) against the real registry,
> restricted to graph-approach tickets, and applies the design's abandonment
> criterion (design, Premise and Measurement; `00-ROADMAP.md`, Abandonment
> gate).
>
> Recorded: 2026-08-12, against the same `karst.db` the baseline read.

## The measured group

The selection rule from the baseline, restricted to graph-approach tickets:

```sql
SELECT t.key
FROM tickets t
JOIN stages s ON s.ticket_id = t.id AND s.stage_key = 'impl' AND s.status = 'passed'
WHERE t.stage_current = 'done' AND t.archived_at IS NULL
  AND t.approach = 'karst-graph-engineering'
ORDER BY s.ended_at DESC
LIMIT 5;
```

**Result: zero rows.** A second, looser probe — `SELECT COUNT(*) FROM tickets
WHERE approach = 'karst-graph-engineering'` across the whole registry,
regardless of stage — also returns **zero**. No ticket in the registry has
ever run the graph approach.

## Why the group is empty, and why that is the sequencing working as designed

The packaged built-in shipped `enabled: false` until Slice 3 Task 12 flipped
it (this commit). Selection of the approach was impossible before the flip —
the picker drops disabled approaches — so **the flip is the enabler of the
measurement, not a consequence of it**: the plan's own task ordering puts
"flip the packaged default" as item 1 and "run the measurement on N real
tickets" as item 2, because the measurement needs tickets that could only be
created after the flip. The cost-comparison entry-gate document anticipated
exactly this: "Nothing in this document can substitute for that measurement"
and the real evaluation runs "on graph-approach tickets" — tickets that exist
only once the approach is selectable.

## The abandonment criterion, applied today

> "If the graph does not improve at least one of the four without worsening
> the others, the approach ships disabled and Slices 4–6 are not built."

With N = 0 completed graph-approach tickets, the criterion **cannot be
violated** — there is no graph-group observation on any of the four metrics
(implementation wall time, total token cost, human-intervention count,
UAT-pass-on-first-attempt). It also cannot be **satisfied** yet. The record
therefore:

1. **keeps the flip at `enabled: true`** (the plan's item-1 change; nothing in
   the data contradicts it — the Slice-3 exit gate "packaged default flips to
   enabled: true" is met);
2. **carries the evaluation forward as a binding obligation**, unchanged: the
   first N completed graph-approach tickets (same selection-window style as
   the baseline) are measured with the identical queries below, and if the
   graph group does not improve at least one metric without worsening the
   others, the flip is reverted to `enabled: false` and the runtime is not
   the default. The
   ROADMAP names Slice 6's entry gate as "the post-Slice-3 measurement
   evaluated as favorable under the design's abandonment criterion" — that
   evaluation happens on the tickets this flip now makes possible, and this
   document is where it will be recorded.

## Post-slice status (recorded 2026-08-12, after Slice 6)

- Slices 4–6 were built under the principal's entry-gate waiver
  (`04-slice-4…md`, waiver recorded 2026-08-12): the criterion is
  unevaluable at N=0, not violated, so the work proceeded and the packaged
  default is `enabled: true` with `maxParallel: 4` (Slice-5 T7). The runtime
  is the packaged default.
- The evaluation obligation stands: the identical queries below run on the
  first N completed graph-approach tickets, and a violation reverts the flip
  and retires the packaged default. This document remains the recording
  point.

## The queries that will produce the graph-group numbers (identical to baseline)

```sql
SELECT
  t.key,
  ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 1440, 1) AS impl_wall_minutes,
  (SELECT COALESCE(SUM(total_tokens), 0) FROM token_usage u WHERE u.ticket_id = t.id) AS total_tokens,
  (SELECT COUNT(*) FROM stages f WHERE f.ticket_id = t.id AND f.stage_key = 'fix' AND f.status = 'passed') AS fix_rounds,
  (SELECT attempt FROM stages a WHERE a.ticket_id = t.id AND a.stage_key = 'uat') AS uat_attempt,
  (SELECT attempt FROM stages a WHERE a.ticket_id = t.id AND a.stage_key = 'review') AS review_attempt,
  (SELECT COUNT(*) FROM gate_runs g WHERE g.ticket_id = t.id AND g.stage_key = 'uat'
    AND g.exit_code IS NOT NULL AND g.exit_code != 0) AS uat_failed_gates,
  (SELECT COUNT(*) FROM gate_runs g WHERE g.ticket_id = t.id AND g.stage_key = 'review'
    AND g.exit_code IS NOT NULL AND g.exit_code != 0) AS review_failed_gates
FROM tickets t
JOIN stages s ON s.ticket_id = t.id AND s.stage_key = 'impl' AND s.status = 'passed'
WHERE t.stage_current = 'done' AND t.archived_at IS NULL
  AND t.approach = 'karst-graph-engineering'
ORDER BY s.ended_at DESC
LIMIT 5;
```

## Comparison table (graph group vs baseline)

| Metric | Baseline (measured, 5 tickets, 2026-08-11) | Graph (today) | Delta |
|---|---|---|---|
| Implementation wall time (mean / median) | ≈ 24.5 / 19.8 min | — (N=0) | unevaluable |
| Total token cost (mean / median) | ≈ 153,515 / 154,510 | — (N=0) | unevaluable |
| Human interventions (fix rounds) | 4 of 5 at 0, one at 1 | — (N=0) | unevaluable |
| UAT-pass-on-first-attempt | 4 of 5 (80%) | — (N=0) | unevaluable |

**Status: measurement vacuous; criterion not yet evaluable; flip stands.**

## Reproducibility

Re-running either SQL above against this registry on the recorded date yields
the zero-row result. The graph group's first rows appear the moment the first
graph-approach ticket completes; the evaluation then proceeds per the
criterion. Supersedes nothing; superseded by the first populated recording of
this file.
