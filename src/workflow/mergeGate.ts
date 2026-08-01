import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { getTicket, listTickets } from '../store/tickets.js';
import { listCurrentPrsByTicket } from '../store/prs.js';
import { listMergeChecksByTicket } from '../store/mergeChecks.js';
import { transition } from './machine.js';

/**
 * The gate between "the PRs are open" and "the work has landed" (§11).
 *
 * `ship` used to pass straight to `done`, so a ticket read Done — and pushed the
 * provider's done status — the moment its PRs existed. Nothing about that claim
 * was true yet: the branch was unmerged, the base kept moving under it, and a
 * conflict that appeared afterwards showed up beside a green ticket nobody was
 * going to look at again.
 *
 * Everything here is a READ over state karst already keeps current — `prs.status`
 * (re-probed by `prSync`) and `merge_checks` (re-probed by `mergeSync`) — plus at
 * most one transition. It never runs git, never calls gh, and never merges
 * anything: landing a PR is irreversible and stays a human's click
 * (`workflow/mergePr.ts`). This only decides whether the landing already
 * happened.
 */

/**
 * Why a ticket's delivery is, or is not, fully landed.
 *
 * `nothing-to-merge` is a genuine pass, not an empty case: a ticket whose work
 * produced no diff in any repo (`ship` skips the push and opens no PR when there
 * are no changes from the base) has delivered everything it had, and holding it
 * short of done forever would be a lie in the other direction. It is reachable
 * ONLY through that path — a ship that could not open a PR it needed throws and
 * parks at `ship` without ever entering `merge`.
 *
 * `conflicted` is separated from `awaiting` because the user's next move differs:
 * one is "click Merge", the other is "resolve this first". Both park the ticket
 * and both read as needs-you; only the wording changes.
 */
export type MergeGateState =
  | { kind: 'nothing-to-merge' }
  | { kind: 'merged'; repos: readonly string[] }
  | { kind: 'conflicted'; repos: readonly string[]; pending: readonly string[] }
  | { kind: 'awaiting'; repos: readonly string[] };

/**
 * Read a ticket's landing state from the PR rows and the merge checks.
 *
 * Pure over the store, so the whole decision is testable against an in-memory DB
 * with no gh and no git. The two inputs are both current state by construction —
 * a stale `open` for a PR merged upstream is exactly what `prSync` exists to
 * correct — so this never has to date-check anything itself.
 */
export function mergeGateState(store: Store, ticketId: number): MergeGateState {
  const prs = listCurrentPrsByTicket(store, ticketId);
  if (prs.length === 0) return { kind: 'nothing-to-merge' };

  const unmerged = prs.filter((p) => p.status !== 'merged').map((p) => p.repo);
  if (unmerged.length === 0) {
    return { kind: 'merged', repos: prs.map((p) => p.repo) };
  }

  // `listMergeChecksByTicket` already drops the repos whose PR has landed, so a
  // conflict verdict frozen at merge time can never be read back here as a
  // reason to hold a merged ticket open.
  const conflicted = listMergeChecksByTicket(store, ticketId)
    .filter((c) => c.state === 'conflicted')
    .map((c) => c.repo)
    // A conflict is only news about a repo that still has to land. A stale row
    // for a repo with no open PR left is not this gate's business.
    .filter((repo) => unmerged.includes(repo));

  if (conflicted.length > 0) {
    return {
      kind: 'conflicted',
      repos: conflicted,
      pending: unmerged.filter((r) => !conflicted.includes(r)),
    };
  }
  return { kind: 'awaiting', repos: unmerged };
}

/** True when the state means every delivered PR has landed (or there was none). */
export function isLanded(state: MergeGateState): boolean {
  return state.kind === 'merged' || state.kind === 'nothing-to-merge';
}

export interface SettleResult {
  /** True only when THIS call moved the ticket from `merge` to `done`. */
  advanced: boolean;
  state: MergeGateState;
}

/**
 * Advance a ticket parked at `merge` to `done` — but only once every PR it opened
 * reads merged.
 *
 * Idempotent and safe to call from anywhere, which is the point: the landing can
 * be observed from three unrelated places (the merge click, the background PR
 * sweep noticing a teammate's merge, ship itself when there was nothing to
 * merge), and none of them should have to know about the other two. A ticket that
 * is not at `merge` is left alone entirely — this must never drag a ticket
 * forward from a stage it has not reached, nor re-fire on one already done.
 *
 * `advanced` is what the host needs: pushing the provider's post-merge status
 * belongs to the transition, not to any one of the three call sites, so only the
 * call that actually moved the ticket reports it.
 */
export function settleMergeStage(store: Store, ticketId: number): SettleResult {
  const state = mergeGateState(store, ticketId);
  if (getTicket(store, ticketId).stageCurrent !== 'merge') return { advanced: false, state };
  if (!isLanded(state)) return { advanced: false, state };

  transition(store, ticketId, 'merge', { kind: 'passed' });
  return { advanced: true, state };
}

/**
 * Settle every ticket in scope that is parked at `merge`, returning the ids that
 * reached `done`.
 *
 * A scan rather than a callback threaded through `syncPrStatuses`: the sweep
 * already re-probes each PR, and a ticket can also land through a merge nobody in
 * this window performed. Scanning the (small) set of tickets sitting at `merge`
 * answers all of those with one rule, and re-running it costs a read per parked
 * ticket.
 *
 * One ticket's failure never sinks the rest — the same discipline the PR and
 * merge sweeps follow.
 */
export function settleMergeGates(store: Store, scope: ProjectScope = {}): number[] {
  const advanced: number[] = [];
  for (const ticket of listTickets(store, scope)) {
    if (ticket.stageCurrent !== 'merge') continue;
    try {
      if (settleMergeStage(store, ticket.id).advanced) advanced.push(ticket.id);
    } catch {
      continue;
    }
  }
  return advanced;
}
