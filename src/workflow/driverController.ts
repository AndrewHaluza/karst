import type { StageKey } from '../model/types.js';

/** Deterministic gate stages the driver may auto-run. */
const AUTO_GATES: readonly StageKey[] = ['uat', 'review'] as const;

/**
 * Start the driver for any deterministic gate stage. A ticket only reaches a gate
 * via the explicit done marker (§5.4), so the marker — not the terminal — is the
 * "work finished" signal: an open, idle post-marker session must NOT block the
 * gate (that stranded tickets at `uat` until the user closed the terminal by
 * hand). Gates are read-only (`npm test`/lint/typecheck) in the ticket's own
 * worktree, so running one under a live session is safe.
 */
export function shouldStartDriver(stage: StageKey): boolean {
  return AUTO_GATES.includes(stage);
}

/**
 * Select the ticket ids the driver should resume — those parked at a
 * deterministic gate that is NOT blocked.
 *
 * The blocked check is what makes parking durable. Without it a blocked ticket is
 * re-selected on every window activation and the whole failed stage runs again to
 * park in the same place, forever.
 */
export function ticketsToSweep(
  tickets: readonly {
    id: number;
    stageCurrent: string | null;
    pausedAt?: string | null;
    stages: readonly { stageKey: string; blockedKind: string | null }[];
  }[],
): number[] {
  return tickets
    .filter((t) => {
      if (t.pausedAt !== undefined && t.pausedAt !== null) return false;
      if (!shouldStartDriver(t.stageCurrent as StageKey)) return false;
      const current = t.stages.find((s) => s.stageKey === t.stageCurrent);
      return !current?.blockedKind;
    })
    .map((t) => t.id);
}

/**
 * Per-ticket run bookkeeping for the host seam: single-flight guard (no two
 * drivers on one ticket), a Stop flag the driver reads via `shouldContinue`, and
 * the abort signal that carries the same Stop into a gate ALREADY running.
 * Pure of vscode so it is unit-testable.
 */
export class DriverController {
  private readonly running = new Set<number>();
  private readonly stopping = new Set<number>();
  /**
   * One controller per run, created by `begin` and dropped by `end`.
   *
   * `shouldContinue` is only polled between stages, so on its own Stop is a
   * button that does nothing for the length of a UAT gate — up to `npm test`
   * plus e2e. The signal is what reaches the child process.
   */
  private readonly aborts = new Map<number, AbortController>();

  isRunning(ticketId: number): boolean {
    return this.running.has(ticketId);
  }

  /** Claim the ticket for a run; false if one is already in flight. */
  begin(ticketId: number): boolean {
    if (this.running.has(ticketId)) return false;
    this.running.add(ticketId);
    this.stopping.delete(ticketId); // fresh run clears any stale stop flag
    // A fresh controller per run, never a reset one: an AbortSignal cannot be
    // un-aborted, so reusing it would make every gate after a Stop refuse to
    // spawn.
    this.aborts.set(ticketId, new AbortController());
    return true;
  }

  end(ticketId: number): void {
    this.running.delete(ticketId);
    this.stopping.delete(ticketId);
    this.aborts.delete(ticketId);
  }

  requestStop(ticketId: number): void {
    this.stopping.add(ticketId);
    this.aborts.get(ticketId)?.abort();
  }

  shouldContinue(ticketId: number): boolean {
    return !this.stopping.has(ticketId);
  }

  /** The running run's abort signal, or undefined when nothing is in flight. */
  signalFor(ticketId: number): AbortSignal | undefined {
    return this.aborts.get(ticketId)?.signal;
  }
}
