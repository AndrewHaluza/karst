import type { Store } from '../store/db.js';
import type { Severity } from '../manifest/types.js';
import { SEVERITIES } from '../manifest/qualityDefaults.js';
import { listFindings } from '../store/reviewFindings.js';
import { findingIdentity } from '../store/findingIdentity.js';
import type { StallAttempt } from '../model/reviewStall.js';

/** When the last `reset` review round ended an episode, or null (the stall window starts there). */
export function reviewEpisodeStart(store: Store, ticketId: number): string | null {
  const reset = store.db
    .prepare(
      `SELECT MAX(ended_at) AS at FROM recovery_rounds
        WHERE ticket_id = ? AND source_stage = 'review' AND status = 'reset'`,
    )
    .get(ticketId) as { at: string | null } | undefined;
  return reset?.at ?? null;
}

/**
 * A ticket's review attempts, oldest first (blocking findings grouped per attempt, plus clean runs, where the reviewer ran and found nothing, as empty attempts; one round per review run),
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
  const since = reviewEpisodeStart(store, ticketId);

  // Rounds are keyed by review run (its `runAt` batch stamp), not by the attempt
  // number: the number repeats across a park, a send-back and a reset. A run
  // that never reached a verdict (stale, blocked, stopped) is not a round and
  // neither counts nor breaks, but the blocking findings it recorded (the kept
  // siblings of a usage-limit park) belong to the next run that reaches one.
  const findingsByRun = new Map<string, { attempt: number; findings: StallAttempt['findings'][number][] }>();
  for (const f of listFindings(store, ticketId)) {
    if (f.source !== 'agent' || SEVERITIES.indexOf(f.severity) > floor) continue;
    if (since !== null && f.runAt <= since) continue;
    const entry = findingsByRun.get(f.runAt) ?? { attempt: f.attempt, findings: [] };
    entry.findings.push({ file: f.file, line: f.line, identity: f.identity ?? findingIdentity(f) });
    findingsByRun.set(f.runAt, entry);
  }
  const runs = new Map<string, { attempt: number; verdict: boolean; parked: boolean; reviewerPassed: boolean }>();
  const stageRuns = store.db
    .prepare(
      `SELECT s.attempt AS attempt, s.run_at AS runAt, s.status AS status, s.outcome AS outcome,
              EXISTS (SELECT 1 FROM process_runs p
                       WHERE p.stage_run_id = s.id AND p.stage_key = 'review' AND p.status = 'passed') AS reviewerPassed
         FROM stage_runs s WHERE s.ticket_id = ? AND s.stage_key = 'review'`,
    )
    .all(ticketId) as { attempt: number; runAt: string; status: string; outcome: string | null; reviewerPassed: number }[];
  for (const r of stageRuns) {
    if (since !== null && r.runAt <= since) continue;
    runs.set(r.runAt, {
      attempt: r.attempt,
      // The run being committed is still `running` when the guard reads.
      verdict: !(r.status === 'stale' || (r.status === 'finished' && r.outcome !== 'advanced')),
      parked: r.status === 'finished' && r.outcome === 'blocked',
      reviewerPassed: r.reviewerPassed === 1,
    });
  }
  // A findings batch with no stage run (a row written before stage runs) is a verdict.
  for (const [runAt, e] of findingsByRun) {
    if (!runs.has(runAt)) runs.set(runAt, { attempt: e.attempt, verdict: true, parked: false, reviewerPassed: false });
  }
  const out: StallAttempt[] = [];
  // Only a usage-limit park (blocked) keeps findings for its rerun, and the
  // rerun shares its attempt (a park spends none). A stale or stopped run, or a
  // fresh round under a later attempt, re-reviews from scratch: the findings of
  // the unfinished run are obsolete there.
  let carried: { attempt: number; findings: StallAttempt['findings'][number][] }[] = [];
  for (const runAt of [...runs.keys()].sort()) {
    const run = runs.get(runAt)!;
    const own = findingsByRun.get(runAt)?.findings ?? [];
    if (!run.verdict) {
      if (run.parked && own.length > 0) carried.push({ attempt: run.attempt, findings: own });
      continue;
    }
    const kept = carried.filter((c) => c.attempt === run.attempt).flatMap((c) => c.findings);
    carried = [];
    const findings = [...kept, ...own];
    // Clean: the reviewer ran and passed and nothing blocks. A red gate where
    // the reviewer never ran is no evidence about the review.
    if (findings.length > 0 || run.reviewerPassed) out.push({ attempt: run.attempt, findings });
  }
  return out;
}
