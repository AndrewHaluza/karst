import type { Store } from '../../store/db.js';
import {
  claimWake,
  maxMessageId,
  pendingWakeEvents,
  unreadByRecipient,
} from '../../store/messageDelivery.js';
import type { MessageDelivery } from '../../workflow/messageDelivery.js';
import { parentWakeDecision } from '../../workflow/parentWake.js';

/**
 * Mailbox delivery sweep (plan Wave 3). Two jobs per tick, both in this
 * window's bound project:
 *
 * 1. Pointer: a recipient with unread rows newer than the last one this
 *    window delivered for gets ONE pointer line via `delivery` — at most one
 *    per `POINTER_INTERVAL_MS`; rows arriving inside the window coalesce into
 *    the next pointer's count. The watermark is in memory: after a reload a
 *    recipient with a backlog gets exactly one pointer on first sight.
 *    A `deferred` delivery (not live here, graph-owned) is retried next tick.
 * 2. Wake: an event row written after activation is decided once across all
 *    windows (`claimWake`); a `wake` decision opens the parent's session in
 *    the background. `retry` (awaiting-subtask park) leaves the row unclaimed.
 */

export const POINTER_INTERVAL_MS = 30_000;

export interface MessageDeliveryDeps {
  store: Store;
  projectId: () => number | undefined;
  delivery: MessageDelivery;
  isLive: (ticketId: number) => boolean;
  graphOwned: (ticketId: number) => boolean;
  /** Open the parent's session WITHOUT revealing it. */
  wake: (ticketId: number) => void;
  now: () => number;
  debug: (message: string) => void;
}

export interface SweepResult {
  delivered: number[];
  woke: number[];
}

export interface MessageDeliverySweep {
  sweep(): SweepResult;
  dispose(): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeMessageDeliverySweep(deps: MessageDeliveryDeps): MessageDeliverySweep {
  const watermark = new Map<number, number>();
  const lastPointerAt = new Map<number, number>();
  const eventBaseline = maxMessageId(deps.store);
  let running = false;
  let disposed = false;

  function deliverPointers(projectId: number, out: number[]): void {
    for (const r of unreadByRecipient(deps.store, projectId)) {
      if (disposed) return;
      const seen = watermark.get(r.toTicketId);
      if (seen !== undefined && r.maxId <= seen) continue;
      const last = lastPointerAt.get(r.toTicketId);
      if (last !== undefined && deps.now() - last < POINTER_INTERVAL_MS) {
        deps.debug(`[driver] delivery #${r.toTicketId}: rate-limited — coalescing`);
        continue;
      }
      if (deps.delivery.deliver(r.toTicketId, r.unread) === 'deferred') {
        deps.debug(`[driver] delivery #${r.toTicketId}: deferred (${r.unread} unread)`);
        continue;
      }
      watermark.set(r.toTicketId, r.maxId);
      lastPointerAt.set(r.toTicketId, deps.now());
      deps.debug(`[driver] delivery #${r.toTicketId}: pointer delivered (${r.unread} unread)`);
      out.push(r.toTicketId);
    }
  }

  function wakeParents(projectId: number, out: number[]): void {
    const probe = { isLiveHere: deps.isLive, graphOwned: deps.graphOwned };
    for (const ev of pendingWakeEvents(deps.store, projectId, eventBaseline)) {
      if (disposed) return;
      const { decision, reason } = parentWakeDecision(deps.store, ev.toTicketId, ev.body, probe);
      if (decision === 'retry') {
        deps.debug(`[driver] delivery wake event ${ev.id}: deferred — ${reason}`);
        continue;
      }
      if (!claimWake(deps.store, ev.id)) {
        deps.debug(`[driver] delivery wake event ${ev.id}: claimed elsewhere`);
        continue;
      }
      deps.debug(`[driver] delivery wake event ${ev.id} -> #${ev.toTicketId}: ${decision} — ${reason}`);
      if (decision !== 'wake' || out.includes(ev.toTicketId)) continue;
      deps.wake(ev.toTicketId);
      out.push(ev.toTicketId);
    }
  }

  function sweep(): SweepResult {
    const result: SweepResult = { delivered: [], woke: [] };
    if (disposed) return result;
    if (running) {
      deps.debug('[driver] delivery: sweep already running — skipping');
      return result;
    }
    running = true;
    try {
      const projectId = deps.projectId();
      if (projectId === undefined) return result;
      deliverPointers(projectId, result.delivered);
      wakeParents(projectId, result.woke);
      if (result.delivered.length + result.woke.length > 0) {
        deps.debug(
          `[driver] delivery: ${result.delivered.length} pointer(s), ${result.woke.length} wake(s)`,
        );
      }
      return result;
    } catch (err) {
      deps.debug(`[driver] delivery: sweep failed — ${errorText(err)}`);
      return result;
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    dispose: () => {
      disposed = true;
    },
  };
}
