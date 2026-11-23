/**
 * The host seam for node-work preservation (T1323, `@arch:GRAPH-AUTORECOVERY`).
 *
 * `workspace/provider.ts` only knows the injected `preserveWork` and
 * `restoreWork` seams. This module binds them to the host-agnostic
 * `preserve.ts` module with the extension's own database handle, git runner and
 * graph artifact root. Keeping it here (and not in `extension.ts`) is what lets
 * the entry file stay inside its line ratchet.
 */

import {
  preserveNodeWork,
  restoreNodeWork,
  type PreserveWorkInput,
  type PreserveWorkResult,
  type RestoreWorkInput,
  type RestoreWorkResult,
} from '../approaches/graph/workspace/preserve.js';
import type { GitRunner } from '../integrations/git.js';
import type { GraphDb } from '../store/graph/transitions.js';

export interface GraphPreserveSeams {
  preserveWork: (input: PreserveWorkInput) => Promise<PreserveWorkResult>;
  restoreWork: (input: RestoreWorkInput) => Promise<RestoreWorkResult>;
}

export function graphPreserveSeams(
  db: () => GraphDb | undefined,
  artifactRoot: (graphRunId: number) => string,
  git: GitRunner,
  debug?: (message: string) => void,
): GraphPreserveSeams {
  return {
    preserveWork: async (input) => {
      const handle = db();
      if (!handle) return { kind: 'nothing' };
      return preserveNodeWork({ db: handle, git, artifactRoot, debug }, input);
    },
    restoreWork: (input) => restoreNodeWork({ git, artifactRoot, debug }, input),
  };
}
