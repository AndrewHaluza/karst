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
 * to spell it out for every repository. `repo` is the repository NAME (see
 * `resolveRepoName`), never the worktree's local path.
 */
export function resolveRepoScope(manifest: Manifest | undefined, repo: string): string {
  const scope = manifest?.repositories[repo]?.scope;
  return scope && scope.trim() !== '' ? scope : repo;
}

/**
 * A repository's manifest NAME for the worktree's repo path — what `{repo}` (and
 * therefore `{scope}`'s fallback) renders. Worktrees are keyed by the absolute
 * repo path (`worktrees.repo`), while the manifest is keyed by entry name, so a
 * public artifact (commit subject, PR title, PR body) once shipped
 * "Repository: /Users/nd/…" and leaked the machine's directory layout. The
 * entry NAME is what the docs and the settings preview mean by `{repo}`.
 *
 * Several entries sharing a repoPath resolve to ONE worktree, so the first
 * declared entry answers. An absent manifest or an unmapped path falls back to
 * the raw path (the historical value).
 */
export function resolveRepoName(manifest: Manifest | undefined, repoPath: string): string {
  if (!manifest) return repoPath;
  const entry = Object.entries(manifest.repositories).find(([, def]) => def.repoPath === repoPath);
  return entry ? entry[0] : repoPath;
}
