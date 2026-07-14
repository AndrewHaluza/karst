import type { StageKey } from '../model/types.js';

/** Deterministic gate stages the driver may auto-run. */
const AUTO_GATES: readonly StageKey[] = ['uat', 'review'] as const;

/**
 * Start the driver only for a deterministic gate stage with no live interactive
 * session (a live session means the human is mid-work; don't run gates under it).
 */
export function shouldStartDriver(stage: StageKey, hasLiveSession: boolean): boolean {
  return !hasLiveSession && AUTO_GATES.includes(stage);
}

/**
 * Per-ticket run bookkeeping for the host seam: single-flight guard (no two
 * drivers on one ticket) and a Stop flag the driver reads via `shouldContinue`.
 * Pure of vscode so it is unit-testable.
 */
export class DriverController {
  private readonly running = new Set<number>();
  private readonly stopping = new Set<number>();

  isRunning(ticketId: number): boolean {
    return this.running.has(ticketId);
  }

  /** Claim the ticket for a run; false if one is already in flight. */
  begin(ticketId: number): boolean {
    if (this.running.has(ticketId)) return false;
    this.running.add(ticketId);
    this.stopping.delete(ticketId); // fresh run clears any stale stop flag
    return true;
  }

  end(ticketId: number): void {
    this.running.delete(ticketId);
    this.stopping.delete(ticketId);
  }

  requestStop(ticketId: number): void {
    this.stopping.add(ticketId);
  }

  shouldContinue(ticketId: number): boolean {
    return !this.stopping.has(ticketId);
  }
}
