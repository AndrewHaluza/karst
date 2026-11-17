import type { Store } from '../../store/db.js';
import type { Drain } from '../../runtime/drain.js';

/**
 * "Karst: Reload window when idle" (@arch:DRAIN-01). Set the drain flag so no new
 * stage, gate or headless-agent run starts, wait until no run of this host is
 * live, then reload. A cancel clears the flag. Host-agnostic: vscode arrives
 * through the injected seams.
 */
export const RELOAD_WHEN_IDLE_COMMAND = 'karst.reloadWhenIdle';
export const RELOAD_WHEN_IDLE_TITLE = 'Karst: Reload window when idle';
export const IDLE_POLL_MS = 2000;

/**
 * Live runs of THIS host: `process_runs` and `stage_runs` (every gate) whose
 * status is 'running' and whose pid is the host's, the `ship_runs` rows with
 * status 'running' (the ship saga writes a ship run, not a stage run), and the
 * `deliver_runs` rows with state 'running' (an auto-deliver runs its gates
 * outside any stage run). `extra` adds the tracked runs (`Drain.track`): host gate re-runs, which write no run row, and the auto-delivers. A tracked auto-delivery counts once: the rest arguments list its tickets, and their `deliver_runs` rows are skipped. A run of another window has another pid and is not counted.
 * Interactive impl/fix terminals are not counted: the pty host keeps them
 * across a reload (@arch:AC-15).
 */
export function countLiveRuns(store: Store, hostPid: number, extra = 0, ...trackedDeliverTickets: readonly number[]): number {
  return listLiveRuns(store, hostPid, extra, ...trackedDeliverTickets).length;
}

/** What a live run is: a stage process, a gate, a ship, an auto-deliver or a headless agent. */
export type LiveRunKind = 'stage' | 'gate' | 'ship' | 'deliver' | 'agent';

/** One live run. `ticketId` is null for a tracked run that names no ticket. */
export interface LiveRun {
  readonly ticketId: number | null;
  readonly kind: LiveRunKind;
}

/**
 * The live runs `countLiveRuns` counts, one entry per run (the length is the count: one source of truth, so the
 * dashboard banner and the progress notification agree). A `process_runs` row with a provider is an agent, one
 * without is a stage process; a `stage_runs` row is a gate. `extra` tracked runs: the first ones take the tracked
 * tickets (kind deliver), the rest name no ticket (kind gate: a host gate re-run).
 */
export function listLiveRuns(store: Store, hostPid: number, extra = 0, ...trackedDeliverTickets: readonly number[]): LiveRun[] {
  const rows = (sql: string, ...args: unknown[]): { ticket_id: number; provider?: string | null }[] =>
    store.db.prepare(sql).all(...args) as { ticket_id: number; provider?: string | null }[];
  const marks = trackedDeliverTickets.map(() => '?').join(', ');
  const runs: LiveRun[] = [
    ...rows("SELECT ticket_id, provider FROM process_runs WHERE status = 'running' AND pid = ?", hostPid).map(
      (r): LiveRun => ({ ticketId: r.ticket_id, kind: r.provider ? 'agent' : 'stage' }),
    ),
    ...rows("SELECT ticket_id FROM stage_runs WHERE status = 'running' AND pid = ?", hostPid).map((r): LiveRun => ({ ticketId: r.ticket_id, kind: 'gate' })),
    ...rows(`SELECT ticket_id FROM deliver_runs WHERE state = 'running' AND pid = ? AND ticket_id NOT IN (${marks})`, hostPid, ...trackedDeliverTickets).map(
      (r): LiveRun => ({ ticketId: r.ticket_id, kind: 'deliver' }),
    ),
    ...rows("SELECT ticket_id FROM ship_runs WHERE status = 'running' AND pid = ?", hostPid).map((r): LiveRun => ({ ticketId: r.ticket_id, kind: 'ship' })),
  ];
  for (let i = 0; i < extra; i++) {
    const ticketId = trackedDeliverTickets[i];
    runs.push(ticketId === undefined ? { ticketId: null, kind: 'gate' } : { ticketId, kind: 'deliver' });
  }
  return runs;
}

export const SHIP_DRAINING_MESSAGE = 'a reload is waiting for live runs, so ship does not start. Cancel the reload, or ship again after it.';

/** The error a refused ship start throws, so no caller reports a ship that did not run. */
export class ShipDrainingError extends Error {
  constructor() {
    super(SHIP_DRAINING_MESSAGE);
    this.name = 'ShipDrainingError';
  }
}

/**
 * A new ship start while the drain flag is set (@arch:DRAIN-01): writes one debug
 * line, holds the ticket so a cancel re-drives it, and throws `ShipDrainingError`.
 * A start inside a tracked live run is never refused.
 */
export function guardShipStart(drain: Drain, ticketId: number, debug: (message: string) => void): void {
  if (!drain.isDraining() || drain.insideRun()) return;
  drain.hold(ticketId);
  debug(`[ship] ticket ${ticketId} ship not started: draining`);
  throw new ShipDrainingError();
}

export interface ReloadWhenIdleDeps {
  readonly drain: Drain;
  readonly countLive: () => number;
  readonly reload: () => Promise<void>;
  /** Called with each new count; the host shows it. */
  readonly onCount: (live: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
  readonly log: (message: string) => void;
  /** Called with the tickets a start was refused for, after a cancel. */
  readonly onCancelled?: (held: readonly number[]) => void;
  readonly pollMs?: number;
}

export type ReloadWhenIdleResult = 'reloaded' | 'cancelled';

export async function reloadWhenIdle(deps: ReloadWhenIdleDeps): Promise<ReloadWhenIdleResult> {
  deps.drain.begin();
  deps.log('reload when idle: draining — no new stage, gate or agent run starts');
  let last = -1;
  for (;;) {
    if (deps.signal.aborted) {
      const held = deps.drain.cancel();
      deps.log(`reload when idle: cancelled — new runs may start again (${held.length} held)`);
      deps.onCancelled?.(held);
      return 'cancelled';
    }
    const live = deps.countLive();
    if (live !== last) {
      last = live;
      deps.onCount(live);
    }
    if (live === 0) {
      deps.log('reload when idle: no live run — reloading the window');
      try {
        await deps.reload();
      } catch (err) {
        deps.onCancelled?.(deps.drain.cancel());
        throw err;
      }
      return 'reloaded';
    }
    await deps.sleep(deps.pollMs ?? IDLE_POLL_MS);
  }
}
