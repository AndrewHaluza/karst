import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import type { RestoredPanel } from '../ui/shared/restoredPanel.js';
import { restoredTicketId } from '../ui/shared/restoredPanel.js';
import { RESTORED_VIEW_TYPES, type RawPanel, type RestoreGate, type RestoredViewType, type Restorers } from './panelRestore.js';
export { RestoreGate } from './panelRestore.js';

/** The slice of `vscode.window` the serializer registration needs. */
export interface SerializerWindow<D> {
  registerWebviewPanelSerializer(
    viewType: string,
    serializer: { deserializeWebviewPanel(panel: never, state: unknown): Thenable<void> },
  ): D;
}

/**
 * Register one serializer per restored view type. Call it synchronously at the top of
 * `activate()`: VS Code asks for the tabs as soon as the extension host is up, and each
 * restore waits on the gate until the managers exist.
 */
export function registerRestoreSerializers<D>(win: SerializerWindow<D>, gate: RestoreGate): D[] {
  return RESTORED_VIEW_TYPES.map((viewType: RestoredViewType) =>
    win.registerWebviewPanelSerializer(viewType, {
      deserializeWebviewPanel: (panel: never, state: unknown) => gate.restore(viewType, panel as RawPanel, state),
    }),
  );
}

/** True when the ticket exists and is not archived. A missing ticket reads as not live. */
export function liveTicket(store: Store, ticketId: number): boolean {
  try {
    return getTicket(store, ticketId).archivedAt === null;
  } catch {
    return false;
  }
}

interface Host<R, P> {
  restore(raw: R): RestoredPanel<P>;
}

/** The managers and hosts a restored tab is adopted into. `R` is the raw panel type of the host. */
export interface RestoreTargets<R extends RawPanel> {
  store: Store;
  dashboard: { adoptDashboard(ticketId: number | undefined, restored: RestoredPanel<unknown>): unknown };
  dashboardHost: Host<R, unknown>;
  changes: { adopt(ticketId: number | undefined, restored: RestoredPanel<unknown>, exists: (id: number) => boolean): unknown };
  changesHost: Host<R, unknown>;
  ticketForm: {
    adopt(
      restored: RestoredPanel<unknown>,
      state: unknown,
      exists: (id: number) => boolean,
      proposalPrefill?: (draftId: number) => unknown,
      proposalOutcome?: (draftId: number) => unknown,
    ): unknown;
  };
  /** Builds the prefill of a pending planning proposal again; undefined when it is no longer pending in this project. */
  proposalPrefill?: (draftId: number) => unknown;
  /** The stored status of a planning proposal; a restored review form reads it to tell a saved ticket from a draft row. */
  proposalOutcome?: (draftId: number) => unknown;
  /** True when the manifest loads. A restored form of a window without a usable manifest closes: a Save would clear its repositories. */
  manifestReady?: () => boolean;
  ticketFormHost: Host<R, unknown>;
  settings: { adopt(restored: RestoredPanel<unknown>): unknown };
  settingsHost: Host<R, unknown>;
  gettingStarted: { adopt(restored: RestoredPanel<unknown>): unknown };
  gettingStartedHost: Host<R, unknown>;
  doctor: { restore(raw: R): Promise<void> };
  usage: { adopt(restored: RestoredPanel<unknown>, state?: unknown): unknown };
  usageHost: Host<R, unknown>;
  resources: { adopt(restored: RestoredPanel<unknown>): unknown };
  resourcesHost: Host<R, unknown>;
}

type HostKey = 'dashboardHost' | 'changesHost' | 'ticketFormHost' | 'settingsHost' | 'gettingStartedHost' | 'usageHost' | 'resourcesHost';

/** Records each panel host as `extension.ts` builds it, so the restorers reuse the same host (no extra wiring lines there). */
export function hostTracker<R extends RawPanel>(): {
  track<H>(key: HostKey, host: H): H;
  hosts(): Pick<RestoreTargets<R>, HostKey>;
} {
  const seen = new Map<HostKey, unknown>();
  return {
    track: (key, host) => (seen.set(key, host), host),
    hosts: () => Object.fromEntries(seen) as Pick<RestoreTargets<R>, HostKey>,
  };
}

/** The adopt path of each restored view type, built once the managers exist. */
export function makeRestorers<R extends RawPanel>(t: RestoreTargets<R>): Restorers {
  const exists = (id: number): boolean => liveTicket(t.store, id);
  return {
    'karst.dashboard': (raw, state) => void t.dashboard.adoptDashboard(restoredTicketId(state), t.dashboardHost.restore(raw as R)),
    'karst.changes': (raw, state) => void t.changes.adopt(restoredTicketId(state), t.changesHost.restore(raw as R), exists),
    'karst.ticketForm': (raw, state) => {
      const restored = t.ticketFormHost.restore(raw as R);
      if (t.manifestReady && !t.manifestReady()) return restored.dispose();
      void t.ticketForm.adopt(restored, state, exists, t.proposalPrefill, t.proposalOutcome);
    },
    'karst.settings': async (raw) => void (await t.settings.adopt(t.settingsHost.restore(raw as R))),
    'karst.gettingStarted': (raw) => void t.gettingStarted.adopt(t.gettingStartedHost.restore(raw as R)),
    karstDoctor: (raw) => t.doctor.restore(raw as R),
    'karst.tokenUsage': (raw, state) => void t.usage.adopt(t.usageHost.restore(raw as R), state),
    'karst.resources': (raw) => void t.resources.adopt(t.resourcesHost.restore(raw as R)),
  };
}
