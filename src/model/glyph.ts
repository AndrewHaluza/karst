import type { StageStatus, AgentState } from './types.js';

/**
 * The five-color glyph system (§14) — single source of truth [H1].
 * Every view calls this; none reinvents it.
 */
export type Glyph = 'gray' | 'blue' | 'amber' | 'green' | 'red';

/**
 * Map (stageStatus, agentState) → glyph color.
 *
 * Precedence: a waiting agent (needs-you) wins over stage status, because it is
 * the thing the user must act on. Amber is never inferred from stage status
 * here — killing the two-source ambiguity the mockup had.
 *
 * This function sees only these two values, so it cannot recognise the OTHER
 * needs-you case: a ticket parked at a confirm stage, where no agent is running
 * to be 'waiting' in the first place. That case is decided by `needsUser` and
 * applied in `ticketGlyph`, which is what every surface actually calls — call
 * that, not this, when you have a whole ticket.
 */
export function glyphFor(stageStatus: StageStatus, agentState: AgentState): Glyph {
  if (agentState === 'waiting') return 'amber'; // needs-you, highest priority
  if (stageStatus === 'failed') return 'red';
  if (stageStatus === 'passed') return 'green';
  if (stageStatus === 'running' || agentState === 'running') return 'blue';
  return 'gray'; // pending / idle / skipped
}
