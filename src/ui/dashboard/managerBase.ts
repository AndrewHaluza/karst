import type { InsideProgressEvent } from '../../model/inside/progress.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { AgentProcessId } from './messages.js';
import type { DashboardConsole } from './consoleOutput.js';
import { pushSnapshot, type SnapshotPushDeps } from './snapshotPush.js';
import type { DashboardPanel } from './panelTypes.js';

/**
 * The manager's thin public surface: the console/log forwarders (one-line
 * delegations to the `DashboardConsole`), the push entry points (each names a
 * push mode for `pushSnapshot`) and the open-panel queries. The concrete
 * manager supplies the panels, the console and the push dependencies.
 */
export abstract class DashboardManagerBase {
  protected abstract readonly panels: Map<number, DashboardPanel>;
  protected abstract readonly console: DashboardConsole;
  protected abstract readonly pushDeps: SnapshotPushDeps;

  /**
   * Push a transient inside-progress event to a ticket panel; no-op if not open.
   */
  postInsideProgress(ticketId: number, event: InsideProgressEvent): void {
    this.console.postInsideProgress(ticketId, event);
  }

  /**
   * Answer a `stage-log-request`. The answer IS the terminal outcome (UI-R13).
   */
  requestStageLog(ticketId: number, stage: GateStage): void {
    this.console.requestStageLog(ticketId, stage);
  }

  /**
   * Answer an `agent-log-request`. The answer IS the terminal outcome (UI-R13).
   */
  requestAgentLog(ticketId: number, processId: AgentProcessId): void {
    this.console.requestAgentLog(ticketId, processId);
  }

  /**
   * Push one sanitized live chunk of a gate-lane AI process's output to the
   * ticket's panel; no-op if the panel is not open.
   */
  postAgentOutput(ticketId: number, processId: AgentProcessId, text: string): void {
    this.console.postAgentOutput(ticketId, processId, text);
  }

  /**
   * Push one sanitized live chunk of a gate stage's deterministic gate output
   * to the ticket's panel; no-op if the panel is not open.
   */
  postStageOutput(ticketId: number, stage: GateStage, text: string): void {
    this.console.postStageOutput(ticketId, stage, text);
  }

  /**
   * Answer a `server-logs-request`; the answer IS the terminal outcome (UI-R13).
   */
  requestServerLogs(ticketId: number): void {
    this.console.requestServerLogs(ticketId);
  }

  /** Answer a `server-logs-close`: stop polling for server log updates. */
  closeServerLogs(ticketId: number): void {
    this.console.closeServerLogs(ticketId);
  }

  /**
   * Push one sanitized live chunk of a server's log output to the ticket's
   * panel; no-op if the panel is not open.
   */
  postServerLogOutput(ticketId: number, service: string, text: string): void {
    this.console.postServerLogOutput(ticketId, service, text);
  }

  /** Push a fresh state snapshot to a ticket panel; no-op if not open. */
  pushState(ticketId: number): void {
    pushSnapshot(this.pushDeps, ticketId, {
      kind: 'action',
      supplemental: true,
      live: false,
      settlesActions: true,
    });
  }

  /**
   * Push a complete snapshot for host-external news without claiming it is the
   * response to any dashboard action currently in flight.
   */
  pushPassiveState(ticketId: number): void {
    pushSnapshot(this.pushDeps, ticketId, {
      kind: 'passive',
      supplemental: true,
      live: false,
      settlesActions: false,
    });
  }

  /**
   * Push news that changed only store-backed state. Unlike `pushState`, this
   * fully re-renders the snapshot but does not restart the async worktree or
   * gate-option loaders. It also cannot settle a pending dashboard action:
   * store news such as a usage delta is not that action's response.
   */
  pushStoreState(ticketId: number): void {
    pushSnapshot(this.pushDeps, ticketId, {
      kind: 'store',
      supplemental: false,
      live: false,
      settlesActions: false,
    });
  }

  /**
   * Push fresh state to every open panel. Used by background sweeps (e.g. PR
   * status sync) whose result may touch any open ticket, so the caller need not
   * track which ticket changed.
   */
  pushAll(): void {
    for (const ticketId of this.panels.keys()) this.pushState(ticketId);
  }

  openCount(): number { return this.panels.size; }

  /** Whether a panel is currently open for a ticket (for the caller/tests). */
  isOpen(ticketId: number): boolean {
    return this.panels.has(ticketId);
  }

  /** The tickets with a currently open panel, for the external-change watcher. */
  openTicketIds(): number[] {
    return [...this.panels.keys()];
  }
}
