import type { Store } from '../store/db.js';
import type { Severity } from '../manifest/types.js';
import { SEVERITIES } from '../manifest/qualityDefaults.js';
import { listFindings } from '../store/reviewFindings.js';
import { findingIdentity } from '../store/findingIdentity.js';
import type { StallAttempt } from '../model/reviewStall.js';

/**
 * A ticket's review attempts, oldest first (blocking findings grouped per attempt, plus clean runs, where the reviewer ran and found nothing, as empty attempts),
 * since the last `reset` review round ended an episode (the stall counter's
 * reset marker — "Continue anyway" and a redesign hint both end the episode).
 * Only agent findings at or above `blockingSeverity` count; `'none'` blocks
 * nothing. Rows that predate `identity` get it derived, so repeats are
 * comparable across the v53 boundary too.
 */
export function reviewStallAttempts(
  store: Store,
  ticketId: number,
  blockingSeverity: Severity | 'none',
): StallAttempt[] {
  if (blockingSeverity === 'none') return [];
  const floor = SEVERITIES.indexOf(blockingSeverity);
  const reset = store.db
    .prepare(
      `SELECT MAX(ended_at) AS at FROM recovery_rounds
        WHERE ticket_id = ? AND source_stage = 'review' AND status = 'reset'`,
    )
    .get(ticketId) as { at: string | null } | undefined;
  const since = reset?.at ?? null;

  // Runs that never reached a verdict (stale, blocked, stopped) neither count nor break.
  const unfinished = new Set(
    (
      store.db
        .prepare(
          `SELECT run_at AS runAt FROM stage_runs
            WHERE ticket_id = ? AND stage_key = 'review'
              AND (status = 'stale' OR (status = 'finished' AND outcome IN ('blocked','stopped')))`,
        )
        .all(ticketId) as { runAt: string }[]
    ).map((r) => r.runAt),
  );
  const byAttempt = new Map<number, { runAt: string; findings: StallAttempt['findings'][number][] }>();
  for (const f of listFindings(store, ticketId)) {
    if (f.source !== 'agent' || SEVERITIES.indexOf(f.severity) > floor) continue;
    if (since !== null && f.runAt <= since) continue;
    if (unfinished.has(f.runAt)) continue;
    const entry = byAttempt.get(f.attempt) ?? { runAt: f.runAt, findings: [] };
    entry.findings.push({ file: f.file, line: f.line, identity: f.identity ?? findingIdentity(f) });
    if (f.runAt > entry.runAt) entry.runAt = f.runAt;
    byAttempt.set(f.attempt, entry);
  }
  const rounds = [...byAttempt.entries()].map(([attempt, e]) => ({ attempt, runAt: e.runAt, findings: e.findings }));
  // A clean round is a finished review run whose reviewer ran and passed and
  // that has no blocking finding under its attempt (kept sibling findings of a
  // usage-limit rerun share the attempt, so they keep the round blocking).
  // A run with a red gate where the reviewer never ran is not clean.
  const finished = store.db
    .prepare(
      `SELECT s.attempt AS attempt, s.run_at AS runAt FROM stage_runs s
        WHERE s.ticket_id = ? AND s.stage_key = 'review' AND s.status = 'finished' AND s.outcome = 'advanced'
          AND EXISTS (SELECT 1 FROM process_runs p
                       WHERE p.stage_run_id = s.id AND p.stage_key = 'review' AND p.status = 'passed')`,
    )
    .all(ticketId) as { attempt: number; runAt: string }[];
  for (const run of finished) {
    if (byAttempt.has(run.attempt) || (since !== null && run.runAt <= since)) continue;
    rounds.push({ attempt: run.attempt, runAt: run.runAt, findings: [] });
  }
  return rounds
    .sort((a, b) => (a.runAt < b.runAt ? -1 : a.runAt > b.runAt ? 1 : a.attempt - b.attempt))
    .map(({ attempt, findings }) => ({ attempt, findings }));
}
