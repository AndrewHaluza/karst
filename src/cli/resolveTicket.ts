import type { Store } from '../store/db.js';
import { findTicketById, getTicketsByKey, type Ticket } from '../store/tickets.js';
import { getProjectBySlug } from '../store/projects.js';
import { formatId, parseId } from '../model/entityId.js';

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
 *
 * A key can be held by more than one row even within one project (a reused or
 * re-created key). Resolution then prefers the NON-ARCHIVED row: an archived row
 * is the stale namesake, and picking it silently hid the live ticket (NDL-95).
 * If two LIVE rows still collide the key genuinely is ambiguous, so this refuses
 * with an explicit error naming the candidates rather than silently picking one.
 */
export function resolveTicketByKey(
  store: Store,
  key: string,
  projectSlug: string | undefined,
): Ticket | undefined {
  const projectId = projectSlug ? getProjectBySlug(store, projectSlug)?.id : undefined;
  const scoped =
    projectId !== undefined ? getTicketsByKey(store, key, { projectId }) : [];
  const matches = scoped.length > 0 ? scoped : getTicketsByKey(store, key);
  const byKey = selectNamesake(matches, key);
  if (byKey) return byKey;
  // The environment hands agent sessions `KARST_TICKET_ID` (a row id) while
  // every verb takes a KEY, so a bare number is accepted as an id — but only
  // after both key lookups miss, so a ticket whose key IS that number always
  // wins. Only the canonical decimal spelling `KARST_TICKET_ID` can carry is
  // accepted, so `01` never aliases row 1.
  const id = ticketIdFromText(key);
  if (id === undefined) return undefined;
  // No unscoped fallback here: row ids are dense and global, so a bare number
  // hits SOME project's ticket almost always. Resolving it would advance the
  // wrong board and leak another project's context — the very thing
  // `--manifest` scoping exists to prevent. Keys may fall back (they are
  // sparse and project-prefixed); ids may not.
  if (projectId !== undefined) return findTicketById(store, id, { projectId });
  return findTicketById(store, id);
}

/**
 * The ticket row id a CLI argument spells (`T5`, `5`, `T5 · KEY`), or undefined
 * for junk. A well-formed id of ANOTHER kind (`D5`, `P3`) throws parseId's
 * wrong-kind error, which names the expected `T<n>`.
 */
export function ticketIdFromText(text: string): number | undefined {
  try {
    return parseId(text, 'ticket').n;
  } catch (err) {
    let otherKind = false;
    try {
      otherKind = parseId(text).kind !== 'ticket';
    } catch {
      // not an id form at all — the caller reports "no ticket found"
    }
    if (otherKind) throw err;
    return undefined;
  }
}

/**
 * Pick the one ticket a key names out of its namesakes (already ordered
 * active-first, id-ascending). A live row outranks an archived one; two live
 * rows are ambiguous and refused. Returns undefined only for an empty set.
 */
function selectNamesake(matches: Ticket[], key: string): Ticket | undefined {
  if (matches.length === 0) return undefined;
  const live = matches.filter((t) => t.archivedAt === null);
  const candidates = live.length > 0 ? live : matches;
  if (candidates.length > 1) {
    const ids = candidates.map((t) => formatId('ticket', t.id)).join(', ');
    const kind = live.length > 0 ? 'non-archived' : 'archived';
    throw new Error(
      `ambiguous ticket key '${key}': ${candidates.length} ${kind} tickets match (${ids}) — ` +
        `pass --manifest to scope by project, or use a numeric id`,
    );
  }
  return candidates[0];
}
