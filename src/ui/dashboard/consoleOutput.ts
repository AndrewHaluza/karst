import type { Store } from '../../store/db.js';
import type { InsideProgressEvent } from '../../model/inside/progress.js';
import { listServersByTicket } from '../../store/dashboard.js';
import type { GateStage } from '../../store/ticketGates.js';
import { parseInsideProgress } from './messages.js';
import type { AgentProcessId, StageLogResult } from './messages.js';
import type {
  AgentLogReader,
  DashboardPanel,
  StageLogReader,
} from './panelTypes.js';
import type { ServerLogsReader } from './serverLogsReader.js';

/**
 * The dashboard's console/log forwarding surface: transient inside-progress
 * events, gate-stage and gate-lane AI console tails, and the combined server
 * log stream. Every method is a thin host-side boundary that resolves the open
 * panel and posts a message — no store mutation, no state building.
 */
export class DashboardConsole {
  constructor(
    private readonly store: Store,
    private readonly panelFor: (ticketId: number) => DashboardPanel | undefined,
    private readonly stageLogReader: StageLogReader | undefined,
    private readonly agentLogReader: AgentLogReader | undefined,
    private readonly serverLogsReader: ServerLogsReader | undefined,
  ) {}

  /**
   * Push a transient inside-progress event to a ticket panel; no-op if not open.
   * Validated at this boundary (`parseInsideProgress`) — the webview is a trust
   * boundary in both directions, and a malformed event must never ship. Live
   * Ship rides this same generic union (Finding 12); there is no ship-specific
   * progress channel.
   */
  postInsideProgress(ticketId: number, event: InsideProgressEvent): void {
    const panel = this.panelFor(ticketId);
    if (!panel) return;
    const validated = parseInsideProgress(event);
    if (validated === null) return;
    panel.postMessage({ type: 'inside-progress', event: validated });
  }

  /**
   * Answer a `stage-log-request`: resolve the log via the injected reader and
   * post the `stage-log` message. The answer IS the terminal outcome — always
   * sent (ok or error), never left to a watchdog (UI-R13).
   */
  requestStageLog(ticketId: number, stage: GateStage): void {
    const panel = this.panelFor(ticketId);
    if (!panel) return;
    const result = this.stageLogReader
      ? this.stageLogReader(ticketId, stage)
      : ({ kind: 'error', message: 'No console log source is configured.' } as StageLogResult);
    panel.postMessage({ type: 'stage-log', stage, result });
  }

  /**
   * Answer an `agent-log-request`: resolve the process's console tail via the
   * injected reader and post the `agent-log` message. The answer IS the
   * terminal outcome — always sent (ok or error), never left to a watchdog
   * (UI-R13).
   */
  requestAgentLog(ticketId: number, processId: AgentProcessId): void {
    const panel = this.panelFor(ticketId);
    if (!panel) return;
    const result = this.agentLogReader
      ? this.agentLogReader(ticketId, processId)
      : ({ kind: 'error', message: 'No console log source is configured.' } as StageLogResult);
    panel.postMessage({ type: 'agent-log', processId, result });
  }

  /**
   * Push one sanitized live chunk of a gate-lane AI process's output to the
   * ticket's panel; no-op if the panel is not open. The text is already
   * sanitized and bounded host-side (the `AgentConsole` sink); this boundary
   * forwards it verbatim to the open terminal view.
   */
  postAgentOutput(ticketId: number, processId: AgentProcessId, text: string): void {
    const panel = this.panelFor(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'agent-output', processId, text });
  }

  /**
   * Push one sanitized live chunk of a gate stage's deterministic gate output
   * to the ticket's panel; no-op if the panel is not open. Sanitized host-side
   * (the `GateConsole` sink); this boundary forwards it verbatim to the open
   * stage console.
   */
  postStageOutput(ticketId: number, stage: GateStage, text: string): void {
    const panel = this.panelFor(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'stage-output', stage, text });
  }

  /**
   * Answer a `server-logs-request`: read all server log files via the injected
   * reader, start polling for live updates, and post the `server-logs` message.
   * The answer IS the terminal outcome — always sent (ok or error), never left
   * to a watchdog (UI-R13).
   */
  requestServerLogs(ticketId: number): void {
    const panel = this.panelFor(ticketId);
    if (!panel) return;
    if (!this.serverLogsReader) {
      panel.postMessage({ type: 'server-logs', servers: [] });
      return;
    }
    const servers = listServersByTicket(this.store, ticketId);
    const logServers = servers.map((s) => ({ service: s.service, logPath: s.logPath }));
    const result = this.serverLogsReader.readLogs(logServers);
    panel.postMessage({ type: 'server-logs', servers: result.servers });
    this.serverLogsReader.startPolling(logServers, ticketId, (tid, service, text) =>
      this.postServerLogOutput(tid, service, text),
    );
  }

  /**
   * Answer a `server-logs-close`: stop polling for server log updates. No-op
   * if the panel is not open or no reader is configured.
   */
  closeServerLogs(ticketId: number): void {
    this.serverLogsReader?.stopPolling(ticketId);
  }

  /**
   * Push one sanitized live chunk of a server's log output to the ticket's
   * panel; no-op if the panel is not open.
   */
  postServerLogOutput(ticketId: number, service: string, text: string): void {
    const panel = this.panelFor(ticketId);
    if (!panel) return;
    panel.postMessage({ type: 'server-log-output', service, text });
  }
}
