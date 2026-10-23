import { deliverToPr, type DeliverDeps } from './deliverToPrOps.js';
import type { DeliverPr } from '../../workflow/deliverState.js';
import type { GitResult } from './deliverToPrOps.js';
import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { getMergeCheck } from '../../store/mergeChecks.js';

/**
 * Auto-delivery of a resolved merge conflict at ship (arch:AC-39, D247).
 *
 * "Resolve conflicts" at ship hands the agent a brief that ends "Commit the
 * merge. Do not push." Karst delivers: when that session next goes idle, the
 * existing Deliver to PR path syncs, the merged tree is verified and gated, and
 * only then does ship's push land it on the open PR. The agent never pushes
 * (it bypassed the gates, T765), and only a session OPENED by Resolve conflicts
 * is armed, so a manual fix session keeps its manual Deliver button (FIX-46).
 */

/** The conflict round a Resolve-conflicts click armed: what "resolved" is measured against. */
export interface ResolvedRound {
  readonly repo: string;
  /** merge_checks.baseSha at click time: the branch must contain it once resolved. */
  readonly baseSha: string | null;
  /** The conflicted files; they are scanned for leftover markers. */
  readonly files: readonly string[];
}

export interface ConflictRounds {
  arm(ticketId: number, round: ResolvedRound): void;
  armed(ticketId: number): ResolvedRound | null;
  disarm(ticketId: number): void;
}

/** In memory on purpose: a reload loses the session too, and the manual Deliver button remains. */
export function createConflictRounds(): ConflictRounds {
  const byTicket = new Map<number, ResolvedRound>();
  return {
    arm: (ticketId, round) => void byTicket.set(ticketId, round),
    armed: (ticketId) => byTicket.get(ticketId) ?? null,
    disarm: (ticketId) => void byTicket.delete(ticketId),
  };
}

type Git = (cwd: string, args: readonly string[]) => Promise<GitResult>;

const MARKER_RE = '^(<<<<<<< |>>>>>>> )';

/** Null when the merge in `cwd` is finished; else why it is not. */
export async function verifyMergeResolved(git: Git, cwd: string, round: ResolvedRound): Promise<string | null> {
  if (round.baseSha !== null && (await git(cwd, ['merge-base', '--is-ancestor', round.baseSha, 'HEAD'])).code !== 0) {
    return `the branch does not contain the base head ${round.baseSha.slice(0, 9)} yet`;
  }
  const status = await git(cwd, ['status', '--porcelain']);
  if (status.code !== 0) return 'could not read the worktree status';
  if (status.stdout.trim() !== '') return 'the worktree has uncommitted changes';
  if (round.files.length > 0) {
    const markers = await git(cwd, ['grep', '-lE', MARKER_RE, 'HEAD', '--', ...round.files]);
    if (markers.code === 0 && markers.stdout.trim() !== '') {
      return `conflict markers remain in ${markers.stdout.trim().split('\n').map((l) => l.replace(/^HEAD:/, '')).join(', ')}`;
    }
  }
  return null;
}

export interface AutoDeliverDeps extends Omit<DeliverDeps, 'verify'> {
  readonly ticketId: number;
  /** Ticket label for the log line. */
  readonly key: string;
  readonly rounds: ConflictRounds;
  /** Null when the merge is finished and the ship-stage gates pass on it; else the reason. */
  readonly verifyMerge: (pr: DeliverPr, round: ResolvedRound) => Promise<string | null>;
  readonly runGates: (prs: readonly DeliverPr[]) => Promise<string | null>;
  /** The dashboard's transient "Delivering resolved merge to PR #n…" line. */
  readonly status: (message: string) => void;
  /** The INFO log line (not the user toast). */
  readonly log: (message: string) => void;
}

const inFlight = new Set<number>();

/** Run on a Stop/session.idle of a ticket; a no-op unless a Resolve-conflicts round is armed for it. */
export async function autoDeliverAfterConflict(d: AutoDeliverDeps): Promise<void> {
  const round = d.rounds.armed(d.ticketId);
  if (round === null || inFlight.has(d.ticketId) || d.agentActive()) return;
  const targets = d.targets();
  if (!targets.available) return; // not at ship, no open PR, or a ship run is in flight: the manual button decides
  inFlight.add(d.ticketId);
  try {
    const pr = targets.prs.find((p) => p.repo === round.repo) ?? targets.prs[0]!;
    d.status(`Delivering resolved merge to PR #${pr.number ?? '?'}…`);
    const outcome = await deliverToPr({
      ...d,
      verify: async () => {
        const unfinished = await d.verifyMerge(pr, round);
        if (unfinished !== null) {
          d.error(`conflict resolve did not finish: ${unfinished}`);
          return unfinished;
        }
        const failed = await d.runGates(targets.prs);
        if (failed !== null) d.error(`Resolved merge not delivered: a ship-stage gate failed — ${failed}`);
        return failed;
      },
    });
    if (outcome.kind === 'delivered') d.rounds.disarm(d.ticketId);
    d.log(`[ship] ticket ${d.key} auto-deliver after conflict resolve: ${outcome.kind}${'reason' in outcome ? ` (${outcome.reason})` : ''}`);
  } finally {
    inFlight.delete(d.ticketId);
  }
}

/**
 * Arm the round for a Resolve-conflicts click. Only at `ship` (the one stage with
 * no marker to end the session) and only for a recorded conflict; any other click
 * leaves the session's commits to the manual Deliver button.
 */
export function armConflictRound(store: Store, rounds: ConflictRounds, ticketId: number, repo: string): void {
  if (getTicket(store, ticketId).stageCurrent !== 'ship') return;
  const check = getMergeCheck(store, ticketId, repo);
  if (!check || check.state !== 'conflicted') return;
  rounds.arm(ticketId, { repo, baseSha: check.baseSha, files: check.files });
}

/** Resolve-conflicts sessions at ship whose resolved merge Karst delivers on idle (D247). */
export const conflictRounds = createConflictRounds();
