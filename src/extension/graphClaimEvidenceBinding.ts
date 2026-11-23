/**
 * The host seam for the claim evidence of a `blocked` node (T1323,
 * `@arch:GRAPH-AUTORECOVERY`). It runs before each settle of a graph run, and it
 * never throws: a failed evidence step is logged, and the settle runs as before.
 */

import { recordClaimEvidence, type ClaimEvidenceDeps } from '../approaches/graph/integration/claimEvidence.js';

/** `depsOf` is undefined while the coordinator store or the transport is not wired. */
export function createGraphClaimEvidence(
  depsOf: (graphRunId: number) => ClaimEvidenceDeps | undefined,
  logError: (message: string, error: unknown) => void,
): (graphRunId: number) => Promise<void> {
  return async (graphRunId) => {
    try {
      const deps = depsOf(graphRunId);
      if (deps) await recordClaimEvidence(deps, graphRunId);
    } catch (error) {
      logError(`karst: graph claim evidence failed for run ${graphRunId}`, error);
    }
  };
}
