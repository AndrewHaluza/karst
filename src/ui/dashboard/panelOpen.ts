import type { LogError } from '../../logging/logger.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import type { Store } from '../../store/db.js';
import { compactTicketLabel } from '../../model/followUp.js';
import { tabTitle } from '../../model/tabTitle.js';
import type { DashboardActions } from './messages.js';
import { attachMessagePump } from './messagePump.js';
import type { LiveTicker } from './liveTicker.js';
import type { PushMemory } from './snapshotPush.js';
import type { SupplementalLoaders } from './supplementalLoaders.js';
import type { DashboardSelections } from './selections.js';
import type { SnapshotRegistry } from './snapshotRegistry.js';
import type {
  ActionsFactory,
  DashboardBinding,
  DashboardPanel,
  PanelHost,
} from './panelTypes.js';

/** The manager state and callbacks a newly created panel is wired to. */
export interface PanelOpenDeps {
  store: Store;
  host: PanelHost;
  actionsFor: ActionsFactory;
  labelTemplate?: () => string | undefined;
  onServerLogsDetach?: (ticketId: number) => void;
  binding?: DashboardBinding;
  onViewActivated?: (ticketId: number, active: boolean) => void;
  panels: Map<number, DashboardPanel>;
  ticks: LiveTicker;
  memory: PushMemory;
  loaders: SupplementalLoaders;
  selections: DashboardSelections;
  registry: SnapshotRegistry;
  pushState: (ticketId: number) => void;
  /** Push one live (clock-repaint) snapshot. */
  repaint: (ticketId: number) => void;
  logError: LogError;
}

/** Create a ticket's panel and wire its message pump, visibility and disposal. */
export function openNewPanel(
  o: PanelOpenDeps,
  ticketId: number,
  preserveFocus: boolean | undefined,
): DashboardPanel {
  const ticket = getTicket(o.store, ticketId);
  const panel = o.host.createPanel(
    tabTitle(compactTicketLabel(ticket, ticketLabel(ticket, o.labelTemplate?.()))),
    ticketId,
    preserveFocus,
  );
  o.panels.set(ticketId, panel);

  // The factory's actions plus the detach callback bound to THIS ticket: the
  // webview's "Open in Window" message names no ticket, so the closure owns it.
  const actions: DashboardActions = {
    ...o.actionsFor(ticketId),
    onServerLogsDetach: () => o.onServerLogsDetach?.(ticketId),
  };
  // Message pump must never die on one bad message — routeAction validates,
  // and any downstream throw is contained so subsequent messages still flow.
  attachMessagePump(panel, {
    ticketId,
    actions,
    selections: o.selections,
    registry: o.registry,
    pushState: (id) => o.pushState(id),
    logError: o.logError,
  });
  panel.onDidChangeViewState((active) => {
    o.binding?.onDidActivate(ticketId, active);
    o.onViewActivated?.(ticketId, active);
    // A hidden panel stops its live tick, so coming back needs one catch-up
    // repaint — that push re-arms the loop. Guarded on there being live work
    // (`scheduleLiveTick` decides), and harmless otherwise: it is the same
    // snapshot every other push builds.
    if (panel.isVisible?.() === false) {
      // Going hidden cancels the tick already armed — the repaint it would
      // run is for a webview nobody can see.
      o.ticks.cancel(ticketId);
      return;
    }
    if (o.ticks.has(ticketId)) return; // still ticking; nothing to catch up
    try {
      o.repaint(ticketId);
    } catch (err) {
      o.logError('karst: dashboard visibility repaint failed', err);
    }
  });
  panel.onDidDispose(() => {
    if (o.panels.get(ticketId) !== panel) return;
    // The ACTIVE view can be closed while focused; the dispose is the only
    // signal that the focus is gone, so report it exactly like a deactivation.
    o.onViewActivated?.(ticketId, false);
    o.ticks.cancel(ticketId);
    o.memory.clear(ticketId);
    o.panels.delete(ticketId);
    // The async loaders abort and drop their per-ticket state; the round
    // switcher selection and findings repo scope die with the panel too (a
    // later open of the same ticket id starts at the defaults), and the
    // panel's action capabilities die with it: a disposed panel's ids must
    // never dispatch against a later snapshot.
    o.loaders.clear(ticketId);
    o.selections.clear(ticketId);
    o.registry.clear(ticketId);
  });
  return panel;
}
