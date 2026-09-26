import type { Store } from './db.js';
import { runImmediateTransaction } from './transactions.js';

/**
 * The scope key that applies to EVERY service of the ticket.
 *
 * Not a repository name — `*` cannot be a manifest key, so a shared entry can
 * never collide with a per-service one. It is applied first and a per-service
 * entry overrides it, which is the reading the dashboard's two sections show.
 */
export const ALL_SERVICES = '*';

/**
 * Per-ticket env overrides: scope (manifest repository NAME, or `*`) → env map.
 *
 * These NEVER touch a repository's own `.env` on disk. They are merged into the
 * spawn env of the ticket's hot services only (`runtime/env.ts`), so a value the
 * origin `.env` already declares is overridden and one it does not is added —
 * for this ticket's processes, for as long as they run.
 */
export type TicketEnvOverrides = Record<string, Record<string, string>>;

/**
 * A POSIX-ish env identifier. Anything else is refused rather than stored: a
 * key with a space or a `-` in it cannot be exported to a child process by any
 * shell, so accepting one would only produce a variable the service never sees.
 */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * Keys trimmed, invalid ones dropped, values coerced to string. Order preserved;
 * a later duplicate of the same trimmed key wins.
 */
function normalizeEntries(entries: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(entries)) {
    const key = rawKey.trim();
    if (!isValidEnvKey(key)) continue;
    out[key] = typeof rawValue === 'string' ? rawValue : '';
  }
  return out;
}

/**
 * Parse the stored JSON, tolerating bad data — the same house convention as
 * `parseDisabled` in `ticketGates.ts`. A corrupted column must degrade to "no
 * overrides" (the service runs on its own `.env`, exactly as before this
 * feature) rather than take the spin or the dashboard down.
 */
function parseOverrides(raw: string | null): TicketEnvOverrides {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: TicketEnvOverrides = {};
    for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entries = normalizeEntries(value as Record<string, unknown>);
      if (Object.keys(entries).length > 0) out[scope] = entries;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The flat env one service sees: the all-services scope first, the service's own
 * scope over it. A service that names a key the shared scope also names wins —
 * the specific statement beats the general one, which is the only reading that
 * makes a shared default useful.
 */
export function envOverridesForService(
  overrides: TicketEnvOverrides,
  service: string,
): Record<string, string> {
  return { ...(overrides[ALL_SERVICES] ?? {}), ...(overrides[service] ?? {}) };
}

/** What this ticket overrides, per scope. Never throws; an unknown id reads `{}`. */
export function getEnvOverrides(store: Store, ticketId: number): TicketEnvOverrides {
  const row = store.db
    .prepare('SELECT env_overrides FROM tickets WHERE id = ?')
    .get(ticketId) as { env_overrides: string | null } | undefined;
  return row ? parseOverrides(row.env_overrides) : {};
}

/**
 * Replace ONE scope's map, leaving every other scope's exactly as it was —
 * scoped like `setDisabledGates`, and for the same reason: a whole-object write
 * from a view that loaded before another service was edited would silently
 * revert it. The current value is re-read here rather than trusted from the
 * caller.
 *
 * The re-read and the write run in ONE `BEGIN IMMEDIATE` transaction. The
 * per-scope merge only holds if no other window commits between the read and
 * the write; without the transaction two IDE windows editing different scopes
 * of the same ticket can lose each other's change (last writer reverts the
 * other's scope). The transaction makes the read-modify-write atomic across
 * processes, not just within one (P2-03). An empty map removes the scope.
 */
export function setServiceEnvOverrides(
  store: Store,
  ticketId: number,
  scope: string,
  entries: Record<string, string>,
): void {
  const normalized = normalizeEntries(entries);
  runImmediateTransaction(store.db, () => {
    const current = getEnvOverrides(store, ticketId);
    const next: TicketEnvOverrides = { ...current };
    if (Object.keys(normalized).length === 0) delete next[scope];
    else next[scope] = normalized;
    // NULL rather than `{}` when nothing is overridden: the column's absent state
    // and its empty state mean the same thing, and storing one canonical form
    // keeps every reader from having to know both.
    const empty = Object.keys(next).length === 0;
    store.db
      .prepare("UPDATE tickets SET env_overrides = ?, updated_at = datetime('now') WHERE id = ?")
      .run(empty ? null : JSON.stringify(next), ticketId);
  });
}
