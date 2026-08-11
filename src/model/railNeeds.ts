import type { MergeGateState } from '../workflow/mergeGate.js';
import type { StageStatus } from './types.js';

/**
 * The words a needs-you segment carries: why the ticket stopped, and what the
 * control beside it goes to.
 *
 * Rendered host-side like every other dashboard string — the webview is
 * standalone HTML and cannot import a formatter, so a webview-side wording would
 * be untested and would drift from the Now line's.
 *
 * Deliberately NOT the Now line itself. That is a sentence with room to explain
 * ("Now: 2 repos no longer merge cleanly into the base. Resolve the conflicts
 * below, then merge."); this is three or four words inside a segment. One string
 * cannot be both, and the segment is what a user reads first.
 */
export interface RailNeeds {
  /** Why, in a few words. Never a sentence — the segment has no room for one. */
  detail: string;
  /**
   * The label of the control this points AT. Never a new actor: the rail
   * performs no irreversible step, it navigates to the one that does.
   */
  action: string;
}

export interface RailNeedsInput {
  /** `ticket.stageCurrent` — a stored string that may name no known stage. */
  stage: string | null;
  /** The agent asked a question (`agentState === 'waiting'`). */
  agentWaiting: boolean;
  /**
   * The stored status of the SHIP stage row — `running` while ship is actively
   * committing, pushing and opening PRs. A live agent question does NOT outrank
   * that: the hooks that set `agentWaiting` fire inside ship's own headless run,
   * so "the agent asked you something" beside shipping in progress is the exact
   * contradiction this input prevents (869ed7bpd). Only consulted when
   * `stage === 'ship'`; an awaiting-merge ship reads `passed`, never `running`.
   */
  shipStatus: StageStatus;
  /**
   * True when `stage` is `ship` because it is blocked on the merge gate
   * (`stages.blocked_kind === 'awaiting-merge'`), rather than parked pending its
   * first "Confirm ship" click. Both read `stage === 'ship'`, and only this
   * distinguishes which sentence applies.
   */
  shipAwaitingMerge: boolean;
  /** The merge gate's current read; only consulted when `shipAwaitingMerge`. */
  mergeGate: MergeGateState | null;
}

const count = (repos: readonly string[]): string =>
  `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`;

/**
 * The two needs-you sources are genuinely different situations, and a live
 * question outranks a parked stage: the agent is asking RIGHT NOW, and the
 * confirm will still be there afterwards. A RUNNING ship is the one exception —
 * ship is the driver's own agent work, and the hook that set the waiting state
 * fired inside that run, so the banner would contradict the shipping line
 * (869ed7bpd). Mirrors `needsUser`'s `waitingWhileShipRuns` and `buildNowLine`'s
 * ship branch.
 *
 * Returns null when nothing is blocked on the user — including once everything
 * has landed, where the gate is about to advance the ticket on its own and
 * there is no action to name.
 */
export function railNeeds(input: RailNeedsInput): RailNeeds | null {
  if (input.agentWaiting) {
    if (input.stage === 'ship' && input.shipStatus === 'running') return null;
    return { detail: 'the agent asked you something', action: 'Open session' };
  }

  if (input.stage === 'ship') {
    if (!input.shipAwaitingMerge) {
      return { detail: 'ready to open the PRs', action: 'Confirm ship' };
    }
    const gate = input.mergeGate;
    if (!gate) return null;
    switch (gate.kind) {
      // A conflict is a WORDING difference, not a new state: ship has no
      // failed edge, so it must never read as something a retry could clear.
      // Only a human rebase resolves it.
      case 'conflicted':
        return {
          detail: `${count(gate.repos)} ${
            gate.repos.length === 1 ? 'no longer merges' : 'no longer merge'
          } cleanly`,
          action: 'Resolve',
        };
      case 'awaiting':
        return { detail: `${count(gate.repos)} to merge`, action: 'Merge' };
      // Both landed states mean the gate is about to advance the ticket (or
      // already has, and this snapshot predates it). Nothing is wanted.
      case 'merged':
      case 'nothing-to-merge':
        return null;
    }
  }

  return null;
}
