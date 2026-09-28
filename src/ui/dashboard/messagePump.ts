import type { LogError } from '../../logging/logger.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';
import type { DashboardPanel } from './panelTypes.js';
import { parseWebviewMessage, routeAction, type DashboardActions } from './messages.js';
import type { InsideActionResult } from './messages.js';
import type { SnapshotRegistry } from './snapshotRegistry.js';
import type { DashboardSelections } from './selections.js';

/** Everything the webview→host pump needs from the manager it serves. */
export interface MessagePumpDeps {
  ticketId: number;
  /** The ticket's bound daemon actions (factory result + detach closure). */
  actions: DashboardActions;
  /** Panel-only selection memory, updated by the pure-read message kinds. */
  selections: DashboardSelections;
  /** The current snapshot's capability registry, for `inside-action` dispatch. */
  registry: SnapshotRegistry;
  /** Request a fresh authoritative snapshot (the manager's `pushState`). */
  pushState: (ticketId: number) => void;
  /** Report a caught pump error to the Karst output channel. */
  logError: LogError;
}

/**
 * Bind a panel's message pump.
 *
 * The pump must never die on one bad message — `routeAction` validates, and any
 * downstream throw is contained so subsequent messages still flow. Pure-read
 * message kinds (`select-gate-attempt`, `select-findings-repo`) record panel
 * memory and re-render; an `inside-action` reports its real terminal outcome
 * (UI-R13) instead of a blanket success ack.
 */
export function attachMessagePump(panel: DashboardPanel, deps: MessagePumpDeps): void {
  const { ticketId, actions, selections, registry, logError } = deps;
  panel.onDidReceiveMessage((raw) => {
    // Read the correlation id off the RAW message, before it is narrowed —
    // `parseWebviewMessage` deliberately drops fields it does not model, and
    // that dropping is the trust boundary (see readRequestId's own doc).
    const requestId = readRequestId(raw);
    // An unparsed message posts NOTHING (UI-R13): no action ran, so there is
    // no terminal outcome to report, and reporting one anyway would ack a
    // message the host never acted on.
    const parsed = parseWebviewMessage(raw);
    if (!parsed) return;
    if (parsed.type === 'select-gate-attempt') {
      // Pure read: the selection is panel memory only — it never touches
      // the store, never mutates the ticket, and has no
      // `DashboardActions` method (messages.ts's `routeAction` deliberately
      // does not carry it). Recording it and re-rendering through the
      // normal state push is the whole handling.
      selections.selectAttempt(ticketId, parsed.stage, parsed.key);
      deps.pushState(ticketId);
      return;
    }
    if (parsed.type === 'select-findings-repo') {
      // Pure read: the selection is panel memory only — same shape as the
      // round switcher. A `null` repo DELETES the stage's entry rather
      // than storing a sentinel.
      selections.selectFindingsRepo(ticketId, parsed.stage, parsed.repo);
      deps.pushState(ticketId);
      return;
    }
    if (parsed.type === 'inside-action') {
      // An inside dispatch's outcome is known synchronously; the generic
      // seam's unconditional ack would report a rejected or stale dispatch
      // as success (UI-R13). Post the returned result for this request.
      // (`inside-action` never resolves to `Promise<InsideActionResult>` —
      // only `change-base-ref`, handled in its own branch below, does.)
      const result = routeAction(raw, actions) as InsideActionResult | void | Promise<void>;
      if (isInsideActionResult(result)) {
        if (requestId) {
          panel.postMessage({
            type: 'action-result',
            requestId,
            ok: result.ok,
            ...(result.message ? { message: result.message } : {}),
          });
        }
        return;
      }
      // A void/promise-returning factory keeps its exact old semantics.
      void reportAction(requestId, (message) => panel.postMessage(message), () => result);
      return;
    }
    if (parsed.type === 'change-base-ref') {
      // Refusal (dirty/conflict/base-missing/failed) must change NOTHING:
      // a repaint here would risk showing a new base the change never
      // actually reached. Success repaints so the scope card's `baseRef`
      // reflects what git actually did — the ONE case (besides
      // `select-gate-attempt`) this pump repaints outside a `state` push
      // the caller already scheduled. Same isInsideActionResult contract as
      // `inside-action`, just asynchronous: the outcome is a promise of one.
      const result = routeAction(raw, actions) as Promise<InsideActionResult>;
      void result.then(
        (outcome) => {
          if (outcome.ok) deps.pushState(ticketId);
          if (!requestId) return;
          try {
            panel.postMessage({
              type: 'action-result',
              requestId,
              ok: outcome.ok,
              ...(outcome.message ? { message: outcome.message } : {}),
            });
          } catch {
            // A disposed panel. The change already ran (or was refused); losing
            // the receipt is not a reason to surface an error nobody can act on.
          }
        },
        (err: unknown) => {
          logError('karst: change base ref failed', err);
          if (!requestId) return;
          try {
            panel.postMessage({
              type: 'action-result',
              requestId,
              ok: false,
              message: 'Changing the base branch failed.',
            });
          } catch {
            // A disposed panel.
          }
        },
      );
      return;
    }
    void reportAction(requestId, (message) => panel.postMessage(message), () => {
      try {
        const result = routeAction(raw, actions);
        if (result && typeof (result as PromiseLike<void>).then === 'function') {
          return (result as Promise<void>).catch((err: unknown) => {
            logError('karst: dashboard action failed', err);
            throw err;
          });
        }
        // An InsideActionResult cannot reach this seam: `inside-action` is
        // handled above, and no other case produces one.
        return result as void | Promise<void>;
      } catch (err) {
        logError('karst: dashboard action failed', err);
        throw err;
      }
    });
  });
}

/** Narrow a routed action's return to the synchronous inside outcome, if that is what it is. */
function isInsideActionResult(
  v: InsideActionResult | void | Promise<void>,
): v is InsideActionResult {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}
