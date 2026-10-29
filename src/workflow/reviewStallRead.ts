import type { Store } from '../store/db.js';
import type { Severity } from '../manifest/types.js';
import { SEVERITIES } from '../manifest/qualityDefaults.js';
import { listFindings } from '../store/reviewFindings.js';
import { findingIdentity } from '../store/findingIdentity.js';
import type { StallAttempt } from './reviewStall.js';

/**
 * A ticket's blocking review findings grouped per review attempt, oldest first,
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

  const byAttempt = new Map<number, StallAttempt['findings'][number][]>();
  for (const f of listFindings(store, ticketId)) {
    if (f.source !== 'agent' || SEVERITIES.indexOf(f.severity) > floor) continue;
    if (since !== null && f.runAt <= since) continue;
    const list = byAttempt.get(f.attempt) ?? [];
    list.push({ file: f.file, identity: f.identity ?? findingIdentity(f) });
    byAttempt.set(f.attempt, list);
  }
  return [...byAttempt.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempt, findings]) => ({ attempt, findings }));
}
