import type { LogError } from '../../logging/logger.js';
import type { ResourceMonitor, ResourceReading } from '../../runtime/resourceMonitor.js';
import type { WorktreeDiskCache, DiskUsage } from '../../runtime/worktreeDisk.js';
import type { BaselineDependent } from '../../store/baselineRefs.js';
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
  type PanelTab,
  type ResourcesActions,
  type ResourcesHostMessage,
  type ResourcesWebviewMessage,
} from './messages.js';
import { buildServersState, unavailableServersState, type ServersState } from './serversState.js';
import type { ServerInventory } from '../../store/serverInventory.js';
import { tabTitle } from '../../model/tabTitle.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';
import { formatId } from '../../model/entityId.js';

/**
 * The "Servers & resources" panel — ONE per window, like the token-usage panel.
 * Two tabs share one webview: Servers (the project-wide control plane) and
 * Resources (the resource monitor's cost view, unchanged). It is a
 * WINDOW-scoped view of a window-scoped monitor, so opening it again reveals
 * the existing panel rather than minting a second webview or subscriber.
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

/** Panel title; also the editor-tab title, passed through `tabTitle` at `open()`. */
export const PANEL_TITLE = 'Servers & resources';

/** How often the Servers tab re-reads while open, so another window's spin shows up. */
const SERVERS_POLL_MS = 5_000;

/**
 * Everything the Servers tab does, bound in `extension.ts` to the ops under
 * `src/extension/ops/` (`sharedServerOps`, `serverOps`) and the existing
 * helpers. Each verb is a promise so a failure reaches the pressed control as
 * an `action-result`.
 */
export interface ServersHost {
  /** A fresh project-scoped read; undefined when there is no project or manifest to read. */
  inventory(): ServerInventory | undefined;
  startShared(repo: string): Promise<void>;
  restartShared(repo: string): Promise<void>;
  stopShared(repo: string): Promise<void>;
  setPinned(repo: string, pinned: boolean): void;
  stopIdle(): Promise<void>;
  startRow(serverId: number): Promise<void>;
  restartRow(serverId: number): Promise<void>;
  stopRow(serverId: number): Promise<void>;
  openRow(serverId: number): void;
  copyRow(serverId: number): void;
  stopTicket(ticketId: number): Promise<void>;
  openTicketLogs(ticketId: number): void;
  openLogs(): void;
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
  /**
   * The tickets a baseline stop would affect: the LIVE dependents of the
   * baseline behind this server row (`store/baselineRefs.ts` — archived tickets
   * and done tickets with nothing running are already filtered out). `[]` when
   * the row is not a baseline.
   */
  baselineDependents?: (serverId: number) => BaselineDependent[];
  /**
   * The panel title when it is more than the fixed name (a project suffix, say).
   * Whatever it returns is capped at `TAB_TITLE_MAX` before it reaches the editor
   * tab; the full name stays in the panel header.
   */
  panelTitle?: () => string;
  /** The Servers tab's verbs. Absent → the tab renders as unavailable. */
  servers?: ServersHost;
  /** Re-read interval for the Servers tab; tests shrink it. */
  serversPollMs?: number;
  logError?: LogError;
}

export class ResourcesPanelManager {
  private panel: ResourcesPanel | undefined;
  private unsubscribe: (() => void) | undefined;
  private diskController: AbortController | undefined;
  private diskRequest = 0;
  private diskRows: DiskRowView[] = [];
  /** The tab the next `request-state` should land on; cleared once delivered. */
  private pendingTab: PanelTab | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private lastServers = '';

  constructor(
    private readonly host: ResourcesPanelHost,
    private readonly deps: ResourcesPanelDeps,
  ) {}

  /**
   * Open (or reveal) the panel on `tab`. Idempotent — a repeat open never mints a
   * second webview or a second subscriber; it reveals the one panel and moves it
   * to the requested tab.
   */
  open(tab: PanelTab = 'resources'): void {
    if (this.panel) {
      this.panel.reveal();
      this.post({ type: 'show-tab', tab });
      this.push();
      return;
    }
    const panel = this.host.createPanel(tabTitle(this.deps.panelTitle?.() ?? PANEL_TITLE));
    this.panel = panel;
    this.pendingTab = tab;
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
    this.poll = setInterval(() => this.postServers(), this.deps.serversPollMs ?? SERVERS_POLL_MS);
    // Populate the panel without waiting up to 30 s for the next slow tick.
    void this.deps.monitor.refreshNow();
  }

  /** The Servers tab re-reads and repaints now (called after any server change). */
  refreshServers(): void {
    this.postServers();
  }

  dispose(): void {
    this.close();
  }

  private close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.lastServers = '';
    this.diskController?.abort();
    this.diskController = undefined;
    this.deps.monitor.setPanelVisible(false);
    this.panel = undefined;
  }

  private actions(): ResourcesActions {
    const servers = this.deps.servers;
    // A row id from the webview may already be gone (startHot deletes and
    // reinserts, another window may have stopped it): re-read, refuse a vanished
    // row by name, and repaint so the user sees what is actually there.
    const liveRow = (serverId: number): void => {
      const inventory = servers?.inventory();
      const found = inventory?.tickets.some((g) => g.servers.some((r) => r.id === serverId));
      if (!found) {
        this.postServers(true);
        throw new Error('That server is no longer in the list — it has been refreshed.');
      }
    };
    const needServers = (): ServersHost => {
      if (!servers) throw new Error('Servers are not available in this window.');
      return servers;
    };
    // Every verb ends with a fresh read, win or lose, so the row repaints.
    const refreshed = async (run: () => void | Promise<void>): Promise<void> => {
      try {
        await run();
      } finally {
        this.postServers(true);
      }
    };
    return {
      requestState: () => {
        if (this.pendingTab) {
          this.post({ type: 'show-tab', tab: this.pendingTab });
          this.pendingTab = undefined;
        }
        this.push();
      },
      sharedStart: (repo) => refreshed(() => needServers().startShared(repo)),
      sharedRestart: (repo) => refreshed(() => needServers().restartShared(repo)),
      sharedStop: (repo) => refreshed(() => needServers().stopShared(repo)),
      sharedPin: (repo, pinned) => refreshed(() => needServers().setPinned(repo, pinned)),
      stopIdle: () => refreshed(() => needServers().stopIdle()),
      serverStart: (id) => refreshed(() => { liveRow(id); return needServers().startRow(id); }),
      serverRestart: (id) => refreshed(() => { liveRow(id); return needServers().restartRow(id); }),
      serverStop: (id) => refreshed(() => { liveRow(id); return needServers().stopRow(id); }),
      serverOpen: (id) => needServers().openRow(id),
      serverCopy: (id) => needServers().copyRow(id),
      ticketStopAll: (ticketId) =>
        refreshed(() => {
          const group = servers?.inventory()?.tickets.find((g) => g.ticketId === ticketId);
          if (!group || !group.servers.some((r) => r.status === 'running')) {
            throw new Error('That ticket has no running servers any more — the list has been refreshed.');
          }
          return needServers().stopTicket(ticketId);
        }),
      ticketLogs: (ticketId) => needServers().openTicketLogs(ticketId),
      openLogs: () => needServers().openLogs(),
      refresh: () => this.deps.monitor.refreshNow(),
      measureDisk: () => this.measureDisk(),
      killServer: async (serverId) => {
        if (this.deps.confirm) {
          const dependents = this.deps.baselineDependents?.(serverId) ?? [];
          // Name the KEYS the user can match against their board, never the raw
          // `tickets.id`. A done ticket is named with the reason it still counts:
          // its own running stack is what the shared copy is wired to, so a bare
          // key next to unfinished tickets would read as a stale ref.
          const labels = dependents.map((d) => {
            const key = d.key ?? formatId('ticket', d.ticketId);
            return d.stageCurrent === 'done' && d.hasRunningService
              ? `${key} (done, still running)`
              : key;
          });
          const message =
            labels.length === 0
              ? 'Stop this server process?'
              : `This is a baseline server shared by ${labels.length} ticket(s): ` +
                `${labels.join(', ')}. Stopping it takes the ` +
                `dependency out from under all of them. Stop it anyway?`;
          const ok = await this.deps.confirm(message);
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
    this.postServers(true);
  }

  private post(message: ResourcesHostMessage): void {
    try {
      this.panel?.postMessage(message);
    } catch (err) {
      this.log('karst: resource panel post failed', err);
    }
  }

  /** The state the Servers tab would render right now — the read the tests assert on. */
  serversState(): ServersState {
    const host = this.deps.servers;
    const scopeLabel = this.deps.scopeLabel?.() ?? '';
    if (!host) return unavailableServersState('Servers are not available in this window.', scopeLabel);
    let inventory: ServerInventory | undefined;
    try {
      inventory = host.inventory();
    } catch (err) {
      this.log('karst: servers inventory read failed', err);
      return unavailableServersState('The server list could not be read.', scopeLabel);
    }
    if (!inventory) return unavailableServersState('Open a project with a karst.yml to see its servers.', scopeLabel);
    return buildServersState(inventory, scopeLabel);
  }

  /** Post the Servers state; the interval path skips an unchanged read (`force` always posts). */
  private postServers(force = false): void {
    if (!this.panel) return;
    const state = this.serversState();
    const serialized = JSON.stringify(state);
    if (!force && serialized === this.lastServers) return;
    this.lastServers = serialized;
    this.post({ type: 'servers', state });
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
