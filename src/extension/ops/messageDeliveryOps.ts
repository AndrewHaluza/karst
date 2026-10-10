import type { Store } from '../../store/db.js';
import {
  DELIVERY_READ_LIMIT,
  claimWake,
  maxMessageId,
  pendingWakeEvents,
  unreadByRecipient,
  type RecipientUnread,
  type WakeEventRow,
} from '../../store/messageDelivery.js';
import {
  mailPointer,
  notesPointer,
  type MessageDelivery,
  type MessagePointer,
  type MessageRoute,
} from '../../workflow/messageDelivery.js';
import { unreadNotesByTicket } from '../../store/bulletinNotes.js';
import { parentWakeDecision, type WakeDecision } from '../../workflow/parentWake.js';
import { formatId } from '../../model/entityId.js';

/**
 * A recipient's push route from its CURRENT live-session core. Resolved at
 * delivery time, never stored per ticket: a core can change between stages or
 * resumes (a codex implement followed by a claude fix), and the route must
 * follow the live session, not the history.
 *
 *  - claude pins the Stop-block reply.
 *  - codex pins it only once the live CLI was verified to honor a Stop block
 *    (`codexStopBlock`); until then it uses the typed route.
 *  - opencode v1 pulls the pointer through its plugin on `session.idle`.
 *  - opencode2 has no SDK client on the plugin context, agy has no executable
 *    channel, and an unknown/absent core has no channel at all — all type.
 */
export function messageRouteFor(
  provider: string | null | undefined,
  codexStopBlock: boolean,
): MessageRoute {
  switch (provider) {
    case 'claude':
      return 'hook-block';
    case 'codex':
      return codexStopBlock ? 'hook-block' : 'typed';
    case 'opencode':
      return 'plugin-idle';
    default:
      return 'typed';
  }
}

/**
 * Mailbox delivery sweep (plan Wave 3). Two jobs per tick, both in this
 * window's bound project:
 *
 * 1. Pointer: a recipient with unread rows newer than the last one this
 *    window delivered for gets ONE pointer line via `delivery` — at most one
 *    per `POINTER_INTERVAL_MS`; rows arriving inside the window coalesce into
 *    the next pointer's count. Mail and project notes are tracked separately
 *    (watermark and rate limit per kind), so one never suppresses the other.
 *    The watermark is in memory (ids are AUTOINCREMENT, never reused): after a
 *    reload a recipient with a backlog gets exactly one pointer on first sight.
 *    A `deferred` delivery is retried next tick; a recipient with nothing
 *    unread is forgotten.
 * 2. Wake: an event row written after activation is decided by
 *    `parentWakeDecision`. Terminal skips and wakes are claimed once across
 *    windows (`claimWake`); a transient `retry` stays unclaimed until it ages
 *    past `EVENT_MAX_AGE_MS`. A parent woken here is not woken again for
 *    `WAKE_COOLDOWN_MS`, and counts as live while its open is in progress.
 */

export const POINTER_INTERVAL_MS = 30_000;
export const WAKE_COOLDOWN_MS = 60_000;
export const EVENT_MAX_AGE_MS = 30 * 60_000;

/**
 * The typed-pointer gate's provider half: is the recipient's LIVE session an
 * agy one? Prefer the session's RECORDED launch identity (accurate for a
 * session this window launched or adopted with a persisted identity) and fall
 * back to the configured provider for a handle whose identity this window never
 * recorded. Reading the CURRENT session — never a leftover watch-state entry —
 * is what lets a core switch AWAY from agy deliver immediately: the retired
 * agy state survives (the switch tracks the replacement before VS Code
 * delivers the old handle's close, so the close sweep never runs), but it must
 * not gate the replacement.
 */
export function isAgyRecipient(
  ticketId: number,
  sessions: { sessionIdentity(id: number): { provider?: string } | null },
  configuredProvider: (id: number) => string | null,
): boolean {
  return (
    (sessions.sessionIdentity(ticketId)?.provider ?? configuredProvider(ticketId)) === 'antigravity'
  );
}

export interface MessageDeliveryDeps {
  store: Store;
  projectId: () => number | undefined;
  delivery: MessageDelivery;
  /** Unread project notes per recipient; defaults to the store read. */
  notesUnread?: (projectId: number) => readonly PointerRow[];
  isLive: (ticketId: number) => boolean;
  isGraphTicket: (ticketId: number) => boolean;
  integrating: (ticketId: number) => boolean;
  /**
   * Refresh the host's in-memory unread cache from this sweep's rows. The hook
   * endpoint reads that cache when a recipient's turn ends, so it never queries
   * the DB on the hook's hot path. Called every sweep, before delivery.
   */
  refreshUnread: (rows: readonly RecipientUnread[]) => void;
  /**
   * Whether the REPLY channel already pushed this batch (the turn-end hook
   * block / plugin `promptAsync`). The reply IS that batch's delivery, so the
   * sweep must skip it — otherwise the next tick sees the mail still unread,
   * the recipient now idle (a block continuation fires no `UserPromptSubmit`),
   * and types a SECOND copy into a terminal that is mid-turn on the block. The
   * record is keyed by the batch's watermark, so a later batch still delivers.
   */
  alreadyPushed?: (ticketId: number, maxId: number) => boolean;
  /** Open the parent's session WITHOUT revealing it. */
  wake: (ticketId: number) => Promise<void> | void;
  now: () => number;
  debug: (message: string) => void;
  warn: (message: string) => void;
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

/** SQLite `datetime('now')` text is UTC without a zone marker. */
function sqliteUtcMs(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`);
}

/** One recipient's unread batch for a pointer kind. */
export interface PointerRow {
  toTicketId: number;
  unread: number;
  maxId: number;
}

export function makeMessageDeliverySweep(deps: MessageDeliveryDeps): MessageDeliverySweep {
  // Per-kind state: a mail delivery never suppresses a notes pointer, nor the reverse.
  const watermark: Record<MessagePointer['kind'], Map<number, number>> = {
    mail: new Map(),
    notes: new Map(),
  };
  const lastPointerAt: Record<MessagePointer['kind'], Map<number, number>> = {
    mail: new Map(),
    notes: new Map(),
  };
  const lastWakeAt = new Map<number, number>();
  const opening = new Set<number>();
  const retryLogged = new Map<number, string>();
  const eventBaseline = maxMessageId(deps.store);
  // The sweep is synchronous today; the guard stays for a future async
  // deliver/wake, so overlapping ticks can never double-deliver.
  let running = false;
  let disposed = false;

  function prune(kind: MessagePointer['kind'], present: ReadonlySet<number>): void {
    for (const id of [...watermark[kind].keys()]) if (!present.has(id)) watermark[kind].delete(id);
    for (const id of [...lastPointerAt[kind].keys()]) if (!present.has(id)) lastPointerAt[kind].delete(id);
  }

  function deliverRows(kind: MessagePointer['kind'], rows: readonly PointerRow[], out: number[]): void {
    const tag = kind === 'notes' ? 'notes ' : '';
    for (const r of rows) {
      if (disposed) return;
      const seen = watermark[kind].get(r.toTicketId);
      if (seen !== undefined && r.maxId <= seen) continue;
      // The turn-end reply may have pushed THIS batch already (the arm does not
      // set a watermark, because a hook that never arrives must still fall back
      // to typing). Skip it — and record the watermark so we do not re-check
      // every tick — instead of typing a duplicate into a mid-turn terminal.
      // The reply only ever carries mail, so notes never consult it.
      if (kind === 'mail' && deps.alreadyPushed?.(r.toTicketId, r.maxId)) {
        watermark[kind].set(r.toTicketId, r.maxId);
        deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: already pushed by the reply — skipping`);
        continue;
      }
      const last = lastPointerAt[kind].get(r.toTicketId);
      if (last !== undefined && deps.now() - last < POINTER_INTERVAL_MS) {
        deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}rate-limited — coalescing`);
        continue;
      }
      const pointer = kind === 'notes' ? notesPointer(r.unread) : mailPointer(r.unread);
      const outcome = deps.delivery.deliver(r.toTicketId, pointer);
      if (outcome === 'deferred') {
        deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}deferred (${r.unread} unread)`);
        continue;
      }
      if (outcome === 'armed') {
        // A push route is armed but NOTHING is delivered yet — the turn-end
        // reply will push it. The watermark stays put, so if that hook never
        // arrives the next sweep re-evaluates and types the pointer once the
        // recipient is idle, instead of silently stranding the batch.
        deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}armed (${r.unread} unread)`);
        continue;
      }
      watermark[kind].set(r.toTicketId, r.maxId);
      lastPointerAt[kind].set(r.toTicketId, deps.now());
      deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}pointer delivered (${r.unread} unread)`);
      out.push(r.toTicketId);
    }
  }

  function deliverPointers(projectId: number, out: number[]): void {
    const rows = unreadByRecipient(deps.store, projectId);
    // The endpoint's reply source: refresh it before any delivery decision so
    // a Stop that lands during this sweep sees the current counts.
    deps.refreshUnread(rows);
    // A truncated read cannot prove a recipient has nothing unread.
    if (rows.length < DELIVERY_READ_LIMIT) prune('mail', new Set(rows.map((r) => r.toTicketId)));
    deliverRows('mail', rows, out);
    const notes = deps.notesUnread?.(projectId) ?? unreadNotesByTicket(deps.store, projectId);
    prune('notes', new Set(notes.map((n) => n.toTicketId)));
    deliverRows('notes', notes, out);
  }

  function decide(ev: WakeEventRow): WakeDecision {
    const d = parentWakeDecision(deps.store, ev.toTicketId, ev.body, {
      isLiveHere: (id: number) => opening.has(id) || deps.isLive(id),
      isGraphTicket: deps.isGraphTicket,
      integrating: deps.integrating,
    });
    if (d.decision === 'skip') return d;
    // A stale event never surprise-wakes a parent, whatever it looks like now.
    if (deps.now() - sqliteUtcMs(ev.createdAt) > EVENT_MAX_AGE_MS) {
      return { decision: 'skip', reason: `aged out (${d.reason})` };
    }
    const woke = lastWakeAt.get(ev.toTicketId);
    if (d.decision === 'wake' && woke !== undefined && deps.now() - woke < WAKE_COOLDOWN_MS) {
      return { decision: 'retry', reason: 'wake cooldown' };
    }
    return d;
  }

  function startWake(parentId: number): void {
    opening.add(parentId);
    lastWakeAt.set(parentId, deps.now());
    const failed = (err: unknown): void => {
      deps.warn(`karst: waking ticket ${formatId('ticket', parentId)} failed: ${errorText(err)}`);
    };
    try {
      void Promise.resolve(deps.wake(parentId))
        .catch(failed)
        .finally(() => opening.delete(parentId));
    } catch (err) {
      failed(err);
      opening.delete(parentId);
    }
  }

  function wakeParents(projectId: number, out: number[]): void {
    for (const ev of pendingWakeEvents(deps.store, projectId, eventBaseline)) {
      if (disposed) return;
      const { decision, reason } = decide(ev);
      if (decision === 'retry') {
        if (retryLogged.get(ev.id) !== reason) {
          retryLogged.set(ev.id, reason);
          deps.debug(`[driver] delivery wake event ${ev.id}: retry — ${reason}`);
        }
        continue;
      }
      retryLogged.delete(ev.id);
      if (!claimWake(deps.store, ev.id)) {
        deps.debug(`[driver] delivery wake event ${ev.id}: claimed elsewhere`);
        continue;
      }
      deps.debug(`[driver] delivery wake event ${ev.id} -> ${formatId('ticket', ev.toTicketId)}: ${decision} — ${reason}`);
      if (decision !== 'wake') continue;
      startWake(ev.toTicketId);
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
      try {
        deliverPointers(projectId, result.delivered);
      } catch (err) {
        deps.debug(`[driver] delivery: pointer pass failed — ${errorText(err)}`);
      }
      try {
        wakeParents(projectId, result.woke);
      } catch (err) {
        deps.warn(`karst: parent wake sweep failed: ${errorText(err)}`);
      }
      if (result.delivered.length + result.woke.length > 0) {
        deps.debug(`[driver] delivery: ${result.delivered.length} pointer(s), ${result.woke.length} wake(s)`);
      }
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
