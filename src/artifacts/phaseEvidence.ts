/**
 * The phases a ticket's approach declares, and the host's evidence-based phase
 * mark (`@arch:RESULTS`, `@arch:APP-09`).
 *
 * Lives here, not under `src/extension/`, so the artifact layer can name a phase
 * without importing the VS Code-facing extension modules.
 */

import type { OutputKind } from '../manifest/types.js';
import type { Store } from '../store/db.js';
import { recordPhaseMark } from '../store/phaseMarks.js';
import type { RevisionEvent } from './capture.js';

/** One declared phase: its name, and the output kind whose capture proves it. */
export interface ApproachPhase {
  name: string;
  outputKind?: OutputKind;
}

export interface HostPhaseDeps {
  store: Store;
  phasesOf: (ticketId: number) => readonly ApproachPhase[];
  now: () => string;
  debug: (message: string) => void;
}

/**
 * Rule B: a captured revision can PROVE that a phase happened. When the first
 * revision of a kind the approach declares arrived inside the ticket's live
 * implementation run, the phase AFTER the one that declared that kind has
 * started, so the host records its mark.
 *
 * A host mark is evidence, never a verdict: it cannot move a stage, and the
 * unique host mark means the second capture of the same kind writes nothing.
 * Guards (`@arch:APP-09`): a deletion is never new evidence; a ticket outside
 * `impl` with a `running` run is a STALE run (real databases carry them), so it
 * writes nothing; and a phase that is last, or a kind no phase declares, has no
 * successor to enter.
 *
 * Throws only on a broken dependency (an unreadable phase list, a failing
 * write); the CALLER's catch is what keeps a capture safe from it —
 * `hostPhaseOnRevision` below.
 */
export function recordHostPhaseFromRevision(deps: HostPhaseDeps, event: RevisionEvent): boolean {
  if (event.deleted === true) return false;
  const run = deps.store.db
    .prepare(
      `SELECT id, attempt FROM implementation_runs
        WHERE ticket_id = ? AND status = 'running'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(event.ticketId) as { id: number; attempt: number } | undefined;
  if (run === undefined) return false;
  const ticket = deps.store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(event.ticketId) as
    | { stage_current: string | null }
    | undefined;
  if (ticket?.stage_current !== 'impl') return false;
  const phases = deps.phasesOf(event.ticketId);
  const evidenceAt = phases.findIndex((p) => p.outputKind === event.kind);
  if (evidenceAt === -1) return false;
  const next = phases[evidenceAt + 1];
  if (next === undefined) return false;
  return recordPhaseMark(deps.store, {
    ticketId: event.ticketId,
    stageKey: 'impl',
    attempt: run.attempt,
    phaseName: next.name,
    markedAt: deps.now(),
    source: 'host',
    implementationRunId: run.id,
  });
}

/**
 * The revision listener the capture service gets: rule B first, in its own
 * catch, then the caller's listener (the alignment trigger) — which therefore
 * always fires, whatever the phase rule did (`@arch:APP-12`).
 */
export function hostPhaseOnRevision(
  deps: HostPhaseDeps,
  forwarded?: (event: RevisionEvent) => void,
): (event: RevisionEvent) => void {
  return (event) => {
    try {
      recordHostPhaseFromRevision(deps, event);
    } catch (err) {
      deps.debug(`[artifacts] host phase mark failed for ticket ${event.ticketId}: ${String(err)}`);
    }
    forwarded?.(event);
  };
}
