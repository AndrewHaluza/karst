import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { getTicket } from '../store/tickets.js';
import type { AutostartCaps } from '../workflow/subtaskAutostart.js';
import { autopilotSweep, ciOutcome } from './ops/autopilotWiring.js';
import { approveCommand, setOverrideCommand, stopCommand, type AutopilotCommandDeps } from './ops/autopilotCommandOps.js';
import type { AutopilotKind, AutopilotOverride } from '../store/autopilot.js';
import { claimAutopilotTicket, getAutopilotSessionOwner, syncAutopilotSessionOwner } from '../store/autopilot.js';
import type { FixOutcome } from './ops/autopilotOps.js';
import type { SessionOutcome } from './ops/startOutcome.js';
import type { CiActionsInput } from './ops/ciActionsWiring.js';

/** Tracks the session launch a hand-off started, so autopilot can read a failed launch as a failed round instead of a sent one. */
export function makeLaunchTracker(
  execute: (ticketId: number, options: { seedPrompt: string; seedRepo: string }) => Promise<SessionOutcome | undefined>,
): {
  open(ticketId: number, seedPrompt: string, seedRepo: string): void;
  take(ticketId: number): Promise<SessionOutcome | undefined> | undefined;
} {
  const pending = new Map<number, Promise<SessionOutcome | undefined>>();
  return {
    open: (ticketId, seedPrompt, seedRepo) => {
      pending.set(ticketId, execute(ticketId, { seedPrompt, seedRepo }).catch((err: unknown): SessionOutcome => ({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) })));
    },
    take: (ticketId) => { const p = pending.get(ticketId); pending.delete(ticketId); return p; },
  };
}

const WINDOW_ID_KEY = 'karst.windowId';

/** This window's stable id: it names the window that holds a ticket's session in the shared store. */
export function stableWindowId(
  state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> },
  make: () => string,
): string {
  const id = state.get<string>(WINDOW_ID_KEY) ?? make();
  void state.update(WINDOW_ID_KEY, id);
  return id;
}

/** Write the sessions this window holds into the shared store, so another window starts no round beside them. */
export function makeSessionOwnerSync(
  store: Store,
  windowId: string,
  logError: (message: string, err: unknown) => void,
): (ownedTicketIds: readonly number[]) => void {
  return (ids) => {
    try { syncAutopilotSessionOwner(store, windowId, ids); } catch (err) { logError('karst: session owner sync failed', err); }
  };
}

/** A sandboxed ticket gets no round. A placement that cannot be read is not a host ticket either (D482). */
export function makeHostTicketCheck(
  probe: (ticketId: number) => Promise<{ state: string }> | undefined,
): (ticketId: number) => Promise<boolean> {
  return async (id) => ((await probe(id)) ?? { state: 'absent' }).state === 'absent';
}

/** Stop now: only the window that holds the session can end it. Another window reports that the stop did not reach it. */
export function makeStopSession(d: {
  isLive: (ticketId: number) => boolean;
  stop: (ticketId: number) => Promise<void>;
  debug: (message: string) => void;
}): (ticketId: number) => Promise<boolean> {
  return async (id) => {
    if (!d.isLive(id)) { d.debug(`[ship] autopilot ticket ${id}: stop now did not reach a session (this window does not hold it)`); return false; }
    await d.stop(id);
    return true;
  };
}

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
  /** The sessions capability is available (the same guard the click applies). Default: yes. */
  readonly canLaunch?: (ticketId: number) => boolean;
  readonly now?: () => number;
  /** This window's lease owner id (unique per window). */
  readonly windowId: string;
  readonly ciInput: (ticketId: number) => CiActionsInput;
  /** Take the pending session launch the last hand-off started for the ticket (undefined: a nudge, no launch). */
  readonly takeLaunch: (ticketId: number) => Promise<SessionOutcome | undefined> | undefined;
  /** The ticket runs on the host (no sandbox, placement readable). */
  readonly isHostTicket: (ticketId: number) => Promise<boolean>;
}

/**
 * Start the autopilot sweep. This window controls a ticket when it holds the session, or when the store shows that no
 * window holds one. When the holder is not known, no round starts (a closed terminal also sets agent_state 'idle').
 */
export function startAutopilot(d: AutopilotBindingDeps): { dispose(): void } {
  const now = d.now ?? Date.now;
  const owner = d.windowId;
  // An open terminal with an idle or waiting agent is not a running session: it must not block a round or a park.
  // The engine also refuses a ticket whose stored agent state is running (another window).
  const running = (id: number): boolean => d.isLive(id) && getTicket(d.store, id).agentState === 'running';
  /** Who holds the session: this window, another window, nobody, or unknown (the agent is active but the store names no window). */
  const holder = (id: number): 'self' | 'other' | 'none' | 'unknown' => {
    if (d.isLive(id)) return 'self';
    const stored = getAutopilotSessionOwner(d.store, id);
    if (stored !== null && stored !== owner) return 'other';
    const state = getTicket(d.store, id).agentState;
    if (state === 'running' || state === 'waiting') {
      d.debug(`[ship] autopilot ticket ${id}: no round, the window that holds the session is not known`);
      return 'unknown';
    }
    return 'none';
  };
  // A session launch is slow: after a round is sent, the ticket is left alone until the session shows up or the cooldown ends.
  const cooldown = new Map<number, number>();
  // The lease and the cooldown start WITH the round, not after it: a slow round must not let the lease lapse or a second tick start.
  const beginRound = (id: number): boolean => {
    if (!claimAutopilotTicket(d.store, id, owner, now(), ROUND_COOLDOWN_MS)) return false;
    cooldown.set(id, now() + ROUND_COOLDOWN_MS);
    // A launch record left by an earlier hand-off must not read as this round's failure.
    void d.takeLaunch(id);
    return true;
  };
  /** A round that did not go out frees the ticket: drop the cooldown and shrink the lease back to the normal interval. */
  const abandonRound = (id: number): void => {
    cooldown.delete(id);
    claimAutopilotTicket(d.store, id, owner, now(), d.intervalMs * LEASE_INTERVALS);
  };
  /** A round is only sent when the opened session launched. A launch queued for memory or cancelled is not a failure. */
  const launchFailure = async (id: number): Promise<string | null> => {
    const outcome = await d.takeLaunch(id);
    return outcome?.kind === 'failed' ? outcome.reason : null;
  };
  const sent = async (id: number, outcome: () => Promise<FixOutcome>): Promise<FixOutcome> => {
    if (!beginRound(id)) return { kind: 'lease-lost' };
    const result = await outcome();
    if (result.kind !== 'sent') { abandonRound(id); return result; }
    const failure = await launchFailure(id);
    // The CI hand-off already moved the ticket to Implement: the cooldown stays, the engine pauses with a visible reason.
    return failure !== null ? { kind: 'failed', reason: `session launch failed: ${failure}` } : result;
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
        controls: () => (d.canLaunch?.(id) ?? true) && !cooling(id) && ['self', 'none'].includes(holder(id))
          && claimAutopilotTicket(d.store, id, owner, now(), d.intervalMs * LEASE_INTERVALS),
        sessionRunning: () => running(id),
        isHostTicket: () => d.isHostTicket(id),
        sendCi: () => sent(id, () => ciOutcome(d.ciInput(id))),
      }),
    }).catch((err: unknown) => d.debug(`[ship] autopilot sweep failed: ${err instanceof Error ? err.message : String(err)}`)).finally(() => { sweeping = false; });
  };
  const timer = setInterval(sweep, d.intervalMs);
  return { dispose: () => clearInterval(timer) };
}

/** The slice of the vscode API the command pickers need (structural, so this file never imports vscode). */
export interface CommandHost {
  readonly commands: { registerCommand(command: string, handler: (...args: never[]) => unknown): { dispose(): void } };
  readonly window: {
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
    say: (m) => base.debug(`[ship] autopilot command: ${m}`),
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
