import type { Store } from '../store/db.js';
import type { OutputKind } from '../manifest/types.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { findTicketById } from '../store/tickets.js';
import { addArtifactFile, type AddedArtifact } from './addFile.js';
import { createArtifactStore } from './store.js';

/**
 * Resolve the ticket's project and worktrees from the registry and capture one
 * file — the single seam the `karst artifact add` CLI and the Changes-panel
 * action share, so both get the same containment and tracking.
 */
export function addArtifactForTicket(
  store: Store,
  artifactsRoot: string,
  ticketId: number,
  path: string,
  kind: OutputKind,
): Promise<AddedArtifact> {
  const ticket = findTicketById(store, ticketId);
  if (!ticket || ticket.projectId === null) {
    return Promise.reject(new Error('ticket has no project — cannot store artifacts'));
  }
  return addArtifactFile({
    store: createArtifactStore({ artifactsRoot, projectId: ticket.projectId }),
    artifactsRoot,
    projectId: ticket.projectId,
    ticketId,
    worktrees: listWorktreesByTicket(store, ticketId).map((w) => ({ repo: w.repo, path: w.path })),
    path,
    kind,
  });
}
