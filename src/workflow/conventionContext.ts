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
 * The artifact conventions that apply to ONE repository (ship time).
 *
 * Each of the three template keys resolves INDEPENDENTLY: the repository's own
 * `conventions.<key>` wins, else the global `conventions.<key>`, else nothing
 * (the caller falls back to its built-in default — the ticket title, or the
 * default PR body). This is the same layering as a repository's `scope:`.
 *
 * `defaultType` and `branchName` are PROJECT-wide and are carried through from
 * the global block untouched: `{type}` is chosen once for the ticket
 * (`resolveTicketType`) and a ticket has one branch name across every repository
 * (@arch:BRANCH-NAME). `repo` is the repository NAME (`resolveRepoName`), never
 * the worktree's local path.
 *
 * Undefined when neither layer configures anything, so ship's no-conventions
 * path stays byte-identical to before this feature.
 */
export function resolveRepoConventions(
  manifest: Manifest | undefined,
  repo: string,
): ArtifactConventions | undefined {
  const global = manifest?.conventions;
  const override = manifest?.repositories[repo]?.conventions;
  if (!global && !override) return undefined;
  // A repository key that is absent must not shadow the global one, so the
  // override is spread AFTER the global only for the keys it actually carries.
  return { ...global, ...override };
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
