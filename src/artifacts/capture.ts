/**
 * Capture a worktree's output files into the ticket's artifact store: base-diff
 * (see baseDiff.ts) → keep only files matching the `outputs:` union → commit each
 * through the store's per-ticket queue. Used by the watcher flush and by every
 * final sweep. Never throws: capture is best-effort and must not fail a
 * teardown the user asked for.
 */

import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { TaggedOutput } from '../approaches/outputs.js';
import type { GitRunner } from '../integrations/git.js';
import { listBaseChangesChecked } from './baseDiff.js';
import { matchOutput } from './globMatch.js';
import type { ArtifactStore, RevisionTrailers } from './store.js';
import { SOURCE_MANUAL, SOURCE_WATCHER } from './tags.js';
import { treeRepoName } from './treeRepo.js';

export interface CaptureDeps {
  store: Pick<ArtifactStore, 'commitRevision' | 'listArtifacts' | 'history'>;
  git: GitRunner;
  outputs: () => readonly TaggedOutput[];
  trailers: (ticketId: number, output: TaggedOutput) => RevisionTrailers;
  debug: (message: string) => void;
  /** Fired after each committed revision; a throwing listener never fails the capture. */
  onRevision?: (event: RevisionEvent) => void;
}

export interface RevisionEvent {
  ticketId: number;
  kind: string;
  sha: string;
  /** Tree path: `<repo>/<relPath>`. */
  path: string;
}

export interface CaptureTarget {
  ticketId: number;
  repoPath: string;
  worktreePath: string;
  baseRef: string;
}

/** Entries in a git dir that mean a merge, rebase, cherry-pick or revert is mid-flight. */
const GIT_OPERATION_MARKERS = ['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

/** First in-progress git operation marker of the worktree (a linked worktree has its own git dir). */
async function gitOperationInProgress(git: GitRunner, worktreePath: string): Promise<string | undefined> {
  const r = await git(['rev-parse', '--git-dir'], worktreePath);
  const dir = r.stdout.trim();
  if (r.exitCode !== 0 || dir === '') return undefined;
  const gitDir = isAbsolute(dir) ? dir : join(worktreePath, dir);
  for (const marker of GIT_OPERATION_MARKERS) {
    try {
      await access(join(gitDir, marker));
      return marker;
    } catch {
      /* absent */
    }
  }
  return undefined;
}

/**
 * Removal revisions for stored paths of `repo` that are no longer ticket changes
 * (a file that arrived from the base): only watcher / manual-edit revisions go.
 */
async function removeStalePaths(
  deps: CaptureDeps,
  target: CaptureTarget,
  repo: string,
  outputs: readonly TaggedOutput[],
  current: ReadonlySet<string>,
): Promise<number> {
  let removed = 0;
  for (const { path } of await deps.store.listArtifacts(target.ticketId)) {
    if (!path.startsWith(`${repo}/`)) continue;
    const relPath = path.slice(repo.length + 1);
    if (current.has(relPath)) continue;
    const output = matchOutput(outputs, relPath);
    if (output === undefined) continue;
    const source = (await deps.store.history(target.ticketId, path))[0]?.trailers.source;
    if (source !== SOURCE_WATCHER && source !== SOURCE_MANUAL) continue;
    const sha = await deps.store.commitRevision({
      ticketId: target.ticketId,
      repo,
      relPath,
      trailers: deps.trailers(target.ticketId, output),
      deleted: true,
    });
    if (sha !== null) {
      removed += 1;
      deps.debug(`[artifacts] removed ${path}: no longer a ticket change`);
    }
  }
  return removed;
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
  const repo = treeRepoName(target.repoPath);
  debug(`[artifacts] capture ${repo} (ticket ${target.ticketId}${only ? `, ${only.size} path(s)` : ', full'})`);
  try {
    const outputs = deps.outputs();
    if (outputs.length === 0) {
      debug('[artifacts] no outputs configured; nothing to capture');
      return 0;
    }
    const inProgress = await gitOperationInProgress(deps.git, target.worktreePath);
    if (inProgress !== undefined) {
      debug(`[artifacts] ${inProgress} present in ${repo}; git operation in progress, capture skipped`);
      return 0;
    }
    const checked = await listBaseChangesChecked(deps.git, target.worktreePath, target.baseRef, debug);
    const changes = checked ?? [];
    // An uncomputable diff must not look like "nothing is a ticket change any more".
    let committed =
      checked === null ? 0 : await removeStalePaths(deps, target, repo, outputs, new Set(changes.map((c) => c.relPath)));
    for (const change of changes) {
      if (only !== undefined && !only.has(change.relPath)) continue;
      const output = matchOutput(outputs, change.relPath);
      if (output === undefined) continue;
      const trailers = deps.trailers(target.ticketId, output);
      const input = { ticketId: target.ticketId, repo, relPath: change.relPath, trailers };
      const sha = await deps.store.commitRevision(
        change.kind === 'deleted'
          ? { ...input, deleted: true }
          : { ...input, sourcePath: join(target.worktreePath, change.relPath) },
      );
      if (sha !== null) {
        committed += 1;
        try {
          deps.onRevision?.({ ticketId: target.ticketId, kind: trailers.kind ?? output.kind, sha, path: `${repo}/${change.relPath}` });
        } catch (err) {
          debug(`[artifacts] revision listener failed: ${String(err)}`);
        }
      }
    }
    debug(`[artifacts] captured ${committed} revision(s) from ${repo}`);
    return committed;
  } catch (err) {
    debug(`[artifacts] capture failed in ${repo}: ${String(err)}`);
    return 0;
  }
}
