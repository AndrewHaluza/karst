import type { Store } from '../store/db.js';
import type { Severity } from '../manifest/types.js';
import { SEVERITIES } from '../manifest/qualityDefaults.js';
import { listFindings } from '../store/reviewFindings.js';
import { findingIdentity } from '../store/findingIdentity.js';
import type { StallAttempt } from '../model/reviewStall.js';

/**
 * A ticket's review attempts, oldest first (blocking findings grouped per attempt, plus clean finished runs as empty attempts),
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

  const byAttempt = new Map<number, { runAt: string; findings: StallAttempt['findings'][number][] }>();
  const blockingRunAts = new Set<string>();
  for (const f of listFindings(store, ticketId)) {
    if (f.source !== 'agent' || SEVERITIES.indexOf(f.severity) > floor) continue;
    if (since !== null && f.runAt <= since) continue;
    const entry = byAttempt.get(f.attempt) ?? { runAt: f.runAt, findings: [] };
    entry.findings.push({ file: f.file, line: f.line, identity: f.identity ?? findingIdentity(f) });
    if (f.runAt > entry.runAt) entry.runAt = f.runAt;
    byAttempt.set(f.attempt, entry);
    blockingRunAts.add(f.runAt);
  }
  const rounds = [...byAttempt.entries()].map(([attempt, e]) => ({ attempt, runAt: e.runAt, findings: e.findings }));
  // A review run that finished without blocking findings is a clean round: it
  // breaks the streak. A stale, blocked or stopped run (usage-limit park)
  // never reached a verdict and neither counts nor breaks.
  const finished = store.db
    .prepare(
      `SELECT attempt, run_at AS runAt FROM stage_runs
        WHERE ticket_id = ? AND stage_key = 'review' AND status = 'finished' AND outcome = 'advanced'`,
    )
    .all(ticketId) as { attempt: number; runAt: string }[];
  for (const run of finished) {
    if (blockingRunAts.has(run.runAt) || (since !== null && run.runAt <= since)) continue;
    rounds.push({ attempt: run.attempt, runAt: run.runAt, findings: [] });
  }
  return rounds
    .sort((a, b) => (a.runAt < b.runAt ? -1 : a.runAt > b.runAt ? 1 : a.attempt - b.attempt))
    .map(({ attempt, findings }) => ({ attempt, findings }));
}
