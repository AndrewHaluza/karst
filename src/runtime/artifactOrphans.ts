/**
 * Global artifact-dir orphan sweep (ORPHANED-ARTIFACTS-AND-FILES).
 *
 * Gate console logs live under global storage — `<globalStorage>/artifacts/
 * <ticketId>/` — OUTSIDE every worktree, keyed by numeric ticket id. The dir is
 * removed on hard delete (`deleteTicket`'s `artifactsRoot`), but a dir whose
 * ticket is gone is only reachable from a sweep, exactly like the graph byte
 * subtrees (`approaches/graph/retention.ts`) and like `reapStaleServers` for
 * servers. This walk is the net: a numeric ticket dir whose ticket no longer
 * exists is removed. A dir whose ticket exists is left strictly alone — the
 * console tail is the ticket's own evidence and outlives every run.
 *
 * Host-agnostic: the predicate is injected; this module walks the directory
 * tree with node:fs only.
 */

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface ReapArtifactOrphansDeps {
  /** True when a ticket with this numeric id still exists. */
  ticketExists: (ticketId: number) => boolean;
}

export interface ReapArtifactOrphansResult {
  removed: number[];
}

/**
 * The activation sweep: remove every `<artifactsRoot>/<ticketId>/` directory
 * whose ticket no longer exists. Per-dir errors are swallowed — a vanished
 * directory mid-sweep is a normal race with another window's delete, never a
 * failure of the whole pass.
 */
export function reapOrphanedArtifactDirs(
  artifactsRoot: string,
  deps: ReapArtifactOrphansDeps,
): ReapArtifactOrphansResult {
  const removed: number[] = [];
  let entries;
  try {
    entries = readdirSync(artifactsRoot, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const ticketId = Number(entry.name);
    if (deps.ticketExists(ticketId)) continue;
    try {
      rmSync(join(artifactsRoot, entry.name), { recursive: true, force: true });
      removed.push(ticketId);
    } catch {
      // A dir that vanishes mid-sweep is a race with a delete in another
      // window, not a failure of this pass.
    }
  }
  return { removed };
}

/** One line naming a ticket dir this sweep removed, for the output channel. */
export function describeArtifactReap(ticketId: number): string {
  return `karst: removed artifact console-log dir for deleted ticket ${ticketId}`;
}
