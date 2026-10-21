import type { DeliverPr, DeliverTargets } from '../../workflow/deliverState.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';

/**
 * "Deliver to PR" (ship stage): put the commits of a hand-started fix session on
 * the open PR. The sandboxed agent only commits inside its clone and never
 * pushes (no GitHub egress, arch:AC-31), and a manual session has no done marker,
 * so nothing else syncs or pushes them. One action: sync the sandbox into the
 * host worktree (fast-forward only), then run ship's delivery push, then re-probe.
 */

export interface UndeliveredCounts {
  /** Commits on the host worktree branch that are not on the PR head. */
  readonly hostAhead: number;
  /** Commits in the sandbox clone that are not on the host branch (so not on the PR either). */
  readonly sandboxAhead: number;
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
}

export interface CountDeps {
  readonly git: (cwd: string, args: readonly string[]) => Promise<GitResult>;
  /**
   * Fetch the sandbox clone's branch into the host worktree and name the ref it
   * landed on; null when this worktree has no sandbox or the clone is unreadable.
   */
  readonly sandboxRef: (cwd: string) => Promise<string | null>;
}

async function countRange(deps: CountDeps, cwd: string, range: string): Promise<number> {
  const r = await deps.git(cwd, ['rev-list', '--count', range]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(n) ? n : 0;
}

/** Counts for one PR's repo. A failed read counts as 0: this line is advisory, the action re-derives. */
export async function countUndelivered(deps: CountDeps, pr: DeliverPr): Promise<UndeliveredCounts> {
  const ref = await deps.sandboxRef(pr.cwd);
  // Right after the fetch: FETCH_HEAD is what the sandbox read left behind.
  const sandboxAhead = ref === null ? 0 : await countRange(deps, pr.cwd, `HEAD..${ref}`);
  // `--no-write-fetch-head` keeps the sandbox's FETCH_HEAD (the divergence classifier reads it).
  await deps.git(pr.cwd, ['fetch', '--no-write-fetch-head', 'origin', pr.branch]);
  const hostAhead = await countRange(deps, pr.cwd, `origin/${pr.branch}..HEAD`);
  return { hostAhead, sandboxAhead };
}

export interface UndeliveredTracker {
  get(ticketId: number): UndeliveredCounts | undefined;
  set(ticketId: number, counts: UndeliveredCounts | undefined): void;
}

/** Counts live in memory, measured on the PR refresh and read by every snapshot. */
export function createUndeliveredTracker(): UndeliveredTracker {
  const byTicket = new Map<number, UndeliveredCounts>();
  return {
    get: (ticketId) => byTicket.get(ticketId),
    set: (ticketId, counts) => {
      if (counts === undefined || (counts.hostAhead === 0 && counts.sandboxAhead === 0)) byTicket.delete(ticketId);
      else byTicket.set(ticketId, counts);
    },
  };
}

/** Measure every open PR of a ticket and store the sum; a ticket with nothing to deliver is cleared. */
export async function refreshUndelivered(
  tracker: UndeliveredTracker,
  ticketId: number,
  targets: DeliverTargets,
  deps: CountDeps,
): Promise<void> {
  if (!targets.available) return tracker.set(ticketId, undefined);
  let hostAhead = 0;
  let sandboxAhead = 0;
  for (const pr of targets.prs) {
    const c = await countUndelivered(deps, pr);
    hostAhead += c.hostAhead;
    sandboxAhead += c.sandboxAhead;
  }
  tracker.set(ticketId, { hostAhead, sandboxAhead });
}

export interface DeliverDeps {
  readonly targets: () => DeliverTargets;
  /** True while an agent turn is running for the ticket. */
  readonly agentActive: () => boolean;
  /** Sandbox → host, fast-forward only. */
  readonly ensureSynced: () => Promise<EnsureSyncResult>;
  /** The existing sync blocker (Open sync diff / Carry); nothing is pushed. */
  readonly blocked: (reason: string, rewritten: boolean) => Promise<void>;
  /** Ship's push with `deliverToOpenPr`, saga-recorded. */
  readonly runShip: () => Promise<void>;
  /** Re-probe the PRs (@arch:GH-03). */
  readonly reprobe: () => Promise<void>;
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
  readonly afterServerChange: () => void;
}

const BUSY = 'Deliver to PR: agent is working; try when idle.';
const NOT_AVAILABLE = 'Deliver to PR is not available: the ticket has no open pull request at ship.';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function deliverToPr(d: DeliverDeps): Promise<void> {
  try {
    await run(d);
  } catch (err) {
    d.logError('deliverToPr failed', err);
    d.error(`Deliver to PR failed: ${message(err)}`);
  } finally {
    d.afterServerChange();
  }
}

async function run(d: DeliverDeps): Promise<void> {
  if (d.agentActive()) return d.error(BUSY);
  const targets = d.targets();
  if (!targets.available) {
    return targets.reason === 'in-flight' ? d.error('Deliver to PR: another ship run is in flight; try when idle.') : d.info(NOT_AVAILABLE);
  }
  const synced = await d.ensureSynced();
  if (!synced.ok) return d.blocked(synced.reason, synced.rewritten === true);
  // The sync can take a while: a turn or a ship run may have started meanwhile.
  if (d.agentActive()) return d.error(BUSY);
  await d.runShip();
  await d.reprobe();
  d.info('Delivered the ticket branch to the open pull request.');
}
