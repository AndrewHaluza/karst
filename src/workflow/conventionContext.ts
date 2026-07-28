import type { ArtifactConventions, Manifest } from '../manifest/types.js';
import { DEFAULT_TICKET_TYPE } from '../store/ticketTypes.js';

/**
 * The two derived values a convention template can interpolate but nothing
 * stores directly: `{type}` and `{scope}`.
 *
 * Both are resolved HERE and nowhere else, so the branch name (rendered at scope
 * time) and the commit/PR artifacts (rendered at ship time) can never disagree
 * about what a ticket's type or a repository's scope is.
 */

/** Ticket's own type, else the project default, else `feat`. */
export function resolveTicketType(
  ticket: { type: string | null },
  conventions?: ArtifactConventions,
): string {
  return ticket.type ?? conventions?.defaultType ?? DEFAULT_TICKET_TYPE;
}

/**
 * A repository's conventional-commit scope: its explicit `scope:`, else its
 * manifest name — so `{scope}` is always renderable without the manifest having
 * to spell it out for every repository.
 */
export function resolveRepoScope(manifest: Manifest | undefined, repo: string): string {
  const scope = manifest?.repositories[repo]?.scope;
  return scope && scope.trim() !== '' ? scope : repo;
}
