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
   * The control's label — the SAME words the click that acts shows, and the
   * same words the navigational click scrolls to. Never a second actor: the
   * rail performs an irreversible step only when it IS the owner's control.
   */
  action: string;
  /**
   * What clicking the control beside this wording DOES, in machine terms. The
   * webview renders from this closed union — it never derives "what to do"
   * from the `action` string. The host is the one that knows whether the rail
   * may act directly (ship is whole-ticket, one merge is one repo) or must
   * point at the panel that owns the step.
   */
  cta: RailCta;
}

/**
 * The rail's needs-you control's BEHAVIOUR, decided host-side.
 *
 * `ship-confirm`, `merge` and `resolve-conflicts` ACT: they post the same
 * message the header's Confirm ship button, the PR panel's Merge button and
 * its Resolve conflicts button post. The host's confirmation still guards the
 * irreversible merge (it keeps its modal), and `resolve-conflicts` re-derives
 * the brief from the store before handing it to a session. The rest NAVIGATE:
 * a multi-repo wait or conflict has no single repo to act on, and the live
 * session belongs to the header, so the control scrolls the owning control
 * into view rather than duplicating it.
 */
export type RailCta =
  | { kind: 'ship-confirm' }
  | { kind: 'merge'; repo: string }
  | { kind: 'merge-panel' }
  | { kind: 'resolve-conflicts'; repo: string }
  | { kind: 'resolve-panel' }
  | { kind: 'open-session' };

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
  /**
   * The repos whose CURRENT PR karst currently offers to merge — the host's own
   * `canMerge` verdict (an open PR with a recorded url), derived from the same
   * current-PR read the gate uses. Only consulted for the `awaiting` gate: a
   * real merge is offered only when exactly one repo is waiting AND its PR can
   * merge, so the rail never fires an irreversible command the panel's own
   * disabled Merge button would refuse.
   */
  mergeableRepos: readonly string[];
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
    return {
      detail: 'the agent asked you something',
      action: 'Open session',
      cta: { kind: 'open-session' },
    };
  }

  if (input.stage === 'ship') {
    if (!input.shipAwaitingMerge) {
      return {
        detail: 'ready to open the PRs',
        action: 'Confirm ship',
        cta: { kind: 'ship-confirm' },
      };
    }
    const gate = input.mergeGate;
    if (!gate) return null;
    switch (gate.kind) {
      // A conflict is a WORDING difference, not a new state: ship has no
      // failed edge, so it must never read as something a retry could clear.
      // Only a human rebase resolves it, per repo. A SINGLE conflicted repo is
      // one the rail can act on — the resolve-conflicts session is per-repo
      // and the host re-derives the brief from the store, so this click opens
      // (or nudges) the exact session the PR panel's own Resolve button would
      // (navigating there was the original gap). Several conflicted repos have
      // no single target for a track-level button, so the rail points at the
      // panel that owns one Resolve control per repo.
      case 'conflicted': {
        const detail = `${count(gate.repos)} ${
          gate.repos.length === 1 ? 'no longer merges' : 'no longer merge'
        } cleanly`;
        if (gate.repos.length === 1) {
          return {
            detail,
            action: 'Resolve',
            cta: { kind: 'resolve-conflicts', repo: gate.repos[0]! },
          };
        }
        return { detail, action: 'Resolve', cta: { kind: 'resolve-panel' } };
      }
      case 'awaiting':
        // The one case where the rail may ACT: a single waiting repo whose PR
        // can merge. The host's confirmation modal still guards the merge.
        // Every other waiting shape — more than one repo, or a single repo
        // whose PR is not currently mergeable — sends the user to the PR panel,
        // where each repo has its own (host-confirmed) Merge button.
        if (gate.repos.length === 1 && input.mergeableRepos.includes(gate.repos[0]!)) {
          return {
            detail: `${count(gate.repos)} to merge`,
            action: 'Merge',
            cta: { kind: 'merge', repo: gate.repos[0]! },
          };
        }
        return { detail: `${count(gate.repos)} to merge`, action: 'Merge', cta: { kind: 'merge-panel' } };
      // Both landed states mean the gate is about to advance the ticket (or
      // already has, and this snapshot predates it). Nothing is wanted.
      case 'merged':
      case 'nothing-to-merge':
        return null;
    }
  }

  return null;
}
