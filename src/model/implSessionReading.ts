import { displayStatus, type StepperCell } from './stepper.js';
import type { AgentState } from './types.js';

/**
 * How the impl stage's session READS while the stage shows `running`. One
 * reading feeds the stage rail, the Inside summary row and the Session row, so
 * the three can never disagree (UI-R31: the webview never derives it).
 *
 * Display only: stored stage status and `agent_state` are never touched.
 */
export type ImplSessionReading = 'live' | 'waiting' | 'not-started' | 'no-session' | 'idle';

export interface ImplSessionFacts {
  /** The ticket's `agent_state`. */
  agentState: AgentState | string | null | undefined;
  /** An implementation run is recorded (the stable run's timeline exists). */
  hasRun: boolean;
  /** A graph-engineering run is open: it has no interactive session. */
  graphRunLive: boolean;
}

/**
 * Null when the reading does not apply (not the impl stage, or the stage does
 * not read `running` — blocked, paused and settled stages keep their own
 * words). `agent_state` running is the live evidence the Antigravity watch loop
 * also relies on.
 */
export function implSessionReading(
  cell: StepperCell,
  facts: ImplSessionFacts,
): ImplSessionReading | null {
  if (cell.stageKey !== 'impl' || displayStatus(cell) !== 'running') return null;
  const state = facts.agentState ?? 'none';
  if (state === 'running') return 'live';
  if (state === 'waiting') return 'waiting';
  if (state === 'not-started') return 'not-started';
  if (facts.graphRunLive) return 'live';
  return facts.hasRun ? 'idle' : 'no-session';
}

/** The readings that must not draw a spinner or a growing duration. */
export function isSessionless(reading: ImplSessionReading | null | undefined): boolean {
  return reading === 'not-started' || reading === 'no-session' || reading === 'idle';
}
