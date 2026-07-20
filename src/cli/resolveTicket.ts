import type { Store } from '../store/db.js';
import { getTicketByKey, type Ticket } from '../store/tickets.js';
import { getProjectBySlug } from '../store/projects.js';

/**
 * Resolve a ticket key the way every CLI subcommand must (§ projects /
 * multi-window).
 *
 * Since tickets are scoped to a project, two projects may legitimately track the
 * same key — and the CLI is handed a bare key by whichever agent session invoked
 * it. The manifest it was pointed at names the project, so that is the
 * disambiguator; `--manifest` is what makes a stage marker land on the right
 * board.
 *
 * Falls back to an unscoped lookup when the scoped one finds nothing: the
 * manifest may name a project with no row yet, or the ticket may predate scoping
 * and still be unadopted. Failing to resolve a ticket the user can plainly see
 * is worse than the rare ambiguity the fallback re-admits.
 */
export function resolveTicketByKey(
  store: Store,
  key: string,
  projectSlug: string | undefined,
): Ticket | undefined {
  const projectId = projectSlug ? getProjectBySlug(store, projectSlug)?.id : undefined;
  const scoped =
    projectId !== undefined ? getTicketByKey(store, key, { projectId }) : undefined;
  return scoped ?? getTicketByKey(store, key);
}
