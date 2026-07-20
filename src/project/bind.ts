import type { Store } from '../store/db.js';
import { upsertProject, adoptUnassignedTickets, listProjects, type Project } from '../store/projects.js';

/**
 * Binding a window to its project (§ projects / multi-window) — the activation
 * step that gives every later query a `projectId` to scope by.
 *
 * Host-agnostic: the caller supplies the resolved slug and the persistence for
 * the one-shot adoption flag (VS Code's `globalState`, which is shared across
 * windows — exactly the scope this flag needs).
 */

/** A persisted latch: "the legacy-ticket adoption has already run on this install". */
export interface OnceFlag {
  done(): boolean;
  markDone(): void;
}

export interface BindResult {
  project: Project;
  /** How many pre-v6 tickets this bind claimed. 0 on every bind after the first. */
  adopted: number;
}

/**
 * Register this window's project and, once per install, adopt the tickets that
 * predate project scoping.
 *
 * Adoption is guarded twice over, because claiming another project's tickets is
 * not something the user can easily undo:
 *  - the `once` flag, so it is a one-shot rather than something that fires on
 *    every activation; and
 *  - "we are the only project", so a *second* project's window opening first
 *    after the upgrade can't sweep up the original project's board. In that case
 *    the legacy tickets stay unassigned and the user reassigns deliberately.
 *
 * The flag is burned either way: adoption is a migration moment, not a retry
 * loop that keeps waiting for a chance to fire.
 */
export function bindProject(
  store: Store,
  input: { slug: string; name?: string | null; rootPath?: string | null },
  once: OnceFlag,
): BindResult {
  const project = upsertProject(store, input);

  if (once.done()) return { project, adopted: 0 };

  const soleProject = listProjects(store).length === 1;
  const adopted = soleProject ? adoptUnassignedTickets(store, project.id) : 0;
  once.markDone();

  return { project, adopted };
}
