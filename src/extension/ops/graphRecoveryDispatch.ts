/**
 * The one graph-recovery dispatch the buttons and the coordinator sweep share
 * (vscode-free). `recoverGraphRun` only changes the store: a `replanned` or
 * `relaunched` result still needs its planner session launched, and every
 * recovery that started work needs the surfaces refreshed and the run
 * continued. Keeping that follow-up here means a human click and an automatic
 * recovery cannot drift apart.
 */

import type {
  BootstrapRelaunchRequest,
  GraphRecoveryMode,
  RecoveryResult,
} from '../../approaches/graph/coordinator/recovery.js';
import type { ReplanLaunchRequest } from '../../approaches/graph/coordinator/replan.js';

export interface GraphRecoverySeams {
  /** Runs `recoverGraphRun` against the host's planner and prompt seams. */
  recover: (input: { ticketId: number; graphRunId: number; mode?: GraphRecoveryMode }) => RecoveryResult;
  /** Starts the elected replan planner session. */
  launchReplan: (launch: ReplanLaunchRequest) => void;
  /** Starts a fresh bootstrap planner for a run whose planner died. */
  launchBootstrap: (launch: BootstrapRelaunchRequest) => void;
  /** Refreshes the surfaces and continues the work recovery made ready. */
  onRecovered: (ticketId: number, graphRunId: number) => void;
}

/** Recover one run, then launch what the result elected and wake the work. */
export function dispatchGraphRecovery(
  seams: GraphRecoverySeams,
  input: { ticketId: number; graphRunId: number; mode?: GraphRecoveryMode },
): RecoveryResult {
  const result = seams.recover(input);
  if (result.kind === 'refused' || result.kind === 'no-op') return result;
  if (result.kind === 'replanned' && result.launch) seams.launchReplan(result.launch);
  if (result.kind === 'relaunched' && result.launch) seams.launchBootstrap(result.launch);
  seams.onRecovered(input.ticketId, input.graphRunId);
  return result;
}
