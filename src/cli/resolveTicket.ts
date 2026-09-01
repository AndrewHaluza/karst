import type { Store } from '../store/db.js';
import { findTicketById, getTicketByKey, type Ticket } from '../store/tickets.js';
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
 * A KEY falls back to an unscoped lookup when the scoped one finds nothing: the
 * manifest may name a project with no row yet, or the ticket may predate scoping
 * and still be unadopted. Failing to resolve a ticket the user can plainly see
 * is worse than the rare ambiguity the fallback re-admits. The numeric ROW ID
 * form gets no such fallback — see below.
 */
export function resolveTicketByKey(
  store: Store,
  key: string,
  projectSlug: string | undefined,
): Ticket | undefined {
  const projectId = projectSlug ? getProjectBySlug(store, projectSlug)?.id : undefined;
  const scoped =
    projectId !== undefined ? getTicketByKey(store, key, { projectId }) : undefined;
  const byKey = scoped ?? getTicketByKey(store, key);
  if (byKey) return byKey;
  // The environment hands agent sessions `KARST_TICKET_ID` (a row id) while
  // every verb takes a KEY, so a bare number is accepted as an id — but only
  // after both key lookups miss, so a ticket whose key IS that number always
  // wins. Only the canonical decimal spelling `KARST_TICKET_ID` can carry is
  // accepted, so `01` never aliases row 1.
  if (!/^[1-9][0-9]*$/.test(key)) return undefined;
  const id = Number(key);
  // No unscoped fallback here: row ids are dense and global, so a bare number
  // hits SOME project's ticket almost always. Resolving it would advance the
  // wrong board and leak another project's context — the very thing
  // `--manifest` scoping exists to prevent. Keys may fall back (they are
  // sparse and project-prefixed); ids may not.
  if (projectId !== undefined) return findTicketById(store, id, { projectId });
  return findTicketById(store, id);
}
