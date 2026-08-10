import type { Store } from '../store/db.js';

/**
 * Hands out contiguous alt ports from the manifest's portRange, persisted and
 * unique (§7.2 step 2). The DB's UNIQUE(port) constraint is the ultimate
 * correctness guard; this logic finds the lowest free contiguous block.
 */
export interface PortAllocator {
  /** Allocate one contiguous port per slot for a ticket's service. */
  allocate(
    ticketId: number,
    repo: string,
    slots: string[],
    range?: [number, number],
  ): Record<string, number>;
  /** Free every port held by a ticket (teardown). */
  release(ticketId: number): void;
}

export class PortRangeExhaustedError extends Error {
  constructor(range: [number, number], need: number, repo?: string) {
    const who = repo === undefined ? '' : ` for service "${repo}"`;
    super(
      `no free contiguous block of ${need} port(s) in range [${range[0]}, ${range[1]}]${who}`,
    );
    this.name = 'PortRangeExhaustedError';
  }
}

/** Lowest start of a free contiguous run of length `need`, or null if none. */
function findContiguous(
  used: Set<number>,
  [min, max]: [number, number],
  need: number,
): number | null {
  for (let start = min; start + need - 1 <= max; start++) {
    let ok = true;
    for (let off = 0; off < need; off++) {
      if (used.has(start + off)) {
        ok = false;
        // jump past the occupied port — nothing before it+1 can start a run
        start += off;
        break;
      }
    }
    if (ok) return start;
  }
  return null;
}

/**
 * A non-persisting allocator for previews / dry runs (§7.4). Same contiguous
 * lowest-free logic, but state lives only in memory and never touches the store.
 * `release` is a no-op (nothing to persist).
 */
export function makeDryRunAllocator(range: [number, number]): PortAllocator {
  const used = new Set<number>();
  return {
    allocate(_ticketId, repo, slots, override) {
      if (slots.length === 0) return {};
      const window = override ?? range;
      const start = findContiguous(used, window, slots.length);
      if (start === null) throw new PortRangeExhaustedError(window, slots.length, repo);
      const out: Record<string, number> = {};
      slots.forEach((slot, i) => {
        const port = start + i;
        used.add(port);
        out[slot] = port;
      });
      return out;
    },
    release() {
      /* no-op: dry run holds no persistent allocations */
    },
  };
}

export function makePortAllocator(store: Store, range: [number, number]): PortAllocator {
  const selectUsed = store.db.prepare('SELECT port FROM port_allocations');
  const insert = store.db.prepare(
    'INSERT INTO port_allocations (ticket_id, repo, port_name, port) VALUES (?, ?, ?, ?)',
  );
  const deleteByTicket = store.db.prepare('DELETE FROM port_allocations WHERE ticket_id = ?');

  function currentUsed(): Set<number> {
    return new Set(selectUsed.all().map((r) => (r as { port: number }).port));
  }

  const allocate = store.db.transaction(
    (
      ticketId: number,
      repo: string,
      slots: string[],
      override?: [number, number],
    ): Record<string, number> => {
      if (slots.length === 0) return {};
      const window = override ?? range;
      const used = currentUsed();
      const start = findContiguous(used, window, slots.length);
      if (start === null) throw new PortRangeExhaustedError(window, slots.length, repo);

      const out: Record<string, number> = {};
      slots.forEach((slot, i) => {
        const port = start + i;
        insert.run(ticketId, repo, slot, port); // UNIQUE(port) enforces correctness
        out[slot] = port;
      });
      return out;
    },
  );

  return {
    allocate: (ticketId, service, slots, override) => allocate(ticketId, service, slots, override),
    release: (ticketId) => {
      deleteByTicket.run(ticketId);
    },
  };
}
