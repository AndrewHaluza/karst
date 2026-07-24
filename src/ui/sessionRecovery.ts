import type {
  RestoredRecoveryResult,
  RestoredSessionDisposition,
} from './session.js';
import { randomUUID } from 'node:crypto';

/** The liveness check needed while reopening a restored terminal. */
export interface SessionLiveness {
  isOpen(ticketId: number): boolean;
}

/** The observed result of attempting to reopen a restored agent session. */
export type RestoredSessionOpenResult =
  | { kind: 'opened' }
  | { kind: 'not-open' }
  | { kind: 'closed' }
  | { kind: 'timed-out' }
  | { kind: 'interrupted' }
  | { kind: 'rejected'; error: unknown };

type ReadinessResult = Extract<
  RestoredSessionOpenResult,
  { kind: 'opened' | 'closed' | 'timed-out' | 'interrupted' }
>;

interface PendingReadiness {
  launchId: string;
  result?: ReadinessResult;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<ReadinessResult>;
  resolve(result: ReadinessResult): void;
}

interface ReadinessWait {
  promise: Promise<ReadinessResult>;
  result(): ReadinessResult | undefined;
  cancel(): void;
}

/** Serializes durable state snapshots and exposes an awaitable flush boundary. */
export class SerializedStateWriter<T> {
  private queued: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: (value: T) => PromiseLike<void>,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  enqueue(value: T): Promise<void> {
    this.queued = this.queued
      .then(() => this.write(value))
      .catch((error) => {
        this.onError(error);
      });
    return this.queued;
  }

  flush(): Promise<void> {
    return this.queued;
  }
}

/**
 * Bridges the synchronous terminal-launch path to the authoritative lifecycle
 * hook. A terminal object only proves that VS Code accepted creation; it does
 * not prove the agent process reached SessionStart or can accept input.
 */
export class SessionRecoveryLifecycle {
  private readonly pending = new Map<number, PendingReadiness>();
  private readonly activeLaunches = new Map<number, string>();
  private readonly retiredLaunches = new Set<string>();
  private readonly blockUnidentified = new Set<number>();

  constructor(
    private readonly timeoutMs = 15_000,
    private readonly maxRetiredLaunches = 256,
  ) {}

  begin(ticketId: number): ReadinessWait {
    this.cancel(ticketId);
    const launchId = randomUUID();
    this.activeLaunches.set(ticketId, launchId);
    this.blockUnidentified.delete(ticketId);

    let resolve!: (result: ReadinessResult) => void;
    const promise = new Promise<ReadinessResult>((done) => {
      resolve = done;
    });
    const pending: PendingReadiness = {
      launchId,
      promise,
      resolve,
      timer: setTimeout(() => {
        if (pending.result) return;
        pending.result = { kind: 'timed-out' };
        pending.resolve(pending.result);
      }, this.timeoutMs),
    };
    this.pending.set(ticketId, pending);

    return {
      promise,
      result: () => pending.result,
      cancel: () => {
        if (this.pending.get(ticketId) !== pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(ticketId);
      },
    };
  }

  /** The generation a new terminal for this ticket must put in its hook URL. */
  currentLaunchId(ticketId: number): string | undefined {
    return this.activeLaunches.get(ticketId);
  }

  /** Allocate a generation for an ordinary (non-recovery) session launch. */
  startLaunch(ticketId: number): string {
    const pending = this.pending.get(ticketId);
    if (pending) return pending.launchId;
    const launchId = randomUUID();
    this.activeLaunches.set(ticketId, launchId);
    this.blockUnidentified.delete(ticketId);
    return launchId;
  }

  sessionStarted(ticketId: number, launchId: string | undefined): void {
    const pending = this.pending.get(ticketId);
    if (
      !pending ||
      pending.result ||
      launchId === undefined ||
      launchId !== pending.launchId ||
      !this.isCurrentHook(ticketId, launchId)
    ) {
      return;
    }
    clearTimeout(pending.timer);
    pending.result = { kind: 'opened' };
    pending.resolve(pending.result);
  }

  sessionClosed(ticketId: number, launchId: string | undefined): void {
    if (launchId !== undefined) {
      this.rememberRetired(launchId);
      if (this.activeLaunches.get(ticketId) === launchId) {
        this.activeLaunches.delete(ticketId);
      }
    }
    const pending = this.pending.get(ticketId);
    if (!pending || launchId !== pending.launchId) return;
    clearTimeout(pending.timer);
    // A close wins even when SessionStart raced just ahead of it but the command
    // has not completed yet. The replacement is not usable in that ordering.
    const firstResult = pending.result === undefined;
    pending.result = { kind: 'closed' };
    if (firstResult) pending.resolve(pending.result);
  }

  /** Quarantine hooks from a failed replacement until its terminal closes. */
  retire(ticketId: number): void {
    const launchId = this.activeLaunches.get(ticketId);
    if (launchId !== undefined) {
      this.rememberRetired(launchId);
      this.activeLaunches.delete(ticketId);
    }
    this.blockUnidentified.add(ticketId);
  }

  isCurrentHook(ticketId: number, launchId: string | undefined): boolean {
    if (launchId !== undefined && this.retiredLaunches.has(launchId)) {
      return false;
    }
    const activeLaunch = this.activeLaunches.get(ticketId);
    if (activeLaunch !== undefined) return launchId === activeLaunch;
    if (launchId === undefined && this.blockUnidentified.has(ticketId)) {
      return false;
    }
    return true;
  }

  /** Resolve every readiness waiter before extension teardown closes the store. */
  shutdown(): void {
    for (const [ticketId, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (!pending.result || pending.result.kind === 'opened') {
        const unresolved = pending.result === undefined;
        pending.result = { kind: 'interrupted' };
        if (unresolved) pending.resolve(pending.result);
      }
      this.blockUnidentified.add(ticketId);
    }
    for (const [ticketId, launchId] of this.activeLaunches) {
      this.rememberRetired(launchId);
      this.blockUnidentified.add(ticketId);
    }
    this.activeLaunches.clear();
  }

  private rememberRetired(launchId: string): void {
    this.retiredLaunches.delete(launchId);
    this.retiredLaunches.add(launchId);
    while (this.retiredLaunches.size > this.maxRetiredLaunches) {
      const oldest = this.retiredLaunches.values().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.retiredLaunches.delete(oldest);
    }
  }

  private cancel(ticketId: number): void {
    const pending = this.pending.get(ticketId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(ticketId);
  }
}

/**
 * Launch a replacement and wait for its SessionStart hook. Command completion
 * and a terminal map entry are necessary but insufficient readiness signals.
 */
export async function resumeRestoredSession(
  sessions: SessionLiveness,
  lifecycle: SessionRecoveryLifecycle,
  ticketId: number,
  open: (ticketId: number) => PromiseLike<unknown>,
): Promise<RestoredSessionOpenResult> {
  const readiness = lifecycle.begin(ticketId);
  try {
    try {
      await open(ticketId);
    } catch (error) {
      const observed = readiness.result();
      if (observed?.kind === 'interrupted') return observed;
      return { kind: 'rejected', error };
    }

    const observed = readiness.result();
    if (observed?.kind === 'closed' || observed?.kind === 'interrupted') {
      return observed;
    }
    if (!sessions.isOpen(ticketId)) return { kind: 'not-open' };
    if (observed) return observed;
    return await readiness.promise;
  } finally {
    readiness.cancel();
  }
}

export interface RecoverySessions extends SessionLiveness {
  disposeSession(ticketId: number): void;
}

/**
 * Complete one replacement attempt, quarantining and disposing any terminal
 * that failed readiness so late hooks cannot revive its DB liveness.
 */
export async function recoverSession(
  sessions: RecoverySessions,
  lifecycle: SessionRecoveryLifecycle,
  ticketId: number,
  open: (ticketId: number) => PromiseLike<unknown>,
): Promise<RestoredSessionOpenResult> {
  const outcome = await resumeRestoredSession(
    sessions,
    lifecycle,
    ticketId,
    open,
  );
  if (outcome.kind !== 'opened' && sessions.isOpen(ticketId)) {
    lifecycle.retire(ticketId);
    try {
      sessions.disposeSession(ticketId);
    } catch (error) {
      // Retirement is best-effort cleanup after a recovery failure. Preserve
      // that failure as a result so the caller still applies its idle,
      // ownership-removal, persistence, logging, and UI-refresh fallback.
      return { kind: 'rejected', error };
    }
  }
  return outcome;
}

export interface RecoveryCandidate {
  id: number;
  agentState: string | null;
  canResume: boolean;
  hasWorktree: boolean;
}

export interface BackgroundRecoveryResult extends RestoredRecoveryResult {
  /** Persisted ownership that no longer has active DB liveness in this window. */
  discard: number[];
}

export type RecoveryOutcomeDisposition =
  | 'ready'
  | 'retry-next-activation'
  | 'abandon';

/** Decide whether recovery completion may clear durable ownership and liveness. */
export function recoveryOutcomeDisposition(
  outcome: RestoredSessionOpenResult,
): RecoveryOutcomeDisposition {
  if (outcome.kind === 'opened') return 'ready';
  if (outcome.kind === 'interrupted') return 'retry-next-activation';
  return 'abandon';
}

export type SessionOwnershipAction = 'add' | 'remove' | 'keep';

/**
 * Keep the per-window recovery registry aligned with hooks handled by this
 * window. In particular, Stop removes ownership before another window can make
 * the shared DB row running and accidentally revive this window's stale claim.
 */
export function sessionOwnershipAction(
  hookEventName: string | undefined,
  hasLiveTerminal: boolean,
): SessionOwnershipAction {
  if (hookEventName === 'Stop' || hookEventName === 'SessionEnd') {
    return 'remove';
  }
  if (
    hasLiveTerminal &&
    (hookEventName === 'SessionStart' ||
      hookEventName === 'UserPromptSubmit' ||
      hookEventName === 'PostToolUse')
  ) {
    return 'add';
  }
  return 'keep';
}

/** Classify a visible tagged terminal after current-project ownership is known. */
export function classifyRestoredSession(
  ticket: Pick<RecoveryCandidate, 'canResume' | 'hasWorktree'> | undefined,
): RestoredSessionDisposition {
  if (!ticket) return 'ignore';
  return ticket.canResume && ticket.hasWorktree ? 'resume' : 'idle';
}

/**
 * Recover hidden terminals from this window's persisted ownership list. VS Code
 * does not restore `hideFromUser` terminals, so DB liveness is the only durable
 * signal after the extension host is recreated.
 */
export function planBackgroundSessionRecovery(
  tickets: readonly RecoveryCandidate[],
  ownedTicketIds: readonly number[],
): BackgroundRecoveryResult {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const result: BackgroundRecoveryResult = {
    resume: [],
    idle: [],
    discard: [],
  };

  for (const ticketId of ownedTicketIds) {
    const ticket = byId.get(ticketId);
    if (
      !ticket ||
      (ticket.agentState !== 'running' && ticket.agentState !== 'waiting')
    ) {
      result.discard.push(ticketId);
      continue;
    }
    if (ticket.canResume && ticket.hasWorktree) result.resume.push(ticket.id);
    else result.idle.push(ticket.id);
  }
  return result;
}

/** Merge visible-terminal and hidden-ownership recovery without double launches. */
export function planSessionRecovery(
  tickets: readonly RecoveryCandidate[],
  ownedTicketIds: readonly number[],
  restored: RestoredRecoveryResult,
): BackgroundRecoveryResult {
  const background = planBackgroundSessionRecovery(tickets, ownedTicketIds);
  return {
    resume: [...new Set([...restored.resume, ...background.resume])],
    idle: [...new Set([...restored.idle, ...background.idle])],
    discard: background.discard,
  };
}

/**
 * A late SessionEnd from the disposed terminal must not overwrite the running
 * state established by its replacement. Once the managed replacement closes,
 * the ordinary SessionEnd state is safe to apply again.
 */
export function shouldApplySessionHookState(
  sessions: SessionLiveness,
  lifecycle: Pick<SessionRecoveryLifecycle, 'isCurrentHook'>,
  ticketId: number,
  payload: { hook_event_name?: string; launchId?: string },
): boolean {
  if (!lifecycle.isCurrentHook(ticketId, payload.launchId)) return false;
  return payload.hook_event_name !== 'SessionEnd' || !sessions.isOpen(ticketId);
}
