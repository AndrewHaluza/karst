import type { Store } from '../../store/db.js';
import { getMergeCheck } from '../../store/mergeChecks.js';
import { listPrsByTicket } from '../../store/dashboard.js';
import type { DeliverTargets } from '../../workflow/deliverState.js';
import type { ConflictRounds, ResolvedRound } from './autoDeliverOps.js';

/**
 * Resume the delivery of a merge that is finished in the worktree but not pushed (@arch:AP-01).
 *
 * A window reload kills the auto-deliver's gate run, the armed round (memory only) and the agent session. The store still
 * holds the round's slot (`conflict_round_at`) and the merge check of the conflict. This module re-arms the round from
 * those rows and starts the same auto-deliver, with no new agent round and no budget attempt.
 */

/**
 * `started`: the round is re-armed and the auto-deliver runs. `unfinished`: a local head exists but the merge is not finished.
 * `wait`: the PR head is unknown (not probed since the round), so no decision. `none`: nothing is pending locally.
 */
export type ResumeOutcome = 'started' | 'unfinished' | 'wait' | 'none';

export interface ResumeDeps {
  readonly store: Store;
  readonly ticketId: number;
  readonly rounds: ConflictRounds;
  readonly targets: () => DeliverTargets;
  /** The HEAD sha of a worktree, or null when git cannot read it. */
  readonly headOf: (cwd: string) => Promise<string | null>;
  /** Null when the merge in `cwd` is finished (`verifyMergeResolved`); else why it is not. */
  readonly verify: (cwd: string, round: ResolvedRound) => Promise<string | null>;
  /** Start the auto-deliver of the armed round. It runs in the background. */
  readonly startDeliver: () => void;
  readonly debug: (message: string) => void;
}

interface PrFacts { readonly head: string | null; readonly dirty: boolean }

/** The PR head and merge block GitHub held at the last probe, per repo of the open PRs. */
function prFacts(store: Store, ticketId: number): Map<string, PrFacts> {
  return new Map(listPrsByTicket(store, ticketId).filter((p) => p.status === 'open').map((p) => [p.repo, { head: p.headOid ?? null, dirty: p.mergeBlock === 'dirty' }] as const));
}

/**
 * `fromRound`: the store holds a conflict round slot. Then a stored `conflicted` row of an older head still names the round's
 * base and files. A clean check of the local head counts too while GitHub reports the PR as `dirty` (a merge by hand).
 */
export async function resumeFinishedMerge(d: ResumeDeps, fromRound: boolean): Promise<ResumeOutcome> {
  const targets = d.targets();
  if (!targets.available) return 'none';
  const facts = prFacts(d.store, d.ticketId);
  let result: ResumeOutcome = 'none';
  for (const pr of targets.prs) {
    const check = getMergeCheck(d.store, d.ticketId, pr.repo);
    if (check === null) continue;
    const local = await d.headOf(pr.cwd);
    if (local === null) continue;
    const remote = facts.get(pr.repo)?.head ?? null;
    // Only a conflict is resumed, never an ordinary unpushed commit: the stored round names the conflicted repo, and a hand
    // merge is a clean check of the local head while GitHub still reports the PR as `dirty` (T1143).
    const eligible = (fromRound && check.state === 'conflicted') || (check.state === 'clean' && check.headSha === local && facts.get(pr.repo)?.dirty === true);
    if (!eligible) continue;
    if (remote === null) { if (result === 'none') result = 'wait'; continue; }
    if (remote === local) continue;
    const round: ResolvedRound = { repo: pr.repo, baseSha: check.baseSha, files: check.files };
    const unfinished = await d.verify(pr.cwd, round);
    if (unfinished !== null) {
      d.debug(`[ship] autopilot ticket ${d.ticketId}: the local merge in ${pr.repo} is not finished (${unfinished})`);
      result = 'unfinished';
      continue;
    }
    d.rounds.arm(d.ticketId, round);
    d.startDeliver();
    return 'started';
  }
  return result;
}
