import type { Store } from '../store/db.js';
import { activeFixRound } from '../store/recoveryRounds.js';
import { listGateRuns } from '../store/gateRuns.js';
import { claimHostRerunRequest, ticketsWithRequestedHostRerun } from '../store/hostRerunRound.js';
import { NO_NEW_COMMIT_REASON, assertFixHasNewCommit } from './fixRoundGuard.js';
import type { GitRunner } from '../integrations/git.js';
import { nowIso } from '../model/time.js';
import { failedGatesOf, hostRerunFailedGates, type HostRerunDeps, type HostRerunOutcome } from './fixHostRerun.js';

/**
 * Set by the bridge's marker runner on the CLI it spawns. The bridge re-runs the failed gates
 * itself (`recoverRefusal`), so the CLI must not also request a sweep re-run: both would aim at
 * one claim and the loser would park the round.
 */
export const MARKER_VIA_BRIDGE_ENV = 'KARST_MARKER_VIA_BRIDGE';

/** The refusal text the host CLI gives when it handed the round to the extension. */
export const HOST_RERUN_REQUESTED_REPLY =
  `cannot mark this stage done: ${NO_NEW_COMMIT_REASON}. The host re-runs the failed gates now and reports the result. Stop now: do not make an empty commit and do not fire the marker again`;

export type HostRerunRequestOutcome = { kind: 'not-applicable' } | { kind: 'requested'; message: string };

/**
 * The host CLI refused `stage fix pass` for no new commit. When the round came from a gate failure
 * and the host has not re-run yet, record one request for the extension to run (the CLI never runs
 * gates). Any other round, or a second refusal in the same round, gets no request.
 */
export function requestHostRerun(store: Store, ticketId: number, at: string): HostRerunRequestOutcome {
  const round = activeFixRound(store, ticketId);
  if (round === null || round.triggerKind !== 'gate-failure') return { kind: 'not-applicable' };
  if (failedGatesOf(listGateRuns(store, ticketId), round.sourceStage).length === 0) return { kind: 'not-applicable' };
  if (!claimHostRerunRequest(store, round.id, at)) return { kind: 'not-applicable' };
  return { kind: 'requested', message: HOST_RERUN_REQUESTED_REPLY };
}

/** The extension sweep: run the one host re-run of every requested round of this project. */
export async function runRequestedHostReruns(store: Store, projectId: number, deps: HostRerunDeps): Promise<HostRerunOutcome[]> {
  const outcomes: HostRerunOutcome[] = [];
  for (const ticketId of ticketsWithRequestedHostRerun(store, projectId)) outcomes.push(await hostRerunFailedGates(store, ticketId, deps));
  return outcomes;
}

/**
 * The host CLI's fix marker guard. A no-new-commit refusal of a gate-failure round asks the
 * extension for the one host re-run and tells the agent to stop; any other refusal passes through.
 */
export async function assertFixHasNewCommitOrRequestRerun(
  store: Store,
  ticketId: number,
  git: GitRunner,
  now: () => string = nowIso,
  options: { viaBridge?: boolean } = {},
): Promise<void> {
  try {
    await assertFixHasNewCommit(store, ticketId, git);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes(NO_NEW_COMMIT_REASON)) throw err;
    if (options.viaBridge === true) throw err;
    const request = requestHostRerun(store, ticketId, now());
    if (request.kind === 'requested') throw new Error(request.message);
    throw err;
  }
}
