import type { Store } from './db.js';

/**
 * The tickets that declared a dependency on a baseline service.
 *
 * Written by `runtime/baseline.ts` as each spin resolves its baseline deps, and
 * read here so an intentional baseline stop can say who it affects: a baseline
 * is a shared singleton, and stopping it takes the dependency out from under
 * every ticket in this list at once.
 *
 * Rows whose ticket has since been deleted are excluded by the join — a stale
 * ref must not inflate the count behind a prompt a human is reading.
 */
export function listBaselineDependents(store: Store, repo: string): number[] {
  return (
    store.db
      .prepare(
        `SELECT b.ticket_id AS ticketId FROM baseline_refs b
         JOIN tickets t ON t.id = b.ticket_id
         WHERE b.repo = ?
         ORDER BY b.ticket_id`,
      )
      .all(repo) as { ticketId: number }[]
  ).map((r) => r.ticketId);
}

/**
 * The same answer addressed by `servers.id`, for a caller that holds a row id
 * rather than a repository name. Returns `[]` for a row that is not a baseline
 * (`ticket_id IS NOT NULL`) and for a row that no longer exists.
 */
export function baselineDependentsFor(store: Store, serverId: number): number[] {
  const row = store.db
    .prepare('SELECT repo, ticket_id FROM servers WHERE id = ?')
    .get(serverId) as { repo: string; ticket_id: number | null } | undefined;
  if (!row || row.ticket_id !== null) return [];
  return listBaselineDependents(store, row.repo);
}
