import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { hasAttendedShipRun, listShipRuns, listShipRepoSteps, newestPushIntentHead, type ShipRun } from '../../store/shipRuns.js';
import { isGitHubServerError } from '../../integrations/githubServerError.js';
import { planRetryShip } from '../../ui/dashboard/insideActions.js';

/**
 * Autopilot retries a ship a person already confirmed when every failure of its newest run is a GitHub server error
 * (D838): the person's Confirm/Retry ship is the consent, so the retry repeats the SAME ship and publishes nothing new.
 * The budget comes from the run history, so no schema change and no new budget kind is needed (@arch:AP-11).
 */

/** The wait before automatic retry n (1-based): 2, 5, 10, 20 and 30 minutes after the newest failed run ended. */
export const AUTO_SHIP_RETRY_DELAYS_MS: readonly number[] = [2, 5, 10, 20, 30].map((m) => m * 60_000);

/** How many automatic retries one outage gets before Autopilot stops. */
export const MAX_AUTO_SHIP_RETRIES = AUTO_SHIP_RETRY_DELAYS_MS.length;

/** The one stop line of rule 6. No block is written: the failed stage keeps its Retry ship. */
export const AUTO_SHIP_RETRY_STOP_REASON = `auto-fix stopped: GitHub server error, ship retried ${MAX_AUTO_SHIP_RETRIES}/${MAX_AUTO_SHIP_RETRIES}`;

/**
 * What the Retry ship seam reports: the saga started (it records its own failure on the ship stage), or the host drains
 * for a reload and the ship did not run.
 */
export type ShipRetryOutcome = { readonly kind: 'sent' } | { readonly kind: 'busy' };

/**
 * The worktree reads of rule 5, injected so tests use fakes. An unreadable state (a failed `git`, no worktree) is never
 * a pass: it does not retry.
 */
export interface ShipRetrySeams {
  /**
   * `git status --porcelain -uall`: `ok: false` when the state cannot be read. Never rejects: an unreadable state is the
   * `ok: false` answer.
   */
  readonly worktreeClean: (repo: string) => Promise<{ readonly ok: true; readonly clean: boolean } | { readonly ok: false }>;
  /** The worktree HEAD of the repo, or null when it cannot be read. Never rejects. */
  readonly localHead: (repo: string) => Promise<string | null>;
}

export type ShipRetryDecision =
  | { readonly kind: 'retry'; readonly repos: readonly string[]; readonly n: number }
  | { readonly kind: 'wait'; readonly until: number }
  /** `runId`: the failed run the stop belongs to, so the engine writes its one event per run. */
  | { readonly kind: 'park'; readonly reason: string; readonly runId: number }
  | { readonly kind: 'none'; readonly why: string };

const none = (why: string): ShipRetryDecision => ({ kind: 'none', why });

/** Rule 4: the run has failed steps and EVERY one is a push/pr step whose detail is a GitHub server error. */
function serverErrorOnly(store: Store, run: ShipRun): boolean {
  const failed = listShipRepoSteps(store, run.id).filter((s) => s.status === 'failed');
  return failed.length > 0 && failed.every((s) => (s.step === 'push' || s.step === 'pr') && isGitHubServerError(s.detail));
}

/**
 * The ship-retry decision (@arch:AP-11): a failed, unblocked ship stage; a person's confirmed run at or before the newest
 * failed run; a newest run that failed only on GitHub server errors; nothing new to publish; and the backoff elapsed.
 * Store reads only, plus the injected worktree seams.
 */
export async function shipRetryDecision(store: Store, ticketId: number, now: number, seams: ShipRetrySeams): Promise<ShipRetryDecision> {
  if (getTicket(store, ticketId).stageCurrent !== 'ship') return none('the ticket is not at ship');
  const stage = getStage(store, ticketId, 'ship');
  if (stage === null || stage.status !== 'failed') return none('the ship stage is not failed');
  if (stageBlock(store, ticketId, 'ship') !== null) return none('the ship stage has a block');
  // Rule 5's repo list comes before the run checks: with no failed step anywhere there is nothing Retry ship could run.
  const plan = planRetryShip(store, ticketId);
  if ('reason' in plan) return none(plan.reason);
  // The scan sees one run past the bound: enough to read `n > MAX` and park.
  const runs = listShipRuns(store, ticketId, MAX_AUTO_SHIP_RETRIES + 2);
  // A repo with a failed step belongs to a run, so a repo list implies a run: `runs[0]` is always here.
  const newest = runs[0]!;
  if (newest.status !== 'failed') return none('the newest ship run did not fail');
  // Rule 3: a person's Confirm/Retry ship opened this ship's series (an unattended resume can only follow one).
  if (!hasAttendedShipRun(store, ticketId)) return none('no person confirmed a ship');
  if (!serverErrorOnly(store, newest)) return none('the failed ship was not a GitHub server error');
  // Nothing new would be published: every repo Retry ship would re-run must hold exactly the pushed head.
  for (const repo of plan.repos) {
    const state = await seams.worktreeClean(repo);
    if (!state.ok) return none(`the worktree of ${repo} cannot be read`);
    if (!state.clean) return none(`the worktree of ${repo} has uncommitted changes`);
    const head = await seams.localHead(repo);
    const pushed = newestPushIntentHead(store, ticketId, repo);
    if (head === null || head !== pushed) return none(`the head of ${repo} is not the head the ship pushed`);
  }
  // Rule 6: the consecutive newest runs that failed only on server errors. A passed run or another failure stops it.
  let n = 0;
  for (const r of runs) {
    if (r.status !== 'failed' || !serverErrorOnly(store, r)) break;
    n += 1;
  }
  if (n > MAX_AUTO_SHIP_RETRIES) return { kind: 'park', reason: AUTO_SHIP_RETRY_STOP_REASON, runId: newest.id };
  // A run with no end time, and one with an unreadable end time, never retry.
  const ended = newest.endedAt;
  if (ended === null) return none('the newest failed ship run has no end time');
  const endedAt = Date.parse(ended);
  if (Number.isNaN(endedAt)) return none('the newest failed ship run has an unreadable end time');
  const until = endedAt + AUTO_SHIP_RETRY_DELAYS_MS[n - 1]!;
  if (now < until) return { kind: 'wait', until };
  return { kind: 'retry', repos: plan.repos, n };
}
