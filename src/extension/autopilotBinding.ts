import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { getTicket } from '../store/tickets.js';
import type { AutostartCaps } from '../workflow/subtaskAutostart.js';
import { autopilotSweep, ciOutcome } from './ops/autopilotWiring.js';
import { resolveConflictRound, type ResolveConflictInput } from './ops/conflictResolveOps.js';
import { approveCommand, setOverrideCommand, stopCommand, type AutopilotCommandDeps } from './ops/autopilotCommandOps.js';
import type { AutopilotKind, AutopilotOverride } from '../store/autopilot.js';
import { claimAutopilotTicket } from '../store/autopilot.js';
import type { FixOutcome } from './ops/autopilotOps.js';
import type { CiActionsInput } from './ops/ciActionsWiring.js';

const LEASE_INTERVALS = 3;
const ROUND_COOLDOWN_MS = 120_000;

export interface AutopilotBindingDeps {
  readonly store: Store;
  readonly projectId: () => number | undefined;
  readonly manifest: () => Manifest | undefined;
  readonly caps: () => AutostartCaps;
  readonly debug: (message: string) => void;
  readonly changed: () => void;
  readonly intervalMs: number;
  /** This window holds a live session for the ticket. */
  readonly isLive: (ticketId: number) => boolean;
  readonly roundInput: (ticketId: number, repo: string) => ResolveConflictInput;
  /** The sessions capability is available (the same guard the click applies). Default: yes. */
  readonly canLaunch?: (ticketId: number) => boolean;
  readonly now?: () => number;
  /** This window's lease owner id (unique per window). */
  readonly windowId: string;
  readonly ciInput: (ticketId: number) => CiActionsInput;
}

/**
 * Start the autopilot sweep. Ownership follows the sandbox rule (AC-37): this window controls a
 * ticket when it holds the session, or when no window runs one. "Session running" uses the same data.
 */
export function startAutopilot(d: AutopilotBindingDeps): { dispose(): void } {
  // The engine also refuses a ticket whose stored agent state is running, so only the live-session check lives here.
  const running = (id: number): boolean => d.isLive(id);
  const now = d.now ?? Date.now;
  const owner = d.windowId;
  // A session launch is slow: after a round is sent, the ticket is left alone until the session shows up or the cooldown ends.
  const cooldown = new Map<number, number>();
  const sent = async (id: number, outcome: Promise<FixOutcome>): Promise<FixOutcome> => {
    const result = await outcome;
    if (result.kind === 'sent') cooldown.set(id, now() + ROUND_COOLDOWN_MS);
    return result;
  };
  const cooling = (id: number): boolean => (cooldown.get(id) ?? 0) > now() && !running(id);
  // One sweep at a time: overlapping sweeps must not spend the budget twice.
  let sweeping = false;
  const sweep = (): void => {
    if (sweeping) return;
    sweeping = true;
    void autopilotSweep({
      store: d.store, projectId: d.projectId, manifest: d.manifest, caps: d.caps, debug: d.debug, changed: d.changed,
      seamsFor: (id) => ({
        controls: () => (d.canLaunch?.(id) ?? true) && !cooling(id) && (d.isLive(id) || getTicket(d.store, id).agentState !== 'running')
          && claimAutopilotTicket(d.store, id, owner, now(), d.intervalMs * LEASE_INTERVALS),
        sessionRunning: () => running(id),
        resolveRound: async (repo) => {
          const result = await resolveConflictRound(d.roundInput(id, repo));
          if (result.kind === 'sent') cooldown.set(id, now() + ROUND_COOLDOWN_MS);
          return result;
        },
        sendCi: () => sent(id, ciOutcome(d.ciInput(id))),
      }),
    }).finally(() => { sweeping = false; });
  };
  const timer = setInterval(sweep, d.intervalMs);
  return { dispose: () => clearInterval(timer) };
}

/** The slice of the vscode API the command pickers need (structural, so this file never imports vscode). */
export interface CommandHost {
  readonly commands: { registerCommand(command: string, handler: (...args: never[]) => unknown): { dispose(): void } };
  readonly window: {
    showInformationMessage(message: string): unknown;
    showQuickPick(items: readonly string[], options: { placeHolder: string }): PromiseLike<string | undefined>;
    showQuickPick<T extends { label: string }>(items: readonly T[], options: { placeHolder: string }): PromiseLike<T | undefined>;
  };
}

/** Register the three autopilot host commands. */
export function registerAutopilotCommands(
  host: CommandHost,
  base: Pick<AutopilotCommandDeps, 'store' | 'projectId' | 'debug' | 'stopSession'>,
): Array<{ dispose(): void }> {
  const d: AutopilotCommandDeps = {
    ...base,
    say: (m) => void host.window.showInformationMessage(m),
    pickTicket: async (picks, placeHolder) => (await host.window.showQuickPick(picks, { placeHolder }))?.ticketId,
    pick: async <T extends string>(choices: readonly T[], placeHolder: string) => (await host.window.showQuickPick(choices, { placeHolder })) as T | undefined,
  };
  const reg = host.commands.registerCommand.bind(host.commands);
  return [
    reg('karst.autopilot.setOverride', (ticketId?: number, mode?: AutopilotOverride) => setOverrideCommand(d, ticketId, mode)),
    reg('karst.autopilot.approveOne', (ticketId?: number, target?: { repo: string; kind: AutopilotKind }) => approveCommand(d, ticketId, target)),
    reg('karst.autopilot.stop', (ticketId?: number, when?: 'after-round' | 'now') => stopCommand(d, ticketId, when)),
  ];
}
