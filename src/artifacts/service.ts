/**
 * Artifact capture service: owns the worktree watchers and the final sweeps for
 * one project. Host-agnostic (the extension binds fs.watch, the git runner and
 * the logger), so `extension.ts` stays a thin binding.
 */

import { join } from 'node:path';

import { effectiveOutputs } from '../approaches/outputs.js';
import type { GitRunner } from '../integrations/git.js';
import type { Manifest } from '../manifest/types.js';
import type { Store } from '../store/db.js';
import { listWorktreesByProject, listWorktreesByTicket } from '../store/dashboard.js';
import { captureWorktree, type CaptureDeps, type CaptureTarget } from './capture.js';
import { hookTrailers, locateHookEdit } from './hookEdit.js';
import { mirrorGraphArtifacts } from './graphMirror.js';
import { createArtifactStore, type ArtifactStore } from './store.js';
import { createFinalSweep } from './sweep.js';
import { resolveTrailers } from './tags.js';
import { createWorktreeWatcher, type FsWatch } from './watcher.js';

export interface ArtifactCaptureServiceDeps {
  store: Store;
  /** `<globalStorage>` root; the artifact store lives under `<root>/artifacts`. */
  globalStorageRoot: string;
  projectId: () => number | undefined;
  manifest: () => Manifest | undefined;
  git: GitRunner;
  watch: FsWatch;
  debug: (message: string) => void;
}

export interface AgentEdit {
  ticketId: number;
  /** Hook `cwd` (the session worktree). */
  cwd: string;
  /** Agent-authored path; untrusted, only ever re-read by karst. */
  filePath: string;
  /** Provider session id from the hook payload. */
  sessionId?: string;
}

export interface ArtifactCaptureService {
  /** Agent post-edit hook: capture ONE notified path, tagged `agent-hook`. Never throws. */
  captureEdit(edit: AgentEdit): Promise<void>;
  /** Reconcile the watchers to the project's live worktrees. */
  syncWatchers(): void;
  /** Final sweep of one worktree; call BEFORE removing it. Never throws. */
  sweepWorktree(target: CaptureTarget): Promise<void>;
  /** Mirror the ticket's non-sensitive graph artifacts into its history. Never throws. */
  mirrorGraph(ticketId: number): Promise<void>;
  /** Session close: graph mirror plus a full capture of every worktree, watchers kept. Never throws. */
  captureTicket(ticketId: number): Promise<void>;
  /** Drop the ticket's whole artifact history. */
  purge(ticketId: number): Promise<void>;
  dispose(): void;
}

export function createArtifactCaptureService(deps: ArtifactCaptureServiceDeps): ArtifactCaptureService {
  let artifacts: { projectId: number; store: ArtifactStore } | undefined;
  const storeFor = (projectId: number): ArtifactStore => {
    if (artifacts?.projectId !== projectId) {
      artifacts = {
        projectId,
        store: createArtifactStore({ artifactsRoot: join(deps.globalStorageRoot, 'artifacts'), projectId }),
      };
    }
    return artifacts.store;
  };

  const captureDeps = (projectId: number): CaptureDeps => ({
    store: storeFor(projectId),
    git: deps.git,
    outputs: () => {
      const manifest = deps.manifest();
      return manifest ? effectiveOutputs(manifest) : [];
    },
    trailers: (ticketId, output) => resolveTrailers(deps.store, ticketId, output),
    debug: deps.debug,
  });

  const watcher = createWorktreeWatcher({
    watch: deps.watch,
    outputs: () => {
      const manifest = deps.manifest();
      return manifest ? effectiveOutputs(manifest) : [];
    },
    capture: (target, only) => {
      const projectId = deps.projectId();
      return projectId === undefined ? Promise.resolve(0) : captureWorktree(captureDeps(projectId), target, only);
    },
    debug: deps.debug,
  });

  const targetOf = (w: { ticketId: number; repo: string; path: string; baseRef?: string | null; branch?: string | null }): CaptureTarget => ({
    ticketId: w.ticketId,
    repoPath: w.repo,
    worktreePath: w.path,
    baseRef: w.baseRef ?? w.branch ?? '',
  });

  const sweepWorktree = async (target: CaptureTarget): Promise<void> => {
    const projectId = deps.projectId();
    if (projectId === undefined) return;
    await createFinalSweep({ capture: captureDeps(projectId), watcher })(target);
  };

  const mirrorGraph = async (ticketId: number): Promise<void> => {
    const projectId = deps.projectId();
    if (projectId === undefined) return;
    try {
      await mirrorGraphArtifacts(
        { store: deps.store, artifacts: storeFor(projectId), debug: deps.debug },
        ticketId,
      );
    } catch (err) {
      deps.debug(`[artifacts] graph mirror failed for ticket ${ticketId}: ${String(err)}`);
    }
  };

  const captureEdit = async (edit: AgentEdit): Promise<void> => {
    const projectId = deps.projectId();
    if (projectId === undefined) return;
    try {
      const targets = listWorktreesByTicket(deps.store, edit.ticketId).map(targetOf);
      const hit = locateHookEdit(targets, edit.cwd, edit.filePath);
      if (hit === undefined) {
        deps.debug(`[artifacts] hook edit rejected for ticket ${edit.ticketId}: outside every worktree`);
        return;
      }
      const base = captureDeps(projectId);
      await captureWorktree(
        { ...base, trailers: (id, output) => hookTrailers(base.trailers(id, output), edit.sessionId) },
        hit.target,
        new Set([hit.relPath]),
      );
    } catch (err) {
      deps.debug(`[artifacts] hook edit capture failed for ticket ${edit.ticketId}: ${String(err)}`);
    }
  };

  return {
    captureEdit,
    syncWatchers() {
      const projectId = deps.projectId();
      if (projectId === undefined) return;
      const targets = listWorktreesByProject(deps.store, projectId).map((w) => {
        const full = listWorktreesByTicket(deps.store, w.ticketId).find((x) => x.path === w.path);
        return targetOf({ ticketId: w.ticketId, repo: w.repo, path: w.path, baseRef: full?.baseRef, branch: w.branch });
      });
      watcher.sync(targets.filter((t) => t.baseRef !== ''));
    },
    sweepWorktree,
    mirrorGraph,
    async captureTicket(ticketId) {
      const projectId = deps.projectId();
      if (projectId === undefined) return;
      await mirrorGraph(ticketId);
      for (const w of listWorktreesByTicket(deps.store, ticketId)) {
        await captureWorktree(captureDeps(projectId), targetOf(w));
      }
    },
    async purge(ticketId) {
      const projectId = deps.projectId();
      if (projectId === undefined) return;
      deps.debug(`[artifacts] purging ticket ${ticketId}`);
      await storeFor(projectId).purgeArtifacts(ticketId);
    },
    dispose: () => watcher.closeAll(),
  };
}
