/**
 * Binds the artifact capture service to the extension's seams (fs.watch, git
 * runner, logger) and exposes the hooks `extension.ts` hands to the archive,
 * delete and session-close paths. vscode-free; `extension.ts` keeps only the call.
 */

import type { watch as nodeWatch } from 'node:fs';

import { createArtifactCaptureService, type ArtifactCaptureService, type ArtifactCaptureServiceDeps } from '../artifacts/service.js';
import { nodeFsWatch } from '../artifacts/watcher.js';
import type { ArchiveTarget } from '../runtime/archive.js';

/** How often the watcher set is reconciled to the project's live worktrees. */
export const WATCHER_SYNC_MS = 10_000;

export interface ArtifactCaptureWiring {
  readonly service: ArtifactCaptureService;
  /** Final sweep awaited before a worktree is archived/removed. */
  readonly beforeRemove: (target: ArchiveTarget) => Promise<void>;
  /** The agent session closed: capture what the debounce had not flushed yet. */
  readonly onSessionEnd: (ticketId: number) => void;
  /** Hook payload fan-in: SessionEnd runs the final capture; PostToolUse captures the notified edit path. */
  readonly onHookEvent: (
    ticketId: number,
    payload: { hook_event_name?: string; cwd?: string; file_path?: string; session_id?: string },
  ) => void;
  /** First reconcile. Separate from wiring: `deps` may close over bindings not initialised yet. */
  readonly start: () => void;
  readonly dispose: () => void;
}

export function wireArtifactCapture(
  deps: Omit<ArtifactCaptureServiceDeps, 'watch'> & { fsWatch: typeof nodeWatch },
): ArtifactCaptureWiring {
  const service = createArtifactCaptureService({ ...deps, watch: nodeFsWatch(deps.fsWatch) });
  const onSessionEnd = (ticketId: number): void => {
    void service.captureTicket(ticketId).catch((err: unknown) => {
      deps.debug(`[artifacts] session-end capture failed for ticket ${ticketId}: ${String(err)}`);
    });
  };
  const timer = setInterval(() => service.syncWatchers(), WATCHER_SYNC_MS);
  timer.unref();
  return {
    service,
    start: () => service.syncWatchers(),
    beforeRemove: (t) =>
      service.sweepWorktree({ ticketId: t.ticketId, repoPath: t.repoPath, worktreePath: t.path, baseRef: t.baseRef }),
    onSessionEnd,
    onHookEvent: (ticketId, payload) => {
      if (payload.hook_event_name === 'SessionEnd') {
        onSessionEnd(ticketId);
        return;
      }
      if (payload.hook_event_name !== 'PostToolUse' || !payload.file_path || !payload.cwd) return;
      void service
        .captureEdit({
          ticketId,
          cwd: payload.cwd,
          filePath: payload.file_path,
          ...(payload.session_id !== undefined ? { sessionId: payload.session_id } : {}),
        })
        .catch((err: unknown) => {
          deps.debug(`[artifacts] hook edit capture failed for ticket ${ticketId}: ${String(err)}`);
        });
    },
    dispose: () => {
      clearInterval(timer);
      service.dispose();
    },
  };
}
