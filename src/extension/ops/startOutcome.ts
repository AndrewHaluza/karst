import type { StartTicketResult } from '../../ui/ticketForm/actions.js';

/**
 * Longest observed time from ticket creation to a launch line is 95 s (T949 to
 * T952, 2026-11-03: 33 to 95 s, including worktree creation). The bound sits
 * above it so a slow but healthy sbx start never times out.
 */
export const LAUNCH_BACKEND_TIMEOUT_MS = 180_000;

/** What `karst.openSession` reports to its caller. */
export type SessionOutcome =
  | { readonly kind: 'launched' }
  | { readonly kind: 'not-applicable'; readonly reason: 'graph-owned' | 'recovery' | 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface SettleStartInput {
  readonly ticketId: number;
  /** `undefined`: the command returned nothing (an exit that predates outcomes) — a failed start. */
  readonly outcome: SessionOutcome | undefined;
  readonly log: (message: string) => void;
  readonly markNotStarted: (ticketId: number) => void;
}

/**
 * Turns the session outcome of a start that passed scope into the start
 * result. A failed outcome is logged and marks the ticket `not-started`; a
 * graph-owned, recovery or user-cancelled exit is not a failed start.
 */
export function settleStartOutcome(input: SettleStartInput): StartTicketResult {
  const { ticketId } = input;
  const outcome = input.outcome ?? { kind: 'failed', reason: 'openSession returned no outcome' } as const;
  if (outcome.kind === 'launched') return { ok: true };
  if (outcome.kind === 'not-applicable') {
    input.log(`start ticket ${ticketId}: no new session (${outcome.reason})`);
    return { ok: true };
  }
  return recordStartFailure({ ticketId, reason: outcome.reason, log: input.log, markNotStarted: input.markNotStarted });
}

export function recordStartFailure(input: {
  readonly ticketId: number;
  readonly reason: string;
  readonly log: (message: string) => void;
  readonly markNotStarted: (ticketId: number) => void;
}): StartTicketResult {
  input.log(`start ticket ${input.ticketId}: session did not start: ${input.reason}`);
  input.markNotStarted(input.ticketId);
  return { ok: false, message: `Could not start ticket: ${input.reason}` };
}

export type BackendStep<T> = { readonly kind: 'done'; readonly value: T } | { readonly kind: 'timed-out' };

/**
 * Bounds the pre-launch backend step. On timeout the caller gets `timed-out`
 * and must not launch; a result that arrives later goes to `onLate` only, so
 * the timed-out attempt can never start a second session.
 */
export async function withBackendTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  onLate: (value: T) => void,
): Promise<BackendStep<T>> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = work();
  const timeout = new Promise<BackendStep<T>>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ kind: 'timed-out' });
    }, ms);
  });
  const done = pending.then((value): BackendStep<T> => {
    if (timedOut) {
      onLate(value);
      return { kind: 'timed-out' };
    }
    return { kind: 'done', value };
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // A late rejection after timeout is already handled by the race; keep it quiet.
    pending.catch(() => {});
  }
}

export interface StartGuardsDeps {
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly logError: (message: string, error: unknown) => void;
  readonly isOpen: (ticketId: number) => boolean;
  readonly agentStateOf: (ticketId: number) => string | null | undefined;
  readonly stageOf: (ticketId: number) => string | null | undefined;
  /** Writes `agent_state='not-started'` and refreshes the views. */
  readonly setNotStarted: (ticketId: number) => void;
}

/** The launch-path helpers `extension.ts` binds: a logged failed exit, and the bounded backend step. */
export function makeStartGuards(deps: StartGuardsDeps) {
  /** Only an impl or fix ticket, never over a live session or a state an agent already set. */
  const markNotStarted = (ticketId: number): void => {
    const stage = deps.stageOf(ticketId);
    if ((stage !== 'impl' && stage !== 'fix') || deps.isOpen(ticketId) || (deps.agentStateOf(ticketId) ?? 'none') !== 'none') return;
    deps.setNotStarted(ticketId);
  };
  const hung = new Set<number>(); // tickets whose timed-out backend step still runs
  return {
    markNotStarted,
    settle: (ticketId: number, outcome: SessionOutcome | undefined): StartTicketResult =>
      settleStartOutcome({ ticketId, outcome, log: deps.log, markNotStarted }),
    /** The `startTicket` catch: log the error; a ticket past scope has no session, so record it. */
    afterThrow(ticketId: number, error: unknown): void {
      deps.logError(`start ticket ${ticketId} failed`, error);
      try {
        if (deps.stageOf(ticketId) !== 'scope') markNotStarted(ticketId);
      } catch (markErr) {
        deps.logError(`start ticket ${ticketId}: could not record not-started`, markErr);
      }
    },
    /** A pre-launch exit of `karst.openSession` that leaves the ticket without a session. */
    failedLaunch(ticketId: number, reason: string): SessionOutcome {
      deps.log(`open session ${ticketId}: not launched: ${reason}`);
      return { kind: 'failed', reason };
    },
    /** Bounds the backend step; a late result is logged, never launched. */
    async boundedBackendStep<T>(ticketId: number, label: string, work: () => Promise<T>): Promise<T> {
      if (hung.has(ticketId)) throw new Error(`the earlier sandbox backend step for ${label} is still running; try again when it ends`);
      const tracked = (): Promise<T> => work().finally(() => hung.delete(ticketId));
      const step = await withBackendTimeout(tracked, LAUNCH_BACKEND_TIMEOUT_MS, () =>
        deps.warn(`open session ${ticketId}: backend result for ${label} arrived after the timeout; ignored`));
      if (step.kind === 'done') return step.value;
      hung.add(ticketId);
      markNotStarted(ticketId);
      throw new Error(`the sandbox backend for ${label} did not start within ${LAUNCH_BACKEND_TIMEOUT_MS / 1000} s`);
    },
  };
}
