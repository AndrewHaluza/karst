import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { createWorktree, type WorktreeRecord } from '../../runtime/worktree.js';
import { getTicket } from '../../store/tickets.js';
import { worktreeSlug } from '../../runtime/slug.js';

/**
 * Scope stage (§T4.2, §17.1). The user selects which repos go *hot* for a
 * ticket. Two responsibilities, split so the pure part stays testable:
 *
 *  - `scopeTicket` — pure preview: validate the hot set against the manifest and
 *    surface warnings. A hot service that runs DB migrations is flagged "not
 *    first-class under shared-DB" (MVP shares one DB; a migration ticket can
 *    reshape it under the others). The signal is the author-declared
 *    `hasMigrations` manifest field — deterministic, not a filesystem heuristic.
 *  - `confirmScope` — the side-effecting confirm: create worktrees *lazily*, one
 *    per hot repo, off the baseline branch. Nothing is created until confirm.
 */

export interface ScopeResult {
  warnings: string[];
}

/** Validate the hot set and collect warnings. Pure — no store, no git. */
export function scopeTicket(manifest: Manifest, hot: string[]): ScopeResult {
  const warnings: string[] = [];
  for (const name of hot) {
    const svc = manifest.services[name];
    if (!svc) {
      throw new Error(`unknown service '${name}' in hot set (not in manifest)`);
    }
    if (svc.hasMigrations) {
      warnings.push(
        `Service '${name}' runs migrations — not first-class under shared-DB. ` +
          `Its schema changes affect every other ticket sharing the database; review before spinning.`,
      );
    }
  }
  return { warnings };
}

/**
 * Confirm the scope: create one worktree per hot repo off `baselineBranch`.
 * The slug ties the branch/worktree to the ticket. Deduplicates repo paths so a
 * ticket scoping two services in one repo makes a single worktree.
 */
export function confirmScope(
  store: Store,
  manifest: Manifest,
  ticketId: number,
  hot: string[],
): WorktreeRecord[] {
  const seen = new Set<string>();
  const records: WorktreeRecord[] = [];
  const slug = worktreeSlug(getTicket(store, ticketId));

  for (const name of hot) {
    const svc = manifest.services[name];
    if (!svc) {
      throw new Error(`unknown service '${name}' in hot set (not in manifest)`);
    }
    if (seen.has(svc.repoPath)) continue;
    seen.add(svc.repoPath);

    records.push(
      createWorktree(store, {
        ticketId,
        repoPath: svc.repoPath,
        slug,
        baseRef: manifest.baselineBranch,
      }),
    );
  }

  return records;
}
