import type { Store } from '../../store/db.js';
import type { GitRunner } from '../../integrations/git.js';
import type { Manifest } from '../../manifest/types.js';
import type { Notify } from './notify.js';
import { archiveTicket, unarchiveTicket } from '../../store/tickets.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { listArchives } from '../../store/worktreeArchives.js';
import { archiveWorktree, restoreWorktree } from '../../runtime/archive.js';
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
