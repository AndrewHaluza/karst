import type { Store } from './db.js';

/**
 * Keep-warm pins on shared (baseline) services (v89). A pin is keyed by the
 * manifest unit key, never by the `servers` row: `startHot` deletes and
 * reinserts that row on every start, so a row-keyed pin would vanish at the
 * first restart.
 *
 * Positional `?` binding only (driver-agnostic).
 */

/** Pin `repo` (idempotent — a second pin keeps the first `created_at`). */
export function pinBaseline(store: Store, repo: string): void {
  store.db
    .prepare("INSERT OR IGNORE INTO baseline_pins (repo, created_at) VALUES (?, datetime('now'))")
    .run(repo);
}

/** Drop the pin on `repo`; a no-op when it was not pinned. */
export function unpinBaseline(store: Store, repo: string): void {
  store.db.prepare('DELETE FROM baseline_pins WHERE repo = ?').run(repo);
}

/** Every pinned unit key. */
export function listPinnedBaselines(store: Store): Set<string> {
  const rows = store.db.prepare('SELECT repo FROM baseline_pins').all() as { repo: string }[];
  return new Set(rows.map((r) => r.repo));
}
