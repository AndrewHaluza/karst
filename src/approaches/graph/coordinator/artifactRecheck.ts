/**
 * The artifact-fault exit (the `artifact-recheck` recovery category).
 *
 * `output-artifact-missing` and `artifact-unsafe` are the two node-run rest
 * states the integration pipeline writes when a REQUIRED output did not exist
 * or did not survive the snapshot protocol. They mean "a human must correct
 * something out of band", so nothing may auto-retry them: a sweep-driven retry
 * would relaunch straight back into the same fault and burn agent spend. But
 * they are not a dead end either — `NODE_RUN_TRANSITIONS` has declared
 * `output-artifact-missing → launching` and `artifact-unsafe → launching`
 * since the status pair existed, and the design's recovery table promises that
 * an explicit Resume, AFTER the correction, succeeds.
 *
 * What makes the correction evidence rather than a claim is this module: at
 * Resume time every artifact-faulted node run of the graph run is RE-PROBED
 * through `validateRequiredOutputs` — the very function whose verdict parked
 * it, against the same declared output paths and the same content-addressed
 * artifact root. Only a probe that now passes lets recovery move the node; a
 * probe that still fails keeps the refusal, naming the artifact. A Resume that
 * blindly relaunched would be barely better than the permanent refusal it
 * replaced, and per doctrine a claim is re-probed, never assumed.
 *
 * The artifact root is the host's (it lives under extension global storage),
 * so it arrives as an injected seam. An UNWIRED root is not "nothing to
 * check": it is an unprovable correction, and the recheck fails closed.
 *
 * Host-agnostic: db + the root seam; no vscode, no provider, no fs path
 * knowledge of its own.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { validateRequiredOutputs } from '../artifacts/resolve.js';
import { declaredOutputPaths } from '../integration/pipeline.js';

/** The closed artifact-fault status pair — a proven-terminated process whose
 *  required output did not validate. */
export const ARTIFACT_FAULT_STATUSES = ['output-artifact-missing', 'artifact-unsafe'] as const;
export type ArtifactFaultStatus = (typeof ARTIFACT_FAULT_STATUSES)[number];

export interface ArtifactFaultRow {
  id: number;
  revision_id: number;
  node_id: string;
  status: ArtifactFaultStatus;
}

/** The artifact-faulted node runs of a graph run, in durable (rowid) order. */
export function artifactFaultNodeRows(db: GraphDb, graphRunId: number): ArtifactFaultRow[] {
  return db
    .prepare(
      `SELECT id, revision_id, node_id, status FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${ARTIFACT_FAULT_STATUSES.map(() => '?').join(',')})
       ORDER BY id`,
    )
    .all(graphRunId, ...ARTIFACT_FAULT_STATUSES) as ArtifactFaultRow[];
}

export type ArtifactRecheckOutcome =
  | { ok: true; rechecked: number[] }
  | { ok: false; detail: string };

/**
 * Re-probe every artifact-faulted node run of a graph run. `ok` means every
 * one of them now validates — the corrections are real and the reserved visits
 * may be retried. `detail` is BOUNDED wording built from stored ids and the
 * declared artifact id only: the probe's own `reason` can quote file prose, so
 * it never reaches a diagnostic verbatim.
 *
 * A graph run with no artifact fault is trivially ok — this is a filter over
 * the fault set, never a gate on unrelated recoveries.
 */
export function recheckArtifactFaults(
  db: GraphDb,
  graphRunId: number,
  artifactRoot?: (graphRunId: number) => string | undefined,
): ArtifactRecheckOutcome {
  const faults = artifactFaultNodeRows(db, graphRunId);
  if (faults.length === 0) return { ok: true, rechecked: [] };
  const root = artifactRoot?.(graphRunId);
  if (!root) {
    return { ok: false, detail: 'the artifact root is unknown — the correction cannot be verified' };
  }
  const rechecked: number[] = [];
  for (const fault of faults) {
    const validation = validateRequiredOutputs(db, {
      revisionId: fault.revision_id,
      nodeId: fault.node_id,
      nodeRunId: fault.id,
      outputPaths: declaredOutputPaths(db, fault.revision_id, fault.node_id, root),
      snapshotDir: root,
    });
    if (!validation.ok) {
      return {
        ok: false,
        detail: `node run ${fault.id}: artifact "${validation.artifactId}" still ${validation.code}`,
      };
    }
    rechecked.push(fault.id);
  }
  return { ok: true, rechecked };
}
