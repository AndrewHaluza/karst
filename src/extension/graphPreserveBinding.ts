/**
 * The host seams for node-work preservation (T1323, `@arch:GRAPH-AUTORECOVERY`).
 *
 * The provider, the reconcile sweep, the completion pipeline and the replan only
 * know injected preserve seams. This module binds them to the host-agnostic
 * `preserve.ts` module with the extension's own database handle, git runner and
 * graph artifact root. Keeping it here (and not in `extension.ts`) is what lets
 * the entry file stay inside its line ratchet.
 */

import {
  preserveNodeWork,
  readPreservedWorkForRun,
  restoreNodeWork,
  type PreservedNodeWork,
  type PreserveWorkInput,
  type PreserveWorkResult,
  type RestoreWorkInput,
  type RestoreWorkResult,
} from '../approaches/graph/workspace/preserve.js';
import { preserveBestEffort, type PreserveNodeWork } from '../approaches/graph/workspace/preserveBestEffort.js';
import type { GitRunner } from '../integrations/git.js';
import { nodeRunGraphRunId, nodeRunsForGraphRun, workspacesForNode } from '../store/graph/nodeRuns.js';
import type { GraphDb } from '../store/graph/transitions.js';

export interface GraphPreserveSeams {
  preserveWork: (input: PreserveWorkInput) => Promise<PreserveWorkResult>;
  restoreWork: (input: RestoreWorkInput) => Promise<RestoreWorkResult>;
  /** Preserve one node run's work, in all of its domains. */
  preserveNode: PreserveNodeWork;
  /** The preserved patches of a graph run, for the replan reasons. */
  preservedWorkOf: (graphRunId: number) => PreservedNodeWork[];
  /** Preserve the work of each node that requested the replan. Never throws on a
   *  preserve failure: it is logged, and the replan continues. */
  preserveReplanRequesters: (graphRunId: number) => Promise<void>;
  /** The recorded clone of a node run for one repository. */
  workspaceCwdOf: (nodeRunId: number, repoName: string) => string | undefined;
}

export function graphPreserveSeams(
  db: () => GraphDb | undefined,
  artifactRoot: (graphRunId: number) => string,
  git: GitRunner,
  debug?: (message: string) => void,
): GraphPreserveSeams {
  const preserveWork = async (input: PreserveWorkInput): Promise<PreserveWorkResult> => {
    const handle = db();
    // Never `nothing`: the provider deletes a clone that has no work.
    if (!handle) return { kind: 'failed', reason: 'the graph store is not open' };
    return preserveNodeWork({ db: handle, git, artifactRoot, debug }, input);
  };
  const preserveNode: PreserveNodeWork = async (nodeRunId) => {
    const handle = db();
    const graphRunId = handle ? nodeRunGraphRunId(handle, nodeRunId) : undefined;
    return graphRunId === undefined ? { kind: 'nothing' } : preserveWork({ graphRunId, nodeRunId });
  };
  return {
    preserveWork,
    restoreWork: (input) => restoreNodeWork({ git, artifactRoot, debug }, input),
    preserveNode,
    preservedWorkOf: (graphRunId) => readPreservedWorkForRun({ artifactRoot }, graphRunId),
    preserveReplanRequesters: async (graphRunId) => {
      const handle = db();
      if (!handle) return;
      const requesters = nodeRunsForGraphRun(handle, graphRunId).filter(
        (row) => row.status === 'blocked' && row.outcome === 'replan',
      );
      for (const row of requesters) {
        await preserveBestEffort({ preserveWork: preserveNode, debug }, row.id, 'replan request');
      }
    },
    workspaceCwdOf: (nodeRunId, repoName) => {
      const handle = db();
      if (!handle) return undefined;
      return workspacesForNode(handle, nodeRunId).find((row) => row.repo_name === repoName)?.cwd;
    },
  };
}
