import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { listTickets } from '../store/tickets.js';
import { listCurrentPrsByTicket } from '../store/prs.js';
import { stageBlock, clearStageBlock } from '../store/stageBlocks.js';
import { getStage } from '../store/stages.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { transition } from './machine.js';
import type { GhRunner } from '../integrations/github.js';
import { headCommit, type GitRunner } from '../integrations/git.js';

/**
 * A repo whose CURRENT PR has merged and whose branch carries nothing beyond
 * it. Shipping that branch again would open a duplicate PR of landed code
 * (FIX-A-PR-MERGED-WHILE-SHIP-WAITS), so ship, the ship-gate sweep and the
 * ship preview all ask this one question.
 */
export interface MergedNothingNew {
  number: number;
}

/**
 * The repo's current PR number when it is merged, else null. Reads the store
 * only; the head oid is re-probed by `probeMergedNothingNew` (arch:GH-03).
 */
export function currentMergedPrNumber(store: Store, ticketId: number, repo: string): number | null {
  const current = listCurrentPrsByTicket(store, ticketId).find((p) => p.repo === repo);
  if (!current || current.status !== 'merged' || current.number === null) return null;
  return current.number;
}

/**
 * Whether `cwd`'s HEAD adds nothing to the repo's merged current PR: HEAD
 * equals the PR's head oid (re-probed with `gh pr view`, never the stored
 * row), or `git diff --quiet <mergedHead> HEAD` finds no content difference.
 * Any failed read answers null — an unreadable fact must never settle a
 * ticket or suppress a ship. Compared against the merged PR's own head, not
 * the base: a squash merge plus other landed PRs makes the base tree differ.
 */
export async function probeMergedNothingNew(
  deps: { store: Store; git: GitRunner; gh: GhRunner },
  ticketId: number,
  repo: string,
  cwd: string,
): Promise<MergedNothingNew | null> {
  const number = currentMergedPrNumber(deps.store, ticketId, repo);
  if (number === null) return null;
  const view = await deps.gh(
    ['pr', 'view', String(number), '--json', 'headRefOid', '--jq', '.headRefOid'],
    cwd,
  );
  const mergedHead = view.exitCode === 0 ? view.stdout.trim() : '';
  if (mergedHead === '') return null;
  const head = await headCommit(deps.git, cwd);
  if (head === null) return null;
  if (head === mergedHead) return { number };
  const diff = await deps.git(['diff', '--quiet', mergedHead, 'HEAD'], cwd);
  return diff.exitCode === 0 ? { number } : null;
}

/**
 * The ship-gate sweep's second settle path. `settleShipGate` needs the
 * `awaiting-merge` block, which a ticket waiting on its Confirm click does not
 * have — so a PR merged while ship waits would leave Confirm offered, and the
 * click would re-ship the branch. When every worktree of such a ticket is
 * merged-and-nothing-new (and clean), ship has nothing left to do: pass it, and
 * `done` follows (arch:DONE). Returns the ids that advanced.
 */
export async function settleMergedNothingNew(
  deps: { store: Store; git: GitRunner; gh: GhRunner },
  scope: ProjectScope = {},
  debug?: (message: string) => void,
): Promise<number[]> {
  const { store, git } = deps;
  const advanced: number[] = [];
  for (const ticket of listTickets(store, scope)) {
    if (ticket.stageCurrent !== 'ship') continue;
    if (stageBlock(store, ticket.id, 'ship')?.kind === 'awaiting-merge') continue;
    if (getStage(store, ticket.id, 'ship')?.status === 'running') continue;
    try {
      const worktrees = listWorktreesByTicket(store, ticket.id);
      if (worktrees.length === 0) continue;
      let allLanded = true;
      for (const wt of worktrees) {
        const landed = await probeMergedNothingNew(deps, ticket.id, wt.repo, wt.path);
        const status = landed ? await git(['status', '--porcelain'], wt.path) : null;
        if (!landed || status?.exitCode !== 0 || status.stdout.trim() !== '') {
          allLanded = false;
          break;
        }
      }
      if (!allLanded) continue;
      debug?.(`[merge] sweep: ticket ${ticket.id} waits at ship but every PR merged with nothing new — passing ship`);
      transition(store, ticket.id, 'ship', { kind: 'passed' }, () => {
        clearStageBlock(store, ticket.id, 'ship');
      });
      advanced.push(ticket.id);
    } catch {
      continue;
    }
  }
  return advanced;
}
