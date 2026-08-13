# Slice-1 Measurement Baseline — single-agent `impl`

> Slice-1 Task 8. Recorded before the graph runtime exists, so the Slice-3
> entry gate ("the recorded cost comparison") and the design's abandonment
> criterion (design, Premise and Measurement) can be evaluated on the SAME
> queries against the SAME columns. The post-Slice-3 measurement must be the
> queries below run on graph-approach tickets; the two groups then compare on
> implementation wall time, total token cost, human-intervention count, and
> UAT-pass-on-first-attempt rate.

## Selection rule

The five most recently completed tickets: `stage_current = 'done'`, not
archived, `impl` stage `passed`, ordered by the `impl` stage's `ended_at`
descending, `LIMIT 5`. Reproducible by re-running the selection query; a
ticket added to the registry later shifts the window only by being newer.

## Registry and driver

- Registry: `karst.db` (global storage, SQLite, WAL).
- Driver: `node:sqlite` (`DatabaseSync`, read-only).
- Recorded: 2026-08-11 (all five tickets completed 2026-08-11).

## Metric definitions

| Metric | Derivation | Rationale |
|---|---|---|
| Implementation wall time (minutes) | `julianday(stages.ended_at) - julianday(stages.started_at)) * 1440` on the `impl` stage row | `stage_runs` (v25) has zero rows for every pre-existing ticket, so per-run timing is unavailable; the `stages` row spans the same launch the graph's nodes will later be measured on. |
| Total token cost | `SUM(token_usage.total_tokens)` per ticket | The single stored total per call (`input + output + cache_read + cache_write`); `estimated` rows are few and included (they are flagged, never dropped). |
| Human interventions | `COUNT(stages WHERE stage_key = 'fix' AND status = 'passed')` | A passed `fix` row means a gate failure stopped the flow and a repair round ran — the intervention loop. `session_launch_intents` is NOT usable: rows exist mostly as `pending` or not at all. |
| UAT-pass-on-first-attempt | `attempt` on the `uat` stage row equals `0` AND `COUNT(gate_runs WHERE stage_key='uat' AND exit_code NOT NULL AND exit_code != 0) = 0` | Attempt is bumped per failure→fix→rerun cycle; any non-zero uat gate run anywhere in the ticket's history means it did not pass on the first try. |

## Recorded queries (exact SQL)

```sql
-- Selection: the five most recently completed tickets.
SELECT t.key
FROM tickets t
JOIN stages s ON s.ticket_id = t.id AND s.stage_key = 'impl' AND s.status = 'passed'
WHERE t.stage_current = 'done' AND t.archived_at IS NULL
ORDER BY s.ended_at DESC
LIMIT 5;

-- Per-ticket metrics (single query, one row per ticket).
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
ORDER BY s.ended_at DESC
LIMIT 5;
```

## Baseline table (five most recently completed tickets, recorded 2026-08-11)

| Key | Title | impl wall (min) | total tokens | fix rounds (interventions) | uat attempt | review attempt | uat failed gates | review failed gates |
|---|---|---|---|---|---|---|---|---|
| `CLICKUP-API-ERROR` | Clickup API error | 4.6 | 154,510 | 0 | 0 | 0 | 0 | 0 |
| `869egvp46-fu2` | Follow-up: [BRAND] Replace Karst branding with approved logo #35 | 11.5 | 81,825 | 0 | 0 | 0 | 0 | 0 |
| `869egvp46` | [BRAND] Replace Karst branding with approved logo #35 | 49.1 | 197,497 | 0 | 0 | 0 | 0 | 0 |
| `REPLACE-IMPROVE-TICKET-FORM` | Replace improve ticket form | 37.4 | 211,020 | 0 | 0 | 0 | 0 | 0 |
| `CLOSE-TICKET-WITH-DONE-TERMINALS` | Close ticket with done terminals | 19.8 | 122,721 | 1 | 1 | 0 | 1 | 0 |

## Summary

- Implementation wall time: mean ≈ **24.5 min**, median **19.8 min**, range 4.6–49.1.
- Total token cost: mean ≈ **153,515 tokens**, median **154,510**, range 81,825–211,020.
- Human interventions (fix rounds): **4 of 5 tickets at 0**, one at 1.
- UAT-pass-on-first-attempt: **4 of 5** (80%); the failing ticket (`CLOSE-TICKET-WITH-DONE-TERMINALS`) failed one uat gate, cycled through one fix round, then passed.

## Reproducibility

Re-running the recorded queries against this registry on the recorded date
yields the table above. The post-Slice-3 measurement runs the identical
queries and compares the graph group against these numbers; the comparison
must use the same selection window style (most-recently-completed) so the
groups are comparable.
