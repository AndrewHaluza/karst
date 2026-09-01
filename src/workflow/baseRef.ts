import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { resolveBaselineBranch, resolveBaselineBranchForPath } from '../manifest/baselineBranch.js';
import { getTicket } from '../store/tickets.js';

/**
 * The ONE place a ticket's base branch is decided.
 *
 * Order is load-bearing:
 *   1. `worktrees.base_ref` — the branch was ALREADY cut from it, so it is the
 *      only answer that matches what git actually did. Changing the manifest
 *      later must not silently retarget an existing PR.
 *   2. the ticket's own pre-spin override (`tickets.base_refs`, keyed by
 *      manifest repository NAME).
 *   3. the manifest default (`repositories.<name>.baselineBranch ?? baselineBranch`).
 *
 * Every value here is a PLAIN branch name; consumers prepend `origin/`.
 */

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function resolvePlannedBaseRef(
  ticket: { baseRefs?: Record<string, string> },
  manifest: Manifest,
  repoName: string,
): string {
  const override = nonBlank(ticket.baseRefs?.[repoName]);
  if (override) return override;
  const repository = manifest.repositories[repoName];
  return repository ? resolveBaselineBranch(manifest, repository) : manifest.baselineBranch;
}

/** `getTicket` throws on a missing row; a base-branch lookup must not. */
function ticketOrNull(store: Store, ticketId: number): { baseRefs?: Record<string, string> } | null {
  try {
    return getTicket(store, ticketId);
  } catch {
    return null;
  }
}

export function resolveTicketBaseRef(
  store: Store,
  ticketId: number,
  repoPath: string,
  manifest: Manifest,
): string {
  const row = store.db
    .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
    .get(ticketId, repoPath) as { base_ref: string | null } | undefined;
  const stored = nonBlank(row?.base_ref ?? undefined);
  if (stored) return stored;

  // `getTicket` THROWS on a missing row, and this resolver runs on gate paths
  // where a ticket may legitimately not exist (a bare-cwd run, a fixture, a row
  // archived mid-run). Resolving a base branch is never the place to fail a
  // gate: no ticket simply means no override, and the manifest answers.
  const ticket = ticketOrNull(store, ticketId);
  if (ticket) {
    for (const [name, repository] of Object.entries(manifest.repositories)) {
      if (repository.repoPath !== repoPath) continue;
      const override = nonBlank(ticket.baseRefs?.[name]);
      if (override) return override;
    }
  }
  return resolveBaselineBranchForPath(manifest, repoPath);
}

/**
 * Manifest entries may share a `repoPath` — one deduped worktree, which cannot
 * have two branch points. The manifest enforces this for its own defaults
 * (`assertSharedRepoBaselineBranches`); a per-ticket override can break it the
 * same way, so it is checked before the override is stored.
 */
export function assertSharedRepoBaseOverrides(
  manifest: Manifest,
  baseRefs: Record<string, string>,
): void {
  const seen = new Map<string, { name: string; branch: string }>();
  for (const [name, repository] of Object.entries(manifest.repositories)) {
    const branch = resolvePlannedBaseRef({ baseRefs }, manifest, name);
    const prior = seen.get(repository.repoPath);
    if (prior && prior.branch !== branch) {
      throw new Error(
        `repositories "${prior.name}" and "${name}" share repoPath "${repository.repoPath}" ` +
          `but were given different base branches ("${prior.branch}" and "${branch}")`,
      );
    }
    seen.set(repository.repoPath, { name, branch });
  }
}
