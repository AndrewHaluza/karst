import type { Store } from './db.js';

/**
 * One runtime debug line captured for a ticket.
 *
 * `ticket_logs` is the per-ticket debug trail the dashboard's Inside component
 * reads back so a human can trace what a specific ticket's stages did. It is a
 * mirror of the debug lines the driver run emitted (under the manifest's
 * `debug` flag), not a new log source: the line is already sanitized/redacted
 * by the logging pipeline before it is captured here.
 */
export interface TicketLog {
  id: number;
  ticketId: number;
  /** debug — the only level captured today. */
  level: 'debug';
  /** The line's origin prefix, e.g. `[driver]`, `[gate]`, `[agent:claude]`. */
  module: string;
  /** The redacted debug line. */
  message: string;
  /** ISO-8601. */
  recordedAt: string;
}

export interface TicketLogInput {
  ticketId: number;
  level?: 'debug';
  module: string;
  message: string;
  recordedAt: string;
}

interface TicketLogRow {
  id: number;
  ticket_id: number;
  level: string;
  module: string;
  message: string;
  recorded_at: string;
}

function rowToTicketLog(r: TicketLogRow): TicketLog {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    level: r.level as 'debug',
    module: r.module,
    message: r.message,
    recordedAt: r.recorded_at,
  };
}

/**
 * Cap on retained debug rows per ticket. Debug mode can be chatty (a long UAT
 * over many targets emits a line per decision), so the writer prunes a ticket's
 * oldest rows once it exceeds this — the trail stays bounded without the
 * dashboard ever rendering a wall of history.
 */
export const TICKET_LOG_RETENTION = 200;

/**
 * Append one debug line to a ticket's trail, pruning the ticket's oldest rows
 * once it exceeds `TICKET_LOG_RETENTION`. Pruning happens in the same
 * transaction as the insert, so a burst cannot grow the table unbounded.
 *
 * Opens no transaction of its own — callers (the host driver seam) write from
 * inside whatever they are doing; the prune is a DELETE the caller's
 * transaction would otherwise not include, so it is folded in here.
 */
export function appendTicketLog(store: Store, log: TicketLogInput): void {
  const apply = store.db.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO ticket_logs (ticket_id, level, module, message, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(log.ticketId, log.level ?? 'debug', log.module, log.message, log.recordedAt);
    store.db
      .prepare(
        `DELETE FROM ticket_logs
          WHERE ticket_id = ? AND id <= (
            SELECT id FROM ticket_logs
             WHERE ticket_id = ?
             ORDER BY id DESC
             LIMIT 1 OFFSET ${TICKET_LOG_RETENTION}
          )`,
      )
      .run(log.ticketId, log.ticketId);
  });
  apply();
}

/**
 * The line's module prefix — the leading `[bracketed]` tag a debug line
 * carries (`[driver]`, `[gate]`, `[agent:claude]`, `[runtime]`, `[merge]`,
 * `[process]`, …). Falls back to `[ticket]` when a line has no leading tag, so
 * the trail still groups every line under a stable bucket.
 */
export function debugModule(message: string): string {
  const match = /^\s*\[([^\]]+)\]/.exec(message);
  return match ? `[${match[1]}]` : '[ticket]';
}

/**
 * The most recent debug lines for a ticket, oldest-first within the window.
 *
 * Returns at most `limit` rows (default: the retention cap). The dashboard's
 * Inside component reads this synchronously from the store — the table exists
 * precisely so `buildDashboardState` (a synchronous, store-only builder) can
 * render a ticket's trail without touching the extension-host's live buffer.
 */
export function listTicketLogs(store: Store, ticketId: number, limit = TICKET_LOG_RETENTION): TicketLog[] {
  const rows = store.db
    .prepare(
      `SELECT id, ticket_id, level, module, message, recorded_at
         FROM (
           SELECT * FROM ticket_logs
            WHERE ticket_id = ?
            ORDER BY id DESC
            LIMIT ?
         )
         ORDER BY id ASC`,
    )
    .all(ticketId, limit) as TicketLogRow[];
  return rows.map(rowToTicketLog);
}