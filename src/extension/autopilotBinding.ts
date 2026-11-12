import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { getTicket } from '../store/tickets.js';
import type { AutostartCaps } from '../workflow/subtaskAutostart.js';
import { autopilotSweep, ciOutcome, conflictOutcome, postAutopilotNote } from './ops/autopilotWiring.js';
import type { ResolveConflictInput } from './ops/conflictResolveOps.js';
import { approveCommand, retryCommand, setOverrideCommand, stopCommand, type AutopilotCommandDeps } from './ops/autopilotCommandOps.js';
import type { AutopilotKind, AutopilotOverride } from '../store/autopilot.js';
import { claimAutopilotTicket, getAutopilotSessionOwner, syncAutopilotSessionOwner } from '../store/autopilot.js';
import { roundDied, type FixOutcome, type Placement } from './ops/autopilotOps.js';
import type { SessionOutcome } from './ops/startOutcome.js';
import type { CiActionsInput } from './ops/ciActionsWiring.js';
import type { GhRunner } from '../integrations/github.js';
import { makeTransientCiSeams } from '../integrations/ciRerun.js';
import { rebaseOnBaseAction } from './ops/ciActionsWiring.js';
import { regenerateCommand, type RegenerateEntry } from '../workflow/gates/regenerate.js';
import type { StaleRebaseSeams } from './ops/autopilotStaleRebase.js';

/** Tracks the session launch a hand-off started, so autopilot can read a failed launch as a failed round instead of a sent one. */
export function makeLaunchTracker(
  execute: (ticketId: number, options: { seedPrompt: string; seedRepo: string; failClosed?: true }) => Promise<SessionOutcome | undefined>,
): {
  open(ticketId: number, seedPrompt: string, seedRepo: string): void;
  take(ticketId: number): Promise<SessionOutcome | undefined> | undefined;
  /** While on, a launch opened for the ticket is an Autopilot round: it never falls back to the host (arch:AC-31). */
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

/**
 * Where a ticket runs, from its recorded placement (arch:AC-43). A ticket with no recorded placement rejects: a sandbox
 * that is not listed (stopped, CLI down) must not read as a host, so the engine parks instead of guessing.
 */
export function makePlacementCheck(
  placementOf: (ticketId: number) => { readonly backend: string } | null,
): (ticketId: number) => Promise<Placement> {
  return async (id) => {
    const recorded = placementOf(id);
    if (recorded === null) throw new Error('no placement is recorded for the ticket');
    return recorded.backend === 'host' ? 'host' : 'sandbox';
  };
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

/**
 * The pre-hand-off check of a sandboxed round: the pre-round two-way sync (a dirty or diverged clone blocks, arch:AC-46),
 * then the recorded dependency setup (a failed setup blocks, arch:AC-47). Returns the blocker reason, or null.
 */
export function makeSandboxPreflight(h: {
  ensureInSync: (ticketId: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
  setupFailure: (ticketId: number) => Promise<string | null>;
}): (ticketId: number) => Promise<string | null> {
  return async (id) => {
    const synced = await h.ensureInSync(id);
    if (!synced.ok) return synced.reason;
    return h.setupFailure(id);
  };
}

/** The `ship.regenerate` commands of a repository (T1081). */
export const regenerateEntries = (m: Manifest | undefined, repo: string): readonly RegenerateEntry[] =>
  m?.repositories[repo]?.ship?.regenerate ?? [];
const regenerateCommands = (m: Manifest | undefined, repo: string): readonly string[] => regenerateEntries(m, repo).map(regenerateCommand);

/** The seams of the one rebase for a stale generated file: the gh log and head reads of the re-run, plus Rebase on base. */
function makeStaleRebaseSeams(gh: GhRunner, regenerate: (repo: string) => readonly string[], rebase: (repo: string) => Promise<boolean>): StaleRebaseSeams {
  const { readJobLog, readRunHeadSha } = makeTransientCiSeams(gh);
  return { readJobLog, readRunHeadSha, regenerate, rebase };
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
  /** The Resolve conflicts click path for one repo, with the hand-off bound to the launch tracker. */
  readonly conflictInput: (ticketId: number, repo: string) => ResolveConflictInput;
  /** A conflict round is armed for the ticket, or karst delivers its resolved merge now. */
  readonly conflictRoundActive: (ticketId: number) => boolean;
  readonly conflictRoundStalled: (ticketId: number) => boolean;
  readonly dropConflictRound: (ticketId: number) => void;
  /** Take the pending session launch the last hand-off started for the ticket (undefined: a nudge, no launch). */
  readonly takeLaunch: (ticketId: number) => Promise<SessionOutcome | undefined> | undefined;
  /** Host or sandbox, from the recorded placement; rejects when none is recorded. */
  readonly placement: (ticketId: number) => Promise<Placement>;
  /** Sandbox tickets: the blocker reason before a hand-off (clone sync, dependency setup), or null. */
  readonly sandboxPreflight?: (ticketId: number) => Promise<string | null>;
  /** Marks the ticket's next launches as Autopilot rounds (fail closed). Default: no mark. */
  readonly markRound?: (ticketId: number, on: boolean) => void;
  /** The gh runner of the one re-run of a transient CI failure (T1019). Absent: no re-run. */
  readonly gh?: GhRunner;
}

/**
 * Start the autopilot sweep. This window controls a ticket when it holds the session, or when the store shows that no
 * window holds one. When the holder is not known, no round starts (a closed terminal also sets agent_state 'idle').
 */
export function startAutopilot(d: AutopilotBindingDeps): {
  dispose(): void;
  /** This window controls the ticket (arch:AC-37): it holds the session, or the store shows that no window does. No lease is taken. */
  controlsTicket(ticketId: number): boolean;
  /** A round's session died right after launch (reported by the launch-failure path): undo the round, pause, no retry. */
  roundDied(ticketId: number, detail: string): void;
} {
  const now = d.now ?? Date.now;
  const owner = d.windowId;
  // A live session whose agent runs, or waits on a permission prompt or a question, is in use: no round. An open terminal
  // with an idle agent is not. The engine also refuses a ticket whose stored agent state is running (another window).
  const running = (id: number): boolean => {
    if (!d.isLive(id)) return false;
    const state = getTicket(d.store, id).agentState;
    return state === 'running' || state === 'waiting';
  };
  /** Who holds the session: this window, another window, nobody, or unknown (the agent is active but the store names no window). */
  const holder = (id: number): 'self' | 'other' | 'none' | 'unknown' => {
    if (d.isLive(id)) return 'self';
    const stored = getAutopilotSessionOwner(d.store, id);
    if (stored !== null && stored !== owner) {
      d.debug(`[ship] autopilot ticket ${id}: no round, window ${stored} holds the session (a closed window leaves its row until a window syncs)`);
      return 'other';
    }
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
    if (failure === null) return result;
    // A launch that failed for a sandboxed ticket (read-only sandbox, setup failure, no sandbox backend) is an environment
    // blocker, not an agent failure (arch:AC-31). The CI hand-off already moved the ticket to Implement: the cooldown stays.
    const placed = await d.placement(id).catch((): Placement => 'host');
    return placed === 'sandbox' ? { kind: 'env-blocker', reason: failure } : { kind: 'failed', reason: `session launch failed: ${failure}` };
  };
  const sentRound = async (id: number, outcome: () => Promise<FixOutcome>): Promise<FixOutcome> => {
    d.markRound?.(id, true);
    try { return await sent(id, outcome); } finally { d.markRound?.(id, false); }
  };
  // The Rebase on base of a stale generated file (T1081) takes longer than the sweep lease: hold the ticket for a whole round,
  // so a second window starts no CI round meanwhile, then give the short lease back.
  const rebaseHeld = async (id: number, run: () => Promise<boolean>): Promise<boolean> => {
    if (!claimAutopilotTicket(d.store, id, owner, now(), ROUND_COOLDOWN_MS)) return false;
    try { return await run(); } finally { claimAutopilotTicket(d.store, id, owner, now(), d.intervalMs * LEASE_INTERVALS); }
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
        placement: () => d.placement(id),
        ...(d.sandboxPreflight ? { sandboxPreflight: () => d.sandboxPreflight!(id) } : {}),
        sendCi: () => sentRound(id, () => ciOutcome(d.ciInput(id))),
        sendConflict: (repo) => sentRound(id, () => conflictOutcome(d.conflictInput(id, repo))),
        conflictRoundActive: () => d.conflictRoundActive(id),
        conflictRoundStalled: () => d.conflictRoundStalled(id),
        dropConflictRound: () => d.dropConflictRound(id),
        ...(d.gh ? { transientCi: makeTransientCiSeams(d.gh) } : {}),
        ...(d.gh ? { staleRebase: makeStaleRebaseSeams(d.gh, (repo) => regenerateCommands(d.manifest(), repo), (repo) => rebaseHeld(id, () => rebaseOnBaseAction(d.ciInput(id), (r) => regenerateEntries(d.manifest(), r), { repos: new Set([repo]) }))) } : {}),
      }),
    }).catch((err: unknown) => d.debug(`[ship] autopilot sweep failed: ${err instanceof Error ? err.message : String(err)}`)).finally(() => { sweeping = false; });
  };
  const timer = setInterval(sweep, d.intervalMs);
  return {
    controlsTicket: (id) => (d.canLaunch?.(id) ?? true) && ['self', 'none'].includes(holder(id)),
    roundDied: (id, detail) => {
      const projectId = d.projectId();
      const key = getTicket(d.store, id).key ?? String(id);
      const result = roundDied({
        store: d.store, ticketId: id, key, debug: d.debug, dropConflictRound: () => d.dropConflictRound(id),
        note: (title, body) => { if (projectId !== undefined) postAutopilotNote(d.store, projectId, id, title, body, d.debug); },
      }, detail);
      cooldown.delete(id);
      if (result !== null) d.changed();
    },
    dispose: () => {
      clearInterval(timer);
      // A window that closes releases its session rows, so another window does not wait for a holder that is gone.
      try { syncAutopilotSessionOwner(d.store, owner, []); } catch (err) { d.debug(`[ship] autopilot: release of the session rows failed (${err instanceof Error ? err.message : String(err)})`); }
    },
  };
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
  base: Pick<AutopilotCommandDeps, 'store' | 'projectId' | 'debug' | 'stopSession' | 'dropConflictRound'>,
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
    reg('karst.autopilot.retry', (ticketId?: number) => retryCommand(d, ticketId)),
    reg('karst.autopilot.stop', (ticketId?: number, when?: 'after-round' | 'now') => stopCommand(d, ticketId, when)),
  ];
}
