import type { Store } from './db.js';

/** The DDL schema.sql mirrors for a fresh DB (the v93 migration step execs it). */
export const FIX_ROUND_HEADS_DDL = `
CREATE TABLE IF NOT EXISTS fix_round_heads (
  recovery_round_id INTEGER NOT NULL REFERENCES recovery_rounds(id) ON DELETE CASCADE,
  worktree_path     TEXT NOT NULL,
  head_sha          TEXT NOT NULL,
  PRIMARY KEY (recovery_round_id, worktree_path)
);
`;

export interface FixRoundHead {
  worktreePath: string;
  headSha: string;
}

/** Record the HEADs seen when the round opened. The first record wins: a re-nudge keeps the original. */
export function recordFixRoundHeads(store: Store, roundId: number, heads: readonly FixRoundHead[]): void {
  const insert = store.db.prepare(
    'INSERT OR IGNORE INTO fix_round_heads (recovery_round_id, worktree_path, head_sha) VALUES (?, ?, ?)',
  );
  store.db.transaction(() => {
    for (const h of heads) insert.run(roundId, h.worktreePath, h.headSha);
  })();
}

export function listFixRoundHeads(store: Store, roundId: number): FixRoundHead[] {
  const rows = store.db
    .prepare('SELECT worktree_path, head_sha FROM fix_round_heads WHERE recovery_round_id = ?')
    .all(roundId) as { worktree_path: string; head_sha: string }[];
  return rows.map((r) => ({ worktreePath: r.worktree_path, headSha: r.head_sha }));
}

/** Record the manifest file and its content hash for the round. The first record wins, like the HEADs. */
export function recordFixRoundManifest(store: Store, roundId: number, path: string, sha: string): void {
  store.db
    .prepare('UPDATE recovery_rounds SET manifest_path = ?, manifest_sha = ? WHERE id = ? AND manifest_sha IS NULL')
    .run(path, sha, roundId);
}

/** The manifest recorded for the round, or null when none was recorded. */
export function fixRoundManifest(store: Store, roundId: number): { path: string; sha: string } | null {
  const r = store.db
    .prepare('SELECT manifest_path, manifest_sha FROM recovery_rounds WHERE id = ?')
    .get(roundId) as { manifest_path: string | null; manifest_sha: string | null } | undefined;
  return r?.manifest_path && r.manifest_sha ? { path: r.manifest_path, sha: r.manifest_sha } : null;
}

/** Record the HEAD the fix round ended on. Last write wins: the marker may be retried after another commit. */
export function recordFixCommitSha(store: Store, roundId: number, sha: string): void {
  store.db.prepare('UPDATE recovery_rounds SET fix_commit_sha = ? WHERE id = ?').run(sha, roundId);
}
