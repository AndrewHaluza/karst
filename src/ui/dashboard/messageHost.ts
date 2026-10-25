import type { ActionResultMessage } from '../../model/actionResult.js';
import type { LiveClocks } from './liveTick.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { InsideProgressEvent } from '../../model/inside/progress.js';
import type { DashboardState } from './state.js';
import type { WorktreeStats } from './worktreeStats.js';
import type { GateOptions } from './gateOptions.js';
import type { StageLogResult, AgentProcessId } from './messages.js';

/**
 * One server's log content as the logs surface receives it. The standalone
 * server-logs panel imports this rather than redeclaring the shape, so the two
 * hosts can never drift.
 */
export type ServerLogEntry = { service: string; content: string; truncated: boolean };

/**
 * Host → webview messages. `state` pushes drive the stepper + panels;
 * `inside-progress` overlays live process events (gates, Fix, and Ship — the
 * ship lifecycle rides this same union, Finding 12); `bind` carries the
 * window's terminal-binding preference, which is host-owned and likewise
 * absent from `DashboardState`.
 */
export type HostMessage =
  | {
      type: 'state';
      state: DashboardState;
      /** Clock-only repaint; the webview may defer it during interaction. */
      live?: boolean;
      /** False when no worktree/gate-options follow this state message. */
      supplemental?: boolean;
      /** False when this snapshot must not settle requestless actions. */
      settlesActions?: boolean;
    }
  | { type: 'worktree-stats'; stats: WorktreeStats[] }
  | { type: 'inside-progress'; event: InsideProgressEvent }
  | { type: 'bind'; enabled: boolean }
  /**
   * The togglable gate names for this ticket. Its own message, not part of
   * `DashboardState`, because resolving it probes the filesystem and
   * `buildDashboardState` is synchronous — same split as `worktree-stats`.
   */
  | { type: 'gate-options'; options: GateOptions }
  /**
   * The answer to `stage-log-request`: the console log content for one gate
   * stage, or a named refusal. The `result` union is closed — the webview
   * renders exactly these two shapes. `truncated` is true when the file was
   * cut at the read cap (defensive; the recording itself caps at 1 MiB).
   */
  | { type: 'stage-log'; stage: GateStage; result: StageLogResult }
  /** The answer to `xterm-request`: the bundle text, or null when unavailable. */
  | { type: 'xterm'; js: string | null }
  /**
   * A live repaint whose snapshot changed only in its clocks — the clock text
   * per stage, merged by the webview into the snapshot it holds (liveTick.ts).
   */
  | { type: 'clocks'; clocks: LiveClocks }
  /**
   * The answer to `agent-log-request`: the console tail for one gate-lane AI
   * process, or a named refusal. Same closed `result` union as `stage-log`.
   */
  | { type: 'agent-log'; processId: AgentProcessId; result: StageLogResult }
  /**
   * A live chunk of one gate-lane AI process's console output, pushed while
   * the process runs. The text is already sanitized and bounded host-side (the
   * `AgentConsole` sink); the webview appends it to the open terminal for that
   * process only.
   */
  | { type: 'agent-output'; processId: AgentProcessId; text: string }
  /**
   * A live chunk of a gate STAGE's deterministic gate output, pushed while the
   * gates run. Sanitized host-side (the `GateConsole` sink); the webview
   * appends it to the open console for that stage only — the durable record
   * stays the stage artifact the post-run `stage-log` answer reads.
   */
  | { type: 'stage-output'; stage: GateStage; text: string }
  /**
   * The answer to `server-logs-request`: all server log contents for this ticket.
   * `servers` is the ordered list matching the dashboard's server rows. The
   * webview renders the initial content immediately and starts the merged view.
   */
  | { type: 'server-logs'; servers: ServerLogEntry[] }
  /**
   * A live chunk of one server's log output, pushed while polling. The webview
   * appends it to that server's log buffer and, if the merged view is active,
   * interleaves it into the chronological view.
   */
  | { type: 'server-log-output'; service: string; text: string }
  | ActionResultMessage;
