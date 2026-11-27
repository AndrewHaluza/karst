import type { Store } from './db.js';
import { currentDeliverRun, listDeliverFailures, listDeliverResults, skippedGates, type DeliverGateResult, type DeliverRun } from './deliverRuns.js';
import { listMergeChecksByTicket } from './mergeChecks.js';
import { getConflictRoundAt } from './autopilot.js';
import type { DeliverFacts, DeliverGateFact } from '../model/inside/deliver.js';

/**
 * The deliver facts of one ticket, read from the deliver tables (T1018). The same read serves the ship panel and
 * `karst context` (a separate process), so both word one truth. `roundActive` is true while an auto run is in progress (an after-take-over re-run checks a head that is already pushed) or
 * while an Autopilot conflict round is armed (the stored `conflict_round_at`; the in-memory round is not visible to the CLI).
 * The current head is the newest head the merge probe saw, so a failure of an older run reads as an older head.
 */
function currentHead(store: Store, ticketId: number): string | null {
  const probed = listMergeChecksByTicket(store, ticketId)
    .filter((c) => c.headSha !== null)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  return probed[0]?.headSha ?? null;
}

/**
 * The gates of the current run as facts: one per planned gate AND repo, in plan order. A result carries its own
 * repo, so a gate planned once per repo (a `unit` per repository) emits one fact per result. A gate with no result
 * left is the gate that runs now (`run`) while the run is `running`; the rest are `pending`. A skipped gate is
 * recorded with a null exit and a `skipped:` summary, so it reads `pass` — it was cut, not failed (T1403). A gate
 * that waits for a slot is live host state, so the `wait` status is applied by `withDeliverWait` at render time.
 */
function gateFacts(run: DeliverRun, results: readonly DeliverGateResult[]): DeliverGateFact[] {
  const current = run.state === 'running' ? run.currentGate ?? run.gates[run.finished] ?? null : null;
  const fallbackRepo = results.at(-1)?.repo ?? '';
  const seen = new Map<string, number>();
  const out: DeliverGateFact[] = [];
  for (const name of run.gates) {
    const own = results.filter((r) => r.gateName === name);
    const at = seen.get(name) ?? 0;
    seen.set(name, at + 1);
    const r = own[at];
    if (r === undefined) {
      out.push({ name, repo: fallbackRepo, status: name === current ? 'run' : 'pending', startedAt: null, endedAt: null, exitCode: null });
      continue;
    }
    const status: DeliverGateFact['status'] = r.exitCode === 0 || (r.exitCode === null && r.summary?.startsWith('skipped:') === true) ? 'pass' : r.exitCode === null ? 'pending' : 'fail';
    out.push({ name, repo: r.repo, status, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode });
  }
  return out;
}

export function deliverFactsFor(store: Store, ticketId: number): DeliverFacts {
  const run = currentDeliverRun(store, ticketId);
  const running: DeliverFacts['running'] = run !== null && run.state === 'running'
    ? { n: Math.min(run.finished + 1, run.gates.length), m: run.gates.length, gate: run.currentGate ?? run.gates[run.finished] ?? '', ...(run.kind === 'after-take-over' ? { afterTakeOver: true } : {}), ...(run.kind === 'base-moved' ? { baseCheck: true } : {}) }
    : null;
  const failures = listDeliverFailures(store, ticketId)
    .filter((f) => f.exitCode !== null)
    .map((f) => ({ gate: f.gateName, repo: f.repo, exitCode: f.exitCode as number, headSha: f.headSha, summary: f.summary }));
  const results = run === null ? [] : listDeliverResults(store, ticketId).filter((r) => r.runId === run.id);
  let takenOver: DeliverFacts['takenOver'] = null;
  if (run !== null && run.state === 'taken-over') {
    takenOver = {
      failed: results.filter((r) => r.exitCode !== null && r.exitCode !== 0).map((r) => r.gateName),
      skipped: skippedGates(run.gates, results.map((r) => r.gateName)),
    };
  }
  const gates = run === null ? {} : { gates: gateFacts(run, results) };
  return { running, failures, takenOver, roundActive: (running !== null && running.afterTakeOver !== true) || getConflictRoundAt(store, ticketId) !== null, headSha: currentHead(store, ticketId) ?? run?.headSha ?? null, ...gates };
}
