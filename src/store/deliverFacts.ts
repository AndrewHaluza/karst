import type { Store } from './db.js';
import { currentDeliverRun, listDeliverFailures, listDeliverResults, skippedGates } from './deliverRuns.js';
import { listMergeChecksByTicket } from './mergeChecks.js';
import { getConflictRoundAt } from './autopilot.js';
import type { DeliverFacts } from '../model/inside/deliver.js';

/**
 * The deliver facts of one ticket, read from the deliver tables (T1018). The same read serves the ship panel and
 * `karst context` (a separate process), so both word one truth. `roundActive` is true while a run is in progress or
 * while an Autopilot conflict round is armed (the stored `conflict_round_at`; the in-memory round is not visible to the CLI).
 * The current head is the newest head the merge probe saw, so a failure of an older run reads as an older head.
 */
function currentHead(store: Store, ticketId: number): string | null {
  const probed = listMergeChecksByTicket(store, ticketId)
    .filter((c) => c.headSha !== null)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  return probed[0]?.headSha ?? null;
}

export function deliverFactsFor(store: Store, ticketId: number): DeliverFacts {
  const run = currentDeliverRun(store, ticketId);
  const running = run !== null && run.state === 'running'
    ? { n: Math.min(run.finished + 1, run.gates.length), m: run.gates.length, gate: run.currentGate ?? run.gates[run.finished] ?? '' }
    : null;
  const failures = listDeliverFailures(store, ticketId)
    .filter((f) => f.exitCode !== null)
    .map((f) => ({ gate: f.gateName, repo: f.repo, exitCode: f.exitCode as number, headSha: f.headSha, summary: f.summary }));
  let takenOver: DeliverFacts['takenOver'] = null;
  if (run !== null && run.state === 'taken-over') {
    const results = listDeliverResults(store, ticketId).filter((r) => r.runId === run.id);
    takenOver = {
      failed: results.filter((r) => r.exitCode !== null && r.exitCode !== 0).map((r) => r.gateName),
      skipped: skippedGates(run.gates, results.map((r) => r.gateName)),
    };
  }
  return { running, failures, takenOver, roundActive: running !== null || getConflictRoundAt(store, ticketId) !== null, headSha: currentHead(store, ticketId) ?? run?.headSha ?? null };
}
