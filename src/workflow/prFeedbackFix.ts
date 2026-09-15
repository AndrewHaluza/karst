import type { Store } from '../store/db.js';
import { setStage } from '../store/stages.js';
import {
  activeRecoverySeries,
  currentEpisode,
  openRecoveryRound,
} from '../store/recoveryRounds.js';
import {
  adoptPrFeedbackIntoRound,
  listUnadoptedPrFeedback,
  type PrFeedbackRow,
} from '../store/prFeedback.js';
import { capForGate, roundFixDecision } from './fixAttempts.js';
import { sendBackState } from './sendBack.js';
import { nowIso } from '../model/time.js';

/**
 * "Address pull request feedback": the host-only recovery path for a ticket
 * parked at `ship` whose PR carries unresolved human review feedback.
 *
 * Like `sendBack.ts`, this is deliberately NOT modelled as a verdict edge on the
 * graph and NOT reachable from the agent CLI: the stage machine's transitions
 * stay verdict-keyed and the agent's marker stages stay exactly the ones
 * `cli/stage.ts` allows. It sits beside `sendBack` rather than inside it because
 * the two answer different questions — `sendBack` is "the implementation is not
 * what I expected" and returns to `impl`; this is "the reviewers asked for
 * changes" and enters a real recovery round at `fix`.
 *
 * The round is a `recovery_rounds` row with `source_stage = 'ship'`, so the
 * driver's EXISTING fix cascade resumes, bounds (its committed `max_rounds`),
 * interrupts and parks it with no new branch: marking the `ship` row `failed`
 * is what makes `lastFailedGate` return `'ship'`.
 */

/** Why the action is not being offered right now. */
export type PrFeedbackFixUnavailableReason =
  | 'stage'
  | 'in-flight'
  | 'landed'
  | 'no-feedback'
  | 'round-active'
  | 'exhausted';

/** The host's verdict on offering the action, mirroring `sendBackState`. */
export type PrFeedbackFixState =
  | { available: true; round: number; items: number }
  | { available: false; reason: PrFeedbackFixUnavailableReason };

export interface EnterPrFeedbackFixOpts {
  now?: () => string;
  /** Verbose decision-point logging, prefixed `[merge]`. */
  debug?: (message: string) => void;
}

export interface EnterPrFeedbackFixResult {
  roundId: number;
  round: number;
  items: number;
}

/**
 * The round number `openRecoveryRound` will assign next for `(ticket, 'ship')`.
 * Shares `currentEpisode` with the open path (the episode boundary is the part
 * that is easy to get wrong); the `MAX(round) + 1` within the episode is the
 * same expression `openRecoveryRound` uses, and the `'exhausted'` regression
 * test pins that the two agree.
 */
function nextRoundNumber(store: Store, ticketId: number): number {
  const episode = currentEpisode(store, ticketId, 'ship');
  const prev = store.db
    .prepare(
      `SELECT MAX(round) AS max_round FROM recovery_rounds
        WHERE ticket_id = ? AND source_stage = 'ship' AND episode = ?`,
    )
    .get(ticketId, episode) as { max_round: number | null } | undefined;
  return (prev?.max_round ?? 0) + 1;
}

/** A bounded causal summary: how many items, which repos, who asked. No bodies. */
function triggerDetailFor(rows: readonly PrFeedbackRow[]): string {
  const repos = [...new Set(rows.map((r) => r.repo))];
  const reviewers = [...new Set(rows.map((r) => r.author.login).filter((l) => l !== ''))];
  const parts = [`${rows.length} open PR review item(s)`];
  if (repos.length > 0) parts.push(`in ${repos.join(', ')}`);
  if (reviewers.length > 0) parts.push(`from ${reviewers.join(', ')}`);
  const detail = parts.join(' ');
  return detail.length > 300 ? `${detail.slice(0, 297)}...` : detail;
}

/**
 * Whether the action may be offered RIGHT NOW.
 *
 * The first three refusals are DELEGATED to `sendBackState`, not copied: it
 * computes two in-flight signals (a `stage_runs` row still running, and the
 * ship cell's own `running`) and the same `landed` rule, and copying only one
 * would let the two paths drift. A ticket that pass-through but is not at
 * `ship` (uat/review) is `stage`.
 *
 * Pure over the store, so the whole decision is testable against an in-memory DB.
 */
export function prFeedbackFixState(store: Store, ticketId: number): PrFeedbackFixState {
  const sendBack = sendBackState(store, ticketId);
  if (!sendBack.available) return { available: false, reason: sendBack.reason };
  if (sendBack.stage !== 'ship') return { available: false, reason: 'stage' };

  if (activeRecoverySeries(store, ticketId, 'ship') !== null) {
    return { available: false, reason: 'round-active' };
  }

  const unadopted = listUnadoptedPrFeedback(store, ticketId);
  if (unadopted.length === 0) return { available: false, reason: 'no-feedback' };

  const nextRound = nextRoundNumber(store, ticketId);
  // Ask the DRIVER's own decision, not a hand-rolled comparison: `roundFixDecision`
  // reports `exhausted` once `round >= maxRounds`, so a round opened AT the cap
  // would be exhausted on the very next drive — the modal would confirm, the
  // ticket would move to fix, and the feedback would be silently buried. Reading
  // the driver's decision here makes the check and the drive agree by
  // construction (the failure mode this whole plan exists to prevent).
  const decision = roundFixDecision({
    roundId: 0,
    round: nextRound,
    maxRounds: capForGate('ship'),
  });
  if (decision.kind === 'exhausted') return { available: false, reason: 'exhausted' };

  return { available: true, round: nextRound, items: unadopted.length };
}

/**
 * Mark `ship` failed, open a ship-sourced recovery round and enter `fix` — all
 * in ONE transaction.
 *
 * Availability is re-derived INSIDE the transaction (`sendBackToImplement`'s
 * discipline), so a ticket a sweep or a teammate's merge moved between the click
 * and this call is refused rather than mutated underneath its new state.
 *
 * This authors no verdict and consumes no stage attempt, exactly like
 * `sendBackToImplement`: it never calls `transition`. No `prs`, `ship_runs`,
 * `gate_runs`, `review_findings`, worktree or other append-only evidence is
 * touched; the existing pull requests stay open and the resumed agent pushes new
 * commits to them.
 */
export function enterPrFeedbackFix(
  store: Store,
  ticketId: number,
  opts?: EnterPrFeedbackFixOpts,
): EnterPrFeedbackFixResult {
  const at = (opts?.now ?? nowIso)();
  let out: EnterPrFeedbackFixResult | undefined;
  const apply = store.db.transaction(() => {
    opts?.debug?.(`[merge] pr feedback fix ticket ${ticketId}: evaluating`);
    const state = prFeedbackFixState(store, ticketId);
    if (!state.available) {
      opts?.debug?.(
        `[merge] pr feedback fix ticket ${ticketId}: refused — ${state.reason} (no mutation)`,
      );
      throw new Error(`pr feedback fix refused: ticket ${ticketId} (${state.reason})`);
    }

    const unadopted = listUnadoptedPrFeedback(store, ticketId);

    // A ship-saga crash also writes `failed` here via a direct `setStage`, but it
    // opens NO round — the round's `trigger_kind` is the authoritative
    // discriminator between the two, and the verdict text is the human-readable
    // one. `attempt` carries the round number so the rail's retry meter draws
    // the loop (`countFixAttempts` reads it; an unset attempt reads as 0 and the
    // meter would stay hidden).
    setStage(store, ticketId, 'ship', {
      status: 'failed',
      verdict: `the review team requested changes on ${state.items} open item(s)`,
      attempt: state.round,
      endedAt: at,
    });

    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'upstream-changes-requested',
      triggerDetail: triggerDetailFor(unadopted),
      maxRounds: capForGate('ship'),
      startedAt: at,
    });

    const adopted = adoptPrFeedbackIntoRound(store, ticketId, round.id);
    if (adopted === 0) {
      // A race: the rows were resolved between the check and this stamp. Nothing
      // is mutated — the transaction rolls back.
      opts?.debug?.(
        `[merge] pr feedback fix ticket ${ticketId}: refused — no-feedback (rows resolved mid-flight)`,
      );
      throw new Error(`pr feedback fix refused: ticket ${ticketId} (no-feedback)`);
    }

    setStage(store, ticketId, 'fix', {
      status: 'running',
      verdict: null,
      attempt: 0,
      artifactPath: null,
      startedAt: at,
      endedAt: null,
      blockedKind: null,
      blockedReason: null,
      blockedAt: null,
    });
    store.db
      .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
      .run('fix', ticketId);

    out = { roundId: round.id, round: round.round, items: adopted };
    opts?.debug?.(
      `[merge] pr feedback fix ticket ${ticketId}: round ${round.round} (id ${round.id}) ` +
        `opened with ${adopted} item(s); ticket moved to fix`,
    );
  });
  apply();
  if (out === undefined) throw new Error('pr feedback fix did not land');
  return out;
}
