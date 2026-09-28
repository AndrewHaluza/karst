import type { Store } from '../../store/db.js';
import { listWorktreesByTicket, listPrsByTicket, type PrView } from '../../store/dashboard.js';
import { listMergeChecksByTicket, type MergeCheckRow } from '../../store/mergeChecks.js';
import { listCurrentPrsByTicket } from '../../store/prs.js';
import { getEnvOverrides, type TicketEnvOverrides } from '../../store/ticketEnvOverrides.js';
import { buildPrPanelRows, type PrPanelRow } from '../../model/prPanelView.js';
import { buildMergeCheckPanelRows, type MergeCheckPanelRow } from '../../model/mergeCheckPanel.js';
import { repoDisplayPath, type PathContext } from '../worktreePath.js';
import type { DashboardWorktreeView } from './stateTypes.js';

/** The ticket's PR rows with their display path attached, as the reducers read them. */
export type DashboardPrRow = PrView & { repoDisplay: string };

/** The injected host facts row construction needs — never read from the manifest here. */
export interface DashboardRowsInput {
  ticketId: number;
  /** The ticket's own runnable repositories, in scope order. */
  selectedRepos: readonly string[];
  /** ONE clock read shared with the rest of the snapshot (the PR stamps). */
  now: string;
  pathContext?: PathContext;
  /** Whether a worktree may offer the "Launch Dev" action. */
  isCheckout: (path: string) => boolean;
  /** Whether a scoped repository declares a runnable service. */
  isRepoRunnable: (repo: string) => boolean;
  /** The manifest's resolved default base branch for a repo path. */
  baseBranchDefaultFor: (repoPath: string) => string;
  /** The base-branch candidates for a repo path — loaded lazily host-side. */
  baseBranchCandidatesFor: (repoPath: string) => string[];
  /** The manifest repository NAME for a recorded repo value (tables key by path). */
  repoNameFor: (repo: string) => string | undefined;
}

/** The dashboard's scope rows and the mergeability facts the rail and panels share. */
export interface DashboardRows {
  worktrees: DashboardWorktreeView[];
  prs: DashboardPrRow[];
  /** The PRs already worded host-side (`model/prPanelView.ts`). */
  prRows: PrPanelRow[];
  mergeChecks: MergeCheckRow[];
  /** The mergeability verdicts worded host-side (`model/mergeCheckPanel.ts`). */
  mergeCheckRows: MergeCheckPanelRow[];
  /** Repos whose CURRENT PR karst currently offers to merge. */
  mergeableRepos: string[];
  /** False when nothing in scope declares a service — nothing can ever start. */
  hasRunnableRepos: boolean;
  /** The ticket's env overrides and the services they may be set for. */
  envOverrides: { services: string[]; values: TicketEnvOverrides };
}

/**
 * Build the dashboard's scope/PR/mergeability rows in one place.
 *
 * The PR rows are worded through the SAME `model/prPanelView.ts` the ship strip
 * reads, and the mergeability allow-list is scoped to each repo's CURRENT PR
 * (`listCurrentPrsByTicket`, the one `CURRENT_PR_ORDER` rule `findTicketPr`
 * applies) so the rail can never fire a merge the panel's own button refuses.
 */
export function buildDashboardRows(store: Store, input: DashboardRowsInput): DashboardRows {
  const {
    ticketId,
    selectedRepos,
    now,
    pathContext,
    isCheckout,
    isRepoRunnable,
    baseBranchDefaultFor,
    baseBranchCandidatesFor,
    repoNameFor,
  } = input;

  const worktrees: DashboardWorktreeView[] = listWorktreesByTicket(store, ticketId).map((w) => ({
    ...w,
    repoDisplay: repoDisplayPath(w.repo, pathContext),
    launchable: isCheckout(w.path),
    baseDefault: baseBranchDefaultFor(w.repo),
    baseCandidates: baseBranchCandidatesFor(w.repo),
    serviceName: repoNameFor(w.repo),
  }));

  // Rendered through the SAME path-display preference as the worktree rows: the
  // ship stage names the same directories, and two formats for one path is the
  // bug this replaces.
  const prs = listPrsByTicket(store, ticketId).map((p) => ({
    ...p,
    repoDisplay: repoDisplayPath(p.repo, pathContext),
  }));
  // Read ONCE and share: the PR panel and the ship strip must never describe the
  // same three-valued fact from two different reads.
  const mergeChecks = listMergeChecksByTicket(store, ticketId);
  // The dashboard's PR rows, host-worded and host-decided like every other
  // panel string. Hoisted so the rail and the panel share one mergeability read.
  const prRows = buildPrPanelRows(prs, now, repoNameFor);
  // The repos whose CURRENT PR karst currently offers to merge. This is the rail's
  // licence to ACT on a single waiting repo, so it must be scoped exactly like the
  // Merge the rail would fire: to the repo's CURRENT PR (`listCurrentPrsByTicket`,
  // the one `CURRENT_PR_ORDER` rule `findTicketPr` also applies), never to every
  // historical row a re-shipped repo still carries. Within that scope the verdict
  // is read off the panel rows' own `canMerge` — one answer to "may this repo be
  // merged". Two would let the rail fire an irreversible merge the panel's own
  // button refuses (GitHub reports it blocked, or an older open row lingers beside
  // the draft the repo now means).
  const currentPrKeys = new Set(
    listCurrentPrsByTicket(store, ticketId).map((p) => `${p.repo}\u0000${p.url}`),
  );
  const mergeableRepos = prRows
    .filter((p) => p.url !== null && currentPrKeys.has(`${p.repo}\u0000${p.url}`))
    .filter((p) => p.canMerge)
    .map((p) => p.repo);

  return {
    worktrees,
    prs,
    prRows,
    mergeChecks,
    mergeCheckRows: buildMergeCheckPanelRows(mergeChecks, now),
    mergeableRepos,
    // Drives whether "Start servers" is offered at all. A ticket scoping only
    // non-runnable repositories can never have a server, so presenting a live
    // Start button there is a dead affordance dressed as an available action.
    hasRunnableRepos: selectedRepos.some((r) => isRepoRunnable(r)),
    envOverrides: {
      services: selectedRepos.filter((r) => isRepoRunnable(r)),
      values: getEnvOverrides(store, ticketId),
    },
  };
}
