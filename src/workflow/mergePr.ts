import type { Store } from '../store/db.js';
import { findTicketPr, listCurrentPrsByTicket, updatePrDetail } from '../store/prs.js';
import { listPrsByTicket } from '../store/dashboard.js';
import { listMergeChecksByTicket } from '../store/mergeChecks.js';
import { buildPrPanelRows } from '../model/prPanelView.js';
import { MERGE_ALL_NONE_READY, MERGE_ALL_ROUND_RUNNING } from '../model/mergeAll.js';
import { NO_AUTOFIX, NO_OFFERS } from '../model/prMergeReadiness.js';
import {
  fetchPrDetail,
  fetchPrHeadSha,
  mergePr,
  defaultGhRunnerAsync,
  UNKNOWN_PR_DETAIL,
  type GhRunner,
  type MergeMethod,
  type PrDetail,
  type PrStatus,
} from '../integrations/github.js';
import { settleShipGate } from './mergeGate.js';
import { integrateAndReleaseParent } from './subtaskIntegration.js';
import { defaultGitRunner, type GitRunner } from '../integrations/git.js';

/**
 * Merge one repo's PR for a ticket, from the ship stage, and record what actually
 * happened.
 *
 * Host-agnostic: takes the store and an injected `gh`, so it runs under vitest
 * with a fake runner and holds no vscode, no clock, no confirmation dialog. The
 * host owns the confirmation (a merge is irreversible) and the wording of the
 * toast; this owns the operation and the truth about its outcome.
 *
 * The contract that matters: **a zero exit is never taken as proof.** The stored
 * status and the returned verdict both come from a fresh `gh pr view` AFTER the
 * merge, so the UI can only show merged when the PR really is. The two honest
 * asymmetries that falls out of:
 *
 *  - gh refused but the PR reads merged (a teammate merged it, a retry after a
 *    partial failure) → success. The outcome the user asked for is true.
 *  - gh accepted but the PR does not read merged (a queued/blocked merge, a
 *    probe that cannot see it) → NOT success, with the state named. Silence here
 *    is what would let the panel lie about an irreversible action.
 */
export interface MergeTicketPrOpts {
  ticketId: number;
  /** The repository the PR belongs to (a repo path, as `prs.repo` stores it). */
  repo: string;
  /** How to merge. Always explicit — the host asks the user which. */
  method: MergeMethod;
  /** Tracked commits (host and sandbox) this PR lacks; above 0 refuses the merge (arch:GH-03). Absent = not tracked. */
  unpushed?: number;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[merge]`,
   * threaded into the post-merge settlement. Absent → no debug lines; the
   * host binds it to `Logger.debug` (a no-op unless the manifest's `debug`
   * flag is on).
   */
  debug?: (message: string) => void;
}

export interface MergeTicketPrResult {
  /** True only when the PR is confirmed merged afterwards. */
  ok: boolean;
  /**
   * True when this merge was the LAST one outstanding and the ticket therefore
   * advanced from `ship` to `done`. False on a multi-repo ticket with PRs still
   * open — the ticket stays parked at `ship`, blocked on the rest.
   *
   * Reported rather than left for the caller to re-derive, so the post-merge
   * provider status push fires exactly once, on the call that actually finished
   * the ticket.
   */
  completedTicket: boolean;
  /**
   * The PR's status as it now stands: the re-probed value when gh could see it,
   * else the last stored one. Null only when there was no PR to act on at all.
   */
  status: PrStatus | string | null;
  /** Why it did not merge, in gh's own words where there are any; '' on success. */
  reason: string;
}

/** A probe must never sink the operation it observes: failure reads as unknown. */
async function probe(gh: GhRunner, url: string, cwd: string): Promise<PrDetail> {
  try {
    return await fetchPrDetail(gh, url, cwd);
  } catch {
    return UNKNOWN_PR_DETAIL;
  }
}

/**
 * Let the merge gate re-read the ticket now that this PR has landed.
 *
 * Swallows, deliberately: the merge is done and undoable by nobody, so a
 * bookkeeping failure must not be reported as a failed merge. The gate is
 * idempotent and the background sweep runs it again on the next tick, so the
 * ticket still reaches `done` — just later.
 */
async function settle(
  store: Store,
  ticketId: number,
  git: GitRunner,
  debug?: (message: string) => void,
): Promise<boolean> {
  try {
    const result = settleShipGate(store, ticketId, debug);
    if (result.landedSubtaskParentId !== null) {
      await integrateAndReleaseParent(store, result.landedSubtaskParentId, git, debug);
    }
    return result.advanced;
  } catch {
    return false;
  }
}

/** The reason Merge refuses a PR whose head lacks commits the ticket holds locally (arch:GH-03, reason `unpushed`). */
export function unpushedReason(count: number): string {
  return `${count} ${count === 1 ? 'commit is' : 'commits are'} not on the pull request. Push with Deliver to PR first; Merge lands only the head that review passed.`;
}

/**
 * Read the PR head and count the local commits it lacks. A PR head that gh or git cannot read gives no
 * verdict (the advisory read fails open); a head that is read is pinned on the merge.
 */
async function checkHead(
  gh: GhRunner,
  git: GitRunner,
  url: string,
  cwd: string,
): Promise<{ readonly pin: string | null; readonly refusal: string | null }> {
  const pin = await fetchPrHeadSha(gh, url, cwd);
  if (pin === null) return { pin: null, refusal: null };
  const count = async (): Promise<number | null> => {
    const r = await git(['rev-list', '--count', `${pin}..HEAD`], cwd);
    const n = Number(r.stdout.trim());
    return r.exitCode === 0 && Number.isInteger(n) ? n : null;
  };
  let ahead = await count();
  if (ahead === null) {
    // The PR head may not be in the local clone yet (a push from elsewhere): fetch it once, then count again.
    await git(['fetch', 'origin', pin], cwd);
    ahead = await count();
  }
  if (ahead === null) return { pin, refusal: `Could not compare the pull request head ${pin.slice(0, 7)} with the local head. Fetch it and try again.` };
  return { pin, refusal: ahead > 0 ? unpushedReason(ahead) : null };
}

export async function mergeTicketPr(
  store: Store,
  opts: MergeTicketPrOpts,
  gh: GhRunner = defaultGhRunnerAsync,
  git: GitRunner = defaultGitRunner,
): Promise<MergeTicketPrResult> {
  // The store decides what is mergeable, not the caller: the repo arrives from a
  // webview message and a stale panel can name a PR that has since gone.
  const pr = findTicketPr(store, opts.ticketId, opts.repo);
  if (!pr) {
    return {
      ok: false,
      status: null,
      completedTicket: false,
      reason: `No pull request is recorded for "${opts.repo}" on this ticket — nothing to merge.`,
    };
  }
  // Already merged: the desired state, reached earlier. Not an error, and not a
  // reason to run an irreversible command a second time. Still settles: the
  // ticket can still be blocked at `ship` because a DIFFERENT repo was the
  // holdout, and a click on the landed one is as good a moment as any to notice
  // it has caught up.
  if (pr.status === 'merged') {
    return {
      ok: true,
      status: 'merged',
      completedTicket: await settle(store, opts.ticketId, git, opts.debug),
      reason: '',
    };
  }

  if ((opts.unpushed ?? 0) > 0) return { ok: false, status: pr.status, completedTicket: false, reason: unpushedReason(opts.unpushed ?? 0) };
  const head = await checkHead(gh, git, pr.url, pr.cwd);
  if (head.refusal !== null) return { ok: false, status: pr.status, completedTicket: false, reason: head.refusal };
  const attempt = await mergePr(gh, pr.url, pr.cwd, opts.method, head.pin ?? undefined);
  const detail = await probe(gh, pr.url, pr.cwd);
  // Persist whatever the probe could see, pass or fail: a refused merge still
  // brings back the comments and status that explain the refusal, and
  // `updatePrDetail` drops an unknown status rather than overwriting a real one.
  updatePrDetail(store, { ticketId: pr.ticketId, repo: pr.repo, url: pr.url, detail });

  const status = detail.status === 'unknown' ? pr.status : detail.status;
  if (detail.status === 'merged') {
    return {
      ok: true,
      status: 'merged',
      completedTicket: await settle(store, opts.ticketId, git, opts.debug),
      reason: '',
    };
  }
  if (!attempt.ok) return { ok: false, status, completedTicket: false, reason: attempt.reason };
  return {
    ok: false,
    status,
    completedTicket: false,
    reason:
      detail.status === 'unknown'
        ? 'gh reported the merge succeeded, but karst could not confirm it on GitHub. Check the pull request before retrying.'
        : `gh reported the merge succeeded, but the pull request still reads ${detail.status}.`,
  };
}

/** The one method Merge all uses: its modal offers a single confirm button, so the method is fixed. */
export const MERGE_ALL_METHOD: MergeMethod = 'squash';

/** One pull request in the Merge all plan. */
export interface MergeAllItem {
  readonly repo: string;
  /** The label the modal shows: the manifest name, else the repo value. */
  readonly name: string;
  readonly number: number | null;
  readonly baseRef: string | null;
}

/** What the confirmation shows: the PRs that merge, and the open ones left out because they are blocked. */
export interface MergeAllPlan {
  readonly ready: readonly MergeAllItem[];
  readonly skipped: readonly MergeAllItem[];
}

/** Split the ticket's open PRs into the ready set and the blocked set, both in manifest repository order. */
export function planMergeAll(
  store: Store,
  ticketId: number,
  repoOrder: readonly string[],
  repoNameFor: (repo: string) => string | undefined,
  now: string,
  unpushed: (repo: string) => number = () => 0,
): MergeAllPlan {
  const current = new Set(listCurrentPrsByTicket(store, ticketId).map((p) => `${p.repo}\u0000${p.url}`));
  const views = listPrsByTicket(store, ticketId).filter((p) => p.url !== null && current.has(`${p.repo}\u0000${p.url}`));
  const rows = buildPrPanelRows(views, now, repoNameFor, { mergeChecks: listMergeChecksByTicket(store, ticketId), offers: NO_OFFERS, autofix: NO_AUTOFIX, unpushed });
  const rank = (repo: string): number => {
    const i = repoOrder.indexOf(repo);
    return i === -1 ? repoOrder.length : i;
  };
  const open = rows
    .filter((r) => r.status !== 'merged' && r.status !== 'closed' && !r.dismissed)
    .sort((a, b) => rank(a.repo) - rank(b.repo));
  const item = (r: (typeof rows)[number]): MergeAllItem => ({ repo: r.repo, name: r.repoDisplay || r.repo, number: r.number, baseRef: r.baseRef });
  return {
    ready: open.filter((r) => r.readiness.ready).map(item),
    skipped: open.filter((r) => !r.readiness.ready).map(item),
  };
}

export interface MergeAllDeps {
  readonly ticketId: number;
  /** The ticket's repositories in manifest order (the merge order). */
  readonly repoOrder: readonly string[];
  readonly repoNameFor: (repo: string) => string | undefined;
  readonly now: () => string;
  /** Re-probe every PR of the ticket (gh per PR) so the plan reads fresh facts. */
  readonly refresh: () => Promise<void>;
  /** True while an Autopilot auto-fix round runs for the ticket. */
  readonly autofixRunning: () => boolean;
  /** Commits the ticket holds that one PR lacks; that PR is not ready while this is above 0 (arch:GH-03). Absent = 0. */
  readonly unpushed?: (repo: string) => number;
  /** The one modal. Resolves true on confirm, false on cancel. */
  readonly confirm: (plan: MergeAllPlan) => Promise<boolean>;
  readonly merge?: (repo: string) => Promise<MergeTicketPrResult>;
  readonly debug?: (message: string) => void;
}

export type MergeAllOutcome =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'done';
      readonly merged: readonly MergeAllItem[];
      /** The first failure; the PRs after it were not tried. Null when every merge succeeded. */
      readonly failed: { readonly item: MergeAllItem; readonly reason: string } | null;
      readonly completedTicket: boolean;
    };

/** One Merge all runs per ticket at a time. */
const running = new Set<number>();

/**
 * Merge every ready pull request of a ticket. It re-probes first, asks ONE confirmation, then merges one after
 * another in manifest order through `mergeTicketPr` and stops at the first failure (the failure is returned; the
 * PRs after it stay open). The ready set is the re-probed one, never what the panel last showed.
 */
export async function mergeAllPrs(store: Store, deps: MergeAllDeps): Promise<MergeAllOutcome> {
  const { ticketId } = deps;
  if (deps.autofixRunning()) return { kind: 'refused', reason: MERGE_ALL_ROUND_RUNNING };
  if (running.has(ticketId)) return { kind: 'refused', reason: 'Merge all is already running for this ticket.' };
  running.add(ticketId);
  try {
    await deps.refresh();
    // A round can start while the probe runs; the check is repeated before anything irreversible.
    if (deps.autofixRunning()) return { kind: 'refused', reason: MERGE_ALL_ROUND_RUNNING };
    const plan = planMergeAll(store, ticketId, deps.repoOrder, deps.repoNameFor, deps.now(), deps.unpushed);
    if (plan.ready.length === 0) return { kind: 'refused', reason: MERGE_ALL_NONE_READY };
    if (!(await deps.confirm(plan))) return { kind: 'cancelled' };
    // The modal can stay open for minutes; a round may have started meanwhile.
    if (deps.autofixRunning()) return { kind: 'refused', reason: MERGE_ALL_ROUND_RUNNING };
    const merge = deps.merge ?? ((repo: string) => mergeTicketPr(store, { ticketId, repo, method: MERGE_ALL_METHOD, ...(deps.unpushed ? { unpushed: deps.unpushed(repo) } : {}), ...(deps.debug ? { debug: deps.debug } : {}) }));
    const merged: MergeAllItem[] = [];
    let completedTicket = false;
    for (const item of plan.ready) {
      deps.debug?.(`[merge-all] merging ${item.repo}`);
      const result = await merge(item.repo);
      if (!result.ok) return { kind: 'done', merged, failed: { item, reason: result.reason }, completedTicket };
      merged.push(item);
      completedTicket = completedTicket || result.completedTicket;
    }
    return { kind: 'done', merged, failed: null, completedTicket };
  } finally {
    running.delete(ticketId);
  }
}
