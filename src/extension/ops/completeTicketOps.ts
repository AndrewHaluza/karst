import type { Manifest } from '../../manifest/types.js';

/**
 * A merge (or dismiss) just completed the ticket: with the setting on, its
 * terminals go with it. A disposal failure is logged, never surfaced — the
 * merge already landed.
 */
export function closeTerminalsOnTicketCompleted(
  manifest: () => Manifest | undefined,
  closeTerminals: (ticketId: number) => number,
  log: { info(m: string): void },
  logError: (m: string, e: unknown) => void,
  ticketId: number,
): void {
  if (manifest()?.closeDoneTerminalsWithTicket !== true) return;
  try {
    const closed = closeTerminals(ticketId);
    if (closed > 0) {
      log.info(`karst: closed ${closed} terminal(s) with completed ticket ${ticketId}`);
    }
  } catch (err) {
    logError('karst: closing terminals with completed ticket failed', err);
  }
}
