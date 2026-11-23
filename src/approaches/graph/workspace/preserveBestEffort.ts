/**
 * The preserve step of a caller that must continue when the preserve fails
 * (T1323, `@arch:GRAPH-AUTORECOVERY`): a drain cancel, a claim violation and a
 * replan launch. None of them removes the clone, so a failure loses no work.
 * The failure is logged, never swallowed.
 */

import type { PreserveWorkResult } from './preserve.js';

/** Write the work of one node run's clones to a patch. */
export type PreserveNodeWork = (nodeRunId: number) => Promise<PreserveWorkResult>;

export interface PreserveBestEffortDeps {
  preserveWork?: PreserveNodeWork;
  debug?: (message: string) => void;
}

/** Preserve one node run's work. Logs a throw or a `failed` result, and returns. */
export async function preserveBestEffort(
  deps: PreserveBestEffortDeps,
  nodeRunId: number,
  when: string,
): Promise<void> {
  if (!deps.preserveWork) return;
  try {
    const result = await deps.preserveWork(nodeRunId);
    if (result.kind === 'failed') {
      deps.debug?.(`[graph] ${when}: the work of node run ${nodeRunId} was not preserved: ${result.reason}`);
    }
  } catch (error) {
    deps.debug?.(`[graph] ${when}: preserving the work of node run ${nodeRunId} failed: ${String(error)}`);
  }
}
