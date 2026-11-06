import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { getTicket } from '../store/tickets.js';
import type { AutostartCaps } from '../workflow/subtaskAutostart.js';
import { autopilotSweep, ciOutcome } from './ops/autopilotWiring.js';
import { resolveConflictRound, type ResolveConflictInput } from './ops/conflictResolveOps.js';
import { approveCommand, setOverrideCommand, stopCommand, type AutopilotCommandDeps } from './ops/autopilotCommandOps.js';
import type { AutopilotKind, AutopilotOverride } from '../store/autopilot.js';
import { claimAutopilotTicket } from '../store/autopilot.js';
import { readSetupFailure } from '../agent/sandboxSetup.js';
import type { FixOutcome } from './ops/autopilotOps.js';
import type { SessionOutcome } from './ops/startOutcome.js';
import type { CiActionsInput } from './ops/ciActionsWiring.js';

/**
 * Tracks the session launch a hand-off started, so autopilot can read a failed launch
 * (read-only sandbox, setup failure) as an environment blocker instead of a sent round.
 */
export function makeLaunchTracker(
  execute: (ticketId: number, options: { seedPrompt: string; seedRepo: string; failClosed?: true }) => Promise<SessionOutcome | undefined>,
): {
  open(ticketId: number, seedPrompt: string, seedRepo: string): void;
  take(ticketId: number): Promise<SessionOutcome | undefined> | undefined;
  /** While an autopilot round runs for a ticket, its launch fails closed (no sandbox host-fallback prompt, AC-31). A manual click keeps its prompt. */
  markRound(ticketId: number, on: boolean): void;
} {
  const pending = new Map<number, Promise<SessionOutcome | undefined>>();
  const rounds = new Set<number>();
  return {
    markRound: (ticketId, on) => { if (on) rounds.add(ticketId); else rounds.delete(ticketId); },
    open: (ticketId, seedPrompt, seedRepo) => {
      pending.set(ticketId, execute(ticketId, { seedPrompt, seedRepo, ...(rounds.has(ticketId) ? { failClosed: true as const } : {}) }).catch((err: unknown): SessionOutcome => ({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) })));
    },
    take: (ticketId) => { const p = pending.get(ticketId); pending.delete(ticketId); return p; },
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
  readonly roundInput: (ticketId: number, repo: string) => ResolveConflictInput;
  /** The sessions capability is available (the same guard the click applies). Default: yes. */
  readonly canLaunch?: (ticketId: number) => boolean;
  readonly now?: () => number;
  /** This window's lease owner id (unique per window). */
  readonly windowId: string;
  readonly ciInput: (ticketId: number) => CiActionsInput;
  /** Take the pending session launch the last hand-off started for the ticket (undefined: a nudge, no launch). */
  readonly takeLaunch: (ticketId: number) => Promise<SessionOutcome | undefined> | undefined;
  /** Marks the ticket while an autopilot round may open its session: that launch never offers the sandbox host fallback (AC-31). */
  readonly roundLaunching?: (ticketId: number, on: boolean) => void;
  /** A recorded sandbox environment blocker that no retry can fix (a failed dependency setup, AC-47), or null. */
  readonly envBlocker?: (ticketId: number) => Promise<string | null>;
  /** The ticket's recorded sandbox setup state file (undefined for a host ticket); read when no `envBlocker` is given. */
  readonly setupStateFile?: (ticketId: number) => string | undefined;
}

async function envBlockerOf(d: AutopilotBindingDeps, id: number): Promise<string | null> {
  if (d.envBlocker) return d.envBlocker(id);
  const file = d.setupStateFile?.(id);
  return file ? readSetupFailure(file) : null;
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
  /** A round is only sent when the opened session launched: a failed launch is an environment blocker (never a host fallback). */
  const launchFailure = async (id: number): Promise<string | null> => {
    const outcome = await d.takeLaunch(id);
    return outcome?.kind === 'failed' ? outcome.reason : null;
  };
  const sent = async (id: number, outcome: () => Promise<FixOutcome>): Promise<FixOutcome> => {
    if (!beginRound(id)) return { kind: 'lease-lost' };
    d.roundLaunching?.(id, true);
    try {
      const blocker = await envBlockerOf(d, id);
      if (blocker) { abandonRound(id); return { kind: 'env-blocker', reason: blocker }; }
      const result = await outcome();
      if (result.kind !== 'sent') { abandonRound(id); return result; }
      const failure = await launchFailure(id);
      // The CI hand-off already moved the ticket to Implement: the cooldown stays, the engine pauses with a visible reason.
      if (failure !== null) return { kind: 'env-blocker', reason: `session launch failed: ${failure}` };
      return result;
    } finally {
      d.roundLaunching?.(id, false);
    }
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
          if (!beginRound(id)) return { kind: 'refused', cause: 'lease-lost', message: 'lease lost', reason: 'lease lost' };
          // The conflict hand-off may open a session: that launch fails closed too (no host-fallback prompt, AC-31).
          d.roundLaunching?.(id, true);
          try {
            const blocker = await envBlockerOf(d, id);
            if (blocker) { abandonRound(id); return { kind: 'refused', cause: 'sandbox-sync', message: blocker, reason: blocker }; }
            const result = await resolveConflictRound(d.roundInput(id, repo));
            if (result.kind !== 'sent') { abandonRound(id); return result; }
            const failure = await launchFailure(id);
            if (failure !== null) {
              abandonRound(id);
              const reason = `session launch failed: ${failure}`;
              return { kind: 'refused', cause: 'launch-failed', message: reason, reason };
            }
            return result;
          } finally {
            d.roundLaunching?.(id, false);
          }
        },
        sendCi: () => sent(id, () => ciOutcome(d.ciInput(id))),
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
