import type { Store } from './db.js';
import { currentDeliverRun, listDeliverFailures, listDeliverResults } from './deliverRuns.js';
import type { DeliverFacts } from '../model/inside/deliver.js';

/**
 * The deliver facts of one ticket, read from the deliver tables (T1018). The same read serves the ship panel and
 * `karst context` (a separate process), so both word one truth. `roundActive` is true while a run is in progress:
 * the in-memory conflict round is not visible to the CLI, but a running deliver run only exists during one.
 */
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
    const done = new Set(results.map((r) => r.gateName));
    takenOver = {
      failed: results.filter((r) => r.exitCode !== null && r.exitCode !== 0).map((r) => r.gateName),
      skipped: run.gates.filter((g) => !done.has(g)),
    };
  }
  return { running, failures, takenOver, roundActive: running !== null, headSha: run?.headSha ?? null };
}
