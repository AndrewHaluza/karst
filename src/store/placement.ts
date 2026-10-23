import type { Store } from './db.js';
import type { AgentProvider } from '../manifest/types.js';

/** Where a ticket's session runs (arch:AC-32). `sandboxName` is set only for a sandbox backend; `reason` only for a host fallback. */
export interface TicketPlacement {
  readonly backend: 'host' | 'sbx' | 'docker';
  readonly core: string | null;
  readonly sandboxName: string | null;
  readonly reason: string | null;
}

interface PlacementRow {
  placement_backend: string | null;
  placement_core: string | null;
  placement_sandbox: string | null;
  placement_reason: string | null;
}

function isBackend(v: string | null): v is TicketPlacement['backend'] {
  return v === 'host' || v === 'sbx' || v === 'docker';
}

/** The recorded placement, or null when none was ever recorded (legacy row before the backfill). */
export function getPlacement(store: Store, ticketId: number): TicketPlacement | null {
  const row = store.db
    .prepare('SELECT placement_backend, placement_core, placement_sandbox, placement_reason FROM tickets WHERE id = ?')
    .get(ticketId) as PlacementRow | undefined;
  if (!row || !isBackend(row.placement_backend)) return null;
  return { backend: row.placement_backend, core: row.placement_core, sandboxName: row.placement_sandbox, reason: row.placement_reason };
}

/**
 * Single writer of placement. Written in one transaction with `session_provider`
 * so the core that minted the session id and the placement never disagree.
 * Callers hold the ticket (arch:AC-37 `controls`).
 */
export function recordPlacement(store: Store, ticketId: number, placement: TicketPlacement, sessionProvider: AgentProvider | null): void {
  store.db.transaction(() => {
    store.db
      .prepare('UPDATE tickets SET placement_backend = ?, placement_core = ?, placement_sandbox = ?, placement_reason = ?, session_provider = ? WHERE id = ?')
      .run(placement.backend, placement.core, placement.sandboxName, placement.reason, sessionProvider, ticketId);
  })();
}

/** Back to "not recorded" (e.g. a ticket whose sandbox was removed and has no session yet). */
export function clearPlacement(store: Store, ticketId: number): void {
  store.db
    .prepare('UPDATE tickets SET placement_backend = NULL, placement_core = NULL, placement_sandbox = NULL, placement_reason = NULL WHERE id = ?')
    .run(ticketId);
}

/** The one line `karst context` and the composed instructions state; null when unrecorded. */
export function placementLine(p: TicketPlacement | null): string | null {
  if (!p) return null;
  if (p.backend === 'host') return p.reason ? `Runs on: host (${p.reason})` : 'Runs on: host';
  return `Runs in: ${p.backend} sandbox ${p.sandboxName ?? '(unnamed)'} — commit only, no push, host syncs`;
}

export interface ListedSandbox {
  readonly ticketId: number;
  readonly runner: 'sbx' | 'docker';
  readonly core: string;
  readonly name: string;
}

/**
 * One-time backfill of tickets with no recorded placement, from a clean runner listing:
 * a listed sandbox gives backend+core+name, anything else is host. Atomic per row
 * (`IS NULL`), so two windows starting together cannot overwrite each other. `projectId` scopes it to the tickets whose sandboxes the listing covers. Returns rows written.
 */
export function backfillPlacement(store: Store, listed: readonly ListedSandbox[], projectId?: number): number {
  const rows = store.db.prepare('SELECT id, session_provider FROM tickets WHERE placement_backend IS NULL AND (? IS NULL OR project_id = ?)').all(projectId ?? null, projectId ?? null) as { id: number; session_provider: string | null }[];
  const set = store.db.prepare('UPDATE tickets SET placement_backend = ?, placement_core = ?, placement_sandbox = ?, placement_reason = ? WHERE id = ? AND placement_backend IS NULL');
  let written = 0;
  store.db.transaction(() => {
    for (const r of rows) {
      const box = listed.find((s) => s.ticketId === r.id);
      const res = box
        ? set.run(box.runner, box.core, box.name, null, r.id)
        : set.run('host', r.session_provider, null, 'backfill: no sandbox', r.id);
      written += res.changes;
    }
  })();
  return written;
}
