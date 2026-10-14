import type { Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';

/** The `port_allocations.port_name` a reallocated HOST port is recorded under (`<slot>@host`). */
export function hostSlotName(slot: string): string {
  return `${slot}@host`;
}

/**
 * The one reallocation a sandbox publish conflict gets (arch:AC-32). Only the
 * HOST side moves: the service keeps its allocated port inside the sandbox, so
 * nothing in its env changes. The new port is recorded under `<slot>@host` so
 * the range never hands it out twice and it is released with the ticket.
 */
export function reallocateHostPort(
  store: Store,
  range: [number, number],
  ticketId: number,
  unitKey: string,
  slot: string,
  taken: number,
): number {
  const name = hostSlotName(slot);
  store.db.prepare('DELETE FROM port_allocations WHERE ticket_id = ? AND repo = ? AND port_name = ?').run(ticketId, unitKey, name);
  return makePortAllocator(store, range, { busy: new Set([taken]) }).allocate(ticketId, unitKey, [name])[name]!;
}
