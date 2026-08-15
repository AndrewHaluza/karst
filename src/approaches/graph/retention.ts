/**
 * Graph byte-subtree retention (Slice 2 Task 8).
 *
 * Graph bytes live under global storage — `<globalStorage>/graph/<projectSlug>/
 * <ticketId>/` — OUTSIDE every worktree (E4). Archive removes nothing: graph
 * evidence survives archive and dies only with `deleteTicket`, which removes
 * the subtree after its rows. The activation sweep is the net for subtrees
 * that outlived their runs: a subtree whose ticket no longer exists, or whose
 * every graph run is `closed`, is removed. No per-ticket pruning of a LIVE
 * ticket's history in V1 (a cancelled or stale run keeps its evidence).
 *
 * Host-agnostic: the two predicates are injected; this module walks the
 * directory tree with node:fs only.
 */

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface ReapGraphDeps {
  /** True when a ticket with this project slug + id still exists. */
  ticketExists: (projectSlug: string, ticketId: number) => boolean;
  /** True when every graph run of this ticket is `closed`. */
  allGraphRunsClosed: (ticketId: number) => boolean;
}

export interface ReapGraphResult {
  removed: Array<{ projectSlug: string; ticketId: number }>;
}

/** Remove one ticket's graph byte subtree (after its rows are gone). */
export function removeTicketGraphSubtree(
  graphBytesRoot: string,
  ticketId: number,
): void {
  rmSync(join(graphBytesRoot, String(ticketId)), { recursive: true, force: true });
}

/** One line naming a subtree this sweep removed, for the output channel. */
export function describeGraphReap(r: { projectSlug: string; ticketId: number }): string {
  return (
    `karst: removed graph byte subtree for ${r.projectSlug}/${r.ticketId} ` +
    '(ticket gone or every graph run closed)'
  );
}

/**
 * The activation sweep: remove every `<graphRoot>/<projectSlug>/<ticketId>/`
 * subtree whose ticket no longer exists or whose graph run is `closed`.
 * Per-project errors are swallowed per subtree — a vanished subtree mid-sweep
 * is a normal race, never a failure of the whole pass.
 */
export function reapClosedGraphSubtrees(
  graphRoot: string,
  deps: ReapGraphDeps,
): ReapGraphResult {
  const removed: ReapGraphResult['removed'] = [];
  let projectSlugs: string[] = [];
  try {
    projectSlugs = readdirSync(graphRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { removed };
  }
  for (const projectSlug of projectSlugs) {
    let ticketIds: string[] = [];
    try {
      ticketIds = readdirSync(join(graphRoot, projectSlug), { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const ticketIdText of ticketIds) {
      const ticketId = Number(ticketIdText);
      try {
        const alive = deps.ticketExists(projectSlug, ticketId);
        if (alive && !deps.allGraphRunsClosed(ticketId)) continue;
        rmSync(join(graphRoot, projectSlug, ticketIdText), {
          recursive: true,
          force: true,
        });
        removed.push({ projectSlug, ticketId });
      } catch {
        // A subtree that vanishes mid-sweep is a race with another window's
        // delete, not a failure of this pass.
      }
    }
  }
  return { removed };
}
