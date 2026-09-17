import type { Store } from '../store/db.js';
import type { PortAllocator } from './allocator.js';

/**
 * Re-resolving an existing spin with fresh ports would repoint one service while
 * its peers keep the old URL in their env — the exact silent-miswiring failure
 * `resolve.ts` protects against. This allocator returns the ticket's
 * already-recorded `port_allocations` rows instead, so replaying `resolve` over
 * an existing spin cannot move a single port.
 */
export class MissingAllocationError extends Error {
  readonly repo: string;
  readonly slots: string[];

  constructor(repo: string, slots: string[]) {
    super(`no recorded port allocation for "${repo}" (slot(s): ${slots.join(', ')}) — re-spin the ticket`);
    this.name = 'MissingAllocationError';
    this.repo = repo;
    this.slots = slots;
  }
}

export function makeRecordedPortAllocator(store: Store, ticketId: number): PortAllocator {
  const select = store.db.prepare(
    'SELECT port_name AS portName, port FROM port_allocations WHERE ticket_id = ? AND repo = ?',
  );

  return {
    /**
     * `ticketId` is kept for call-site symmetry with `makePortAllocator`; since
     * `resolve` always passes the ticket id explicitly, this uses its argument.
     */
    allocate: (allocTicketId, repo, slots, _override) => {
      if (slots.length === 0) return {};
      const rows = select.all(allocTicketId, repo) as { portName: string; port: number }[];
      const byName = new Map(rows.map((r) => [r.portName, r.port]));
      const missing = slots.filter((s) => !byName.has(s));
      if (missing.length > 0) throw new MissingAllocationError(repo, missing);
      return Object.fromEntries(slots.map((s) => [s, byName.get(s)!]));
    },
    release: () => {
      throw new Error('makeRecordedPortAllocator: release() is not supported — this allocator never owns allocations');
    },
  };
}
