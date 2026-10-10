/**
 * Capture a worktree's output files into the ticket's artifact store: base-diff
 * (see baseDiff.ts) → keep only files matching the `outputs:` union → commit each
 * through the store's per-ticket queue. Used by the watcher flush and by every
 * final sweep. Never throws: capture is best-effort and must not fail a
 * teardown the user asked for.
 */

import { basename, join } from 'node:path';

import type { TaggedOutput } from '../approaches/outputs.js';
import type { GitRunner } from '../integrations/git.js';
import { listBaseChanges } from './baseDiff.js';
import { matchOutput } from './globMatch.js';
import type { ArtifactStore, RevisionTrailers } from './store.js';

export interface CaptureDeps {
  store: Pick<ArtifactStore, 'commitRevision'>;
  git: GitRunner;
  outputs: () => readonly TaggedOutput[];
  trailers: (ticketId: number, output: TaggedOutput) => RevisionTrailers;
  debug: (message: string) => void;
}

export interface CaptureTarget {
  ticketId: number;
  repoPath: string;
  worktreePath: string;
  baseRef: string;
}

/**
 * Returns how many revisions were committed. `only` limits the pass to the paths
 * the watcher saw change; a sweep omits it for a full base-diff capture.
 */
export async function captureWorktree(
  deps: CaptureDeps,
  target: CaptureTarget,
  only?: ReadonlySet<string>,
): Promise<number> {
  const { debug } = deps;
  const repo = basename(target.repoPath);
  debug(`[artifacts] capture ${repo} (ticket ${target.ticketId}${only ? `, ${only.size} path(s)` : ', full'})`);
  try {
    const outputs = deps.outputs();
    if (outputs.length === 0) {
      debug('[artifacts] no outputs configured; nothing to capture');
      return 0;
    }
    const changes = await listBaseChanges(deps.git, target.worktreePath, target.baseRef, debug);
    let committed = 0;
    for (const change of changes) {
      if (only !== undefined && !only.has(change.relPath)) continue;
      const output = matchOutput(outputs, change.relPath);
      if (output === undefined) continue;
      const input = {
        ticketId: target.ticketId,
        repo,
        relPath: change.relPath,
        trailers: deps.trailers(target.ticketId, output),
      };
      const sha = await deps.store.commitRevision(
        change.kind === 'deleted'
          ? { ...input, deleted: true }
          : { ...input, sourcePath: join(target.worktreePath, change.relPath) },
      );
      if (sha !== null) committed += 1;
    }
    debug(`[artifacts] captured ${committed} revision(s) from ${repo}`);
    return committed;
  } catch (err) {
    debug(`[artifacts] capture failed in ${repo}: ${String(err)}`);
    return 0;
  }
}
