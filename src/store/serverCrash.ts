import type { Store } from './db.js';

/**
 * Mark a `running` server row as `failed` because its process is gone.
 *
 * The liveness sweep is the one caller: a crash is not a user Stop, so the
 * row never becomes `stopped` (@arch:SERVERS-PANEL). The pid becomes NULL to
 * keep the rule "a row that is not running has no pid" (`pruneDeadServers`).
 *
 * The guard `status = 'running' AND pid IS ?` stops two races: a user Stop
 * that already wrote `stopped`, and a restart that replaced the row's process
 * (`startHot` deletes and re-inserts the row). `IS` is null-safe, so a
 * container or sandbox row (pid NULL) matches with `pid` null.
 *
 * Returns true only when this call changed the row.
 */
export function markServerCrashed(
  store: Store,
  id: number,
  pid: number | null,
  reason: string,
): boolean {
  const info = store.db
    .prepare(
      "UPDATE servers SET status = 'failed', pid = NULL, last_error = ? WHERE id = ? AND status = 'running' AND pid IS ?",
    )
    .run(reason, id, pid);
  return info.changes === 1;
}
