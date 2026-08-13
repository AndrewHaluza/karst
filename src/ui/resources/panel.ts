import type { LogError } from '../../logging/logger.js';
import type { ResourceMonitor, ResourceReading } from '../../runtime/resourceMonitor.js';
import type { WorktreeDiskCache, DiskUsage } from '../../runtime/worktreeDisk.js';
import type { PathContext } from '../worktreePath.js';
import {
  buildResourcesState,
  toDiskRows,
  type DiskRowView,
  type ResourcesState,
  type TicketIdentity,
} from './state.js';
import {
  parseResourcesMessage,
  routeResourcesAction,
  type ResourcesActions,
  type ResourcesHostMessage,
  type ResourcesWebviewMessage,
} from './messages.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';

/**
 * The resource-monitor panel — ONE per window, like the token-usage panel. It
 * is a WINDOW-scoped view of a window-scoped monitor, so opening it again
 * reveals the existing panel rather than minting a second subscriber.
 *
 * It owns none of the monitoring logic. It subscribes to the monitor's
 * readings and renders them; on dispose it releases the fast lane
 * (`setPanelVisible(false)`) and aborts any in-flight disk pass.
 *
 * The kill confirmation lives HOST-side (UI-R33): the webview posts only a
 * `servers.id`, and this manager's `killServer` goes through an injected
 * `confirm` gate (bound in `extension.ts` to `showWarningMessage`) before the
 * monitor's attribution re-check may signal anything.
 */

/** The subset of a `vscode.WebviewPanel` this manager touches. */
export interface ResourcesPanel {
  reveal(preserveFocus?: boolean): void;
  postMessage(message: ResourcesHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory the manager mints panels with (real: `createWebviewPanel`). */
export interface ResourcesPanelHost {
  createPanel(title: string): ResourcesPanel;
}

export interface ResourcesPanelDeps {
  monitor: ResourceMonitor;
  disk: WorktreeDiskCache;
  /** The worktree paths to measure on demand — a getter, they change per spin. */
  worktreePaths: () => string[];
  pathContext?: () => PathContext | undefined;
  /**
   * Resolve the `tickets.id`s the attributed rows carry to the key/title the
   * user can match against their board. Absent → rows render `#<id>`-free.
   */
  ticketIdentity?: (ids: readonly number[]) => ReadonlyMap<number, TicketIdentity>;
  /** The scope line under the title ("Project <name> · this window"). */
  scopeLabel?: () => string;
  /**
   * Host-side kill confirmation (UI-R33). Absent in tests; bound to
   * `showWarningMessage` in `extension.ts`.
   */
  confirm?: (message: string) => Promise<boolean>;
  logError?: LogError;
}

export class ResourcesPanelManager {
  private panel: ResourcesPanel | undefined;
  private unsubscribe: (() => void) | undefined;
  private diskController: AbortController | undefined;
  private diskRequest = 0;
  private diskRows: DiskRowView[] = [];

  constructor(
    private readonly host: ResourcesPanelHost,
    private readonly deps: ResourcesPanelDeps,
  ) {}

  /** Open (or reveal) the panel. Idempotent — never a second subscriber. */
  open(): void {
    if (this.panel) {
      this.panel.reveal();
      this.push();
      return;
    }
    const panel = this.host.createPanel('Resources');
    this.panel = panel;
    this.deps.monitor.setPanelVisible(true);
    this.unsubscribe = this.deps.monitor.onReading((reading) => this.push(reading));
    panel.onDidDispose(() => {
      this.close();
    });
    panel.onDidReceiveMessage((raw) => {
      const requestId = readRequestId(raw);
      const msg = parseResourcesMessage(raw);
      if (!msg) return;
      const actions = this.actions();
      void reportAction(requestId, (message) => panel.postMessage(message), () =>
        this.runAction(msg, actions),
      );
    });
    this.push();
    // Populate the panel without waiting up to 30 s for the next slow tick.
    void this.deps.monitor.refreshNow();
  }

  dispose(): void {
    this.close();
  }

  private close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.diskController?.abort();
    this.diskController = undefined;
    this.deps.monitor.setPanelVisible(false);
    this.panel = undefined;
  }

  private actions(): ResourcesActions {
    return {
      requestState: () => this.push(),
      refresh: () => this.deps.monitor.refreshNow(),
      measureDisk: () => this.measureDisk(),
      killServer: async (serverId) => {
        if (this.deps.confirm) {
          const ok = await this.deps.confirm('Stop this server process?');
          if (!ok) return;
        }
        const outcome = await this.deps.monitor.kill(serverId);
        this.push();
        if (outcome === 'killed') return;
        // The outcome wording IS the terminal result (UI-R13): the user asked
        // to stop it, and it was not stopped. reportAction turns a thrown error
        // into one `action-result` naming why.
        const wording =
          outcome === 'denied'
            ? 'Refused — the process is still running'
            : outcome === 'unknown'
              ? 'Result unknown'
              : 'Not stopped — that pid is no longer provably ours';
        throw new Error(wording);
      },
    };
  }

  private measureDisk(): Promise<void> {
    this.diskController?.abort();
    const controller = new AbortController();
    this.diskController = controller;
    const request = (this.diskRequest += 1);
    const paths = this.deps.worktreePaths();
    return this.deps.disk.measureAll(paths, controller.signal, (usage) => {
      this.recordDisk(usage);
      this.postDisk();
    }).then(
      () => {
        if (this.diskRequest !== request) return;
        this.diskController = undefined;
      },
      (err: unknown) => {
        if (this.diskRequest !== request) return;
        this.diskController = undefined;
        this.log('karst: resource disk pass failed', err);
      },
    );
  }

  private recordDisk(usage: DiskUsage): void {
    const pathContext = this.deps.pathContext?.();
    this.diskRows = [
      ...this.diskRows.filter((row) => row.path !== usage.path),
      ...toDiskRows([usage], pathContext),
    ];
  }

  private postDisk(): void {
    if (!this.panel) return;
    try {
      this.panel.postMessage({ type: 'disk', rows: [...this.diskRows] });
    } catch (err) {
      this.log('karst: resource disk push failed', err);
    }
  }

  /** The state the panel would render right now — the read the tests assert on. */
  state(): ResourcesState {
    return this.buildState(this.deps.monitor.reading());
  }

  private buildState(reading: ResourceReading): ResourcesState {
    const ids = [
      ...new Set(
        (reading.inventory?.attributed ?? [])
          .map((row) => row.ticketId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const lifecycle = this.deps.ticketIdentity?.(ids) ?? new Map<number, TicketIdentity>();
    return buildResourcesState(
      reading,
      this.diskRows.map((row) => ({ path: row.path, bytes: row.bytes, measuredMs: row.measuredMs })),
      this.deps.pathContext?.(),
      { lifecycle, scopeLabel: this.deps.scopeLabel?.() ?? '' },
    );
  }

  private push(reading?: ResourceReading): void {
    if (!this.panel) return;
    try {
      const state = this.buildState(reading ?? this.deps.monitor.reading());
      this.panel.postMessage({ type: 'state', state });
    } catch (err) {
      this.log('karst: resource state push failed', err);
    }
  }

  /** Dispatch one parsed message, logging (but still surfacing) any failure. */
  private runAction(msg: ResourcesWebviewMessage, actions: ResourcesActions): void | Promise<void> {
    try {
      const result = routeResourcesAction(msg, actions);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        return (result as Promise<void>).catch((err: unknown) => {
          this.log('karst: resource action failed', err);
          throw err;
        });
      }
      return result;
    } catch (err) {
      this.log('karst: resource action failed', err);
      throw err;
    }
  }

  private log(message: string, err: unknown): void {
    (this.deps.logError ?? ((m: string, e: unknown) => console.error(m, e)))(message, err);
  }
}
