import type { Store } from '../../store/db.js';
import type { GitRunner } from '../../integrations/git.js';
import type { Manifest } from '../../manifest/types.js';
import type { Notify } from './notify.js';
import { archiveTicket, unarchiveTicket } from '../../store/tickets.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { listArchives } from '../../store/worktreeArchives.js';
import { archiveWorktree, restoreWorktree } from '../../runtime/archive.js';
import { archiveInactiveWorktrees } from '../../runtime/archiveBulk.js';
import { makePortAllocator } from '../../resolver/allocator.js';
import { describeReap } from '../../runtime/worktreeServers.js';
import { emptyManifest } from '../../extension/manifestResolve.js';

export interface ArchiveOpsDeps {
  readonly store: Store;
  readonly git: GitRunner;
  readonly notify: Notify;
  readonly log: { info(m: string): void; error(m: string, e: unknown): void };
  readonly appendLine: (m: string) => void;
  readonly closeDoneTerminals: (ticketId: number) => number;
  readonly manifest: () => Manifest | undefined;
  readonly refresh: () => void;
}

export async function archiveTicketOp(deps: ArchiveOpsDeps, ticketId: number): Promise<void> {
  archiveTicket(deps.store, ticketId);
  // Setting-gated (`closeDoneTerminalsWithTicket`, OFF by default): the
  // ticket is being closed, so its DONE terminals go with it — dead tabs
  // whose process already exited, never a live session. A disposal failure
  // must not fail the archive itself, so this is wrapped and reported.
  if ((deps.manifest() ?? emptyManifest()).closeDoneTerminalsWithTicket === true) {
    try {
      const closed = deps.closeDoneTerminals(ticketId);
      if (closed > 0) {
        deps.log.info(`karst: closed ${closed} done terminal(s) with ticket ${ticketId}`);
      }
    } catch (err) {
      deps.log.error('karst: closing done terminals with ticket failed', err);
    }
  }
  const manifest = deps.manifest();
  if (manifest) {
    const allocator = makePortAllocator(deps.store, manifest.portRange);
    for (const w of listWorktreesByTicket(deps.store, ticketId)) {
      if (!w.branch) continue;
      try {
        const r = await archiveWorktree(deps.git, deps.store, allocator, {
          ticketId,
          repoPath: w.repo,
          path: w.path,
          branch: w.branch,
          baseRef: w.baseRef ?? w.branch,
        });
        // Archiving removes the tree out from under anything running in it,
        // so whatever had to be stopped is named here. A kill that FAILED is
        // a live server serving a deleted tree — the exact orphan this
        // ticket exists to end — so it is a warning, not a log line.
        for (const s of r.reapedServers) {
          deps.log.info(describeReap(s));
          if (s.outcome === 'kill-failed') {
            deps.notify.warn(describeReap(s));
          }
        }
      } catch (err) {
        deps.appendLine(`archive worktree failed for ${w.path}: ${String(err)}`);
        deps.notify.warn(`Worktree not archived: ${String(err)}`);
      }
    }
  }
  deps.refresh();
}

export interface ArchiveInactiveDeps {
  readonly store: Store;
  readonly git: GitRunner;
  readonly manifest: () => Manifest | undefined;
  readonly projectId: () => number | undefined;
  readonly notify: Notify;
  readonly log: { info(m: string): void };
  readonly refresh: () => void;
}

/**
 * Bulk-archive every inactive worktree for the bound project. Destructive, so an
 * unbound window (no manifest, or no project) refuses instead of degrading to an
 * all-projects sweep; whatever the sweep had to stop to remove a tree is reported
 * too, because a kill that FAILED leaves a live server serving a deleted tree.
 */
export async function archiveInactiveWorktreesOp(deps: ArchiveInactiveDeps): Promise<void> {
  const manifest = deps.manifest();
  if (!manifest) {
    deps.notify.warn('Karst: no manifest loaded.');
    return;
  }
  const projectId = deps.projectId();
  if (projectId === undefined) {
    deps.notify.warn('Karst: no project bound — refusing to archive inactive worktrees.');
    return;
  }
  const allocator = makePortAllocator(deps.store, manifest.portRange);
  const summary = await archiveInactiveWorktrees(deps.git, deps.store, allocator, { projectId });
  // Say what the sweep had to stop to remove those trees. An unattended bulk
  // archive is the last place a killed — or unkillable — dev server may go
  // unsaid; aggregated into one message rather than one popup per row, since a
  // sweep can touch many worktrees at once.
  for (const s of summary.reapedServers) deps.log.info(describeReap(s));
  const stopped = summary.reapedServers.filter((s) => s.outcome === 'killed').length;
  const stillRunning = summary.reapedServers.filter((s) => s.outcome === 'kill-failed');
  deps.notify.info(
    `Karst: archived ${summary.archived} worktree(s), skipped ${summary.skipped}, failed ${summary.failed}` +
      (stopped > 0 ? `, stopped ${stopped} running server(s).` : '.'),
  );
  if (stillRunning.length > 0) {
    deps.notify.warn(
      `Karst: could not stop ${stillRunning.length} server(s) still running in archived ` +
        `worktrees — ${stillRunning.map((s) => `'${s.repo}' (pid ${s.pid ?? 'unknown'})`).join(', ')}.`,
    );
  }
  deps.refresh();
}

export async function unarchiveTicketOp(deps: ArchiveOpsDeps, ticketId: number): Promise<void> {
  for (const a of listArchives(deps.store, ticketId)) {
    try {
      const r = await restoreWorktree(deps.git, deps.store, { ticketId, path: a.path });
      if (r.outcome === 'skipped') {
        deps.notify.warn(`Worktree not restored: ${r.reason ?? 'unknown reason'}`);
      }
    } catch (err) {
      deps.appendLine(`restore worktree failed for ${a.path}: ${String(err)}`);
      deps.notify.warn(`Worktree not restored: ${String(err)}`);
    }
  }
  unarchiveTicket(deps.store, ticketId);
  deps.refresh();
}
