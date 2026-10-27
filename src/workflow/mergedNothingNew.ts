import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { listTickets } from '../store/tickets.js';
import { listCurrentPrsByTicket, recordShippedPr, updatePrStatus } from '../store/prs.js';
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
  url: string | null;
  /** 'github' = no store row; the caller that may write adopts it. */
  source: 'store' | 'github';
}

/** Where to look on GitHub when the store has no PR row (a hand-opened PR). */
export interface MergedPrHint {
  branch: string | null | undefined;
  baseRef: string | null | undefined;
}

interface GhMergedPr {
  number: number;
  url: string;
  headRefOid: string;
  baseRefName: string;
  mergedAt: string;
  headRepositoryOwner?: { login?: string } | null;
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
  hint?: MergedPrHint,
): Promise<MergedNothingNew | null> {
  const current = listCurrentPrsByTicket(deps.store, ticketId).find((p) => p.repo === repo);
  let found: { number: number; url: string | null; mergedHead: string; source: 'store' | 'github' };
  if (current) {
    const number = currentMergedPrNumber(deps.store, ticketId, repo);
    if (number === null) return null;
    const view = await deps.gh(
      ['pr', 'view', String(number), '--json', 'headRefOid', '--jq', '.headRefOid'],
      cwd,
    );
    const mergedHead = view.exitCode === 0 ? view.stdout.trim() : '';
    if (mergedHead === '') return null;
    found = { number, url: current.url, mergedHead, source: 'store' };
  } else {
    const pr = hint ? await findHandMergedPr(deps, cwd, hint) : null;
    if (!pr) return null;
    found = { number: pr.number, url: pr.url, mergedHead: pr.headRefOid, source: 'github' };
  }
  const head = await headCommit(deps.git, cwd);
  if (head === null) return null;
  const landed = { number: found.number, url: found.url, source: found.source };
  if (head === found.mergedHead) return landed;
  const diff = await deps.git(['diff', '--quiet', found.mergedHead, 'HEAD'], cwd);
  return diff.exitCode === 0 ? landed : null;
}

const branchOf = (ref: string): string => ref.replace(/^(refs\/remotes\/)?origin\//, '');

/** Owner login of the `origin` remote, or null when unreadable. */
async function originOwner(git: GitRunner, cwd: string): Promise<string | null> {
  const r = await git(['remote', 'get-url', 'origin'], cwd);
  if (r.exitCode !== 0) return null;
  return /[:/]([^/:]+)\/[^/]+?(?:\.git)?\s*$/.exec(r.stdout.trim())?.[1] ?? null;
}

/**
 * The newest MERGED PR from this branch into the ticket's base, from origin
 * itself (not a fork). Read-only; any failed read or bad JSON answers null.
 */
async function findHandMergedPr(
  deps: { git: GitRunner; gh: GhRunner },
  cwd: string,
  hint: MergedPrHint,
): Promise<GhMergedPr | null> {
  if (!hint.branch || !hint.baseRef) return null;
  const list = await deps.gh(
    [
      'pr', 'list', '--head', hint.branch, '--state', 'merged', '--json',
      'number,url,headRefOid,baseRefName,mergedAt,headRepositoryOwner',
    ],
    cwd,
  );
  if (list.exitCode !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const owner = await originOwner(deps.git, cwd);
  if (owner === null) return null;
  const base = branchOf(hint.baseRef);
  const matches = (parsed as GhMergedPr[]).filter(
    (p) =>
      typeof p?.number === 'number' &&
      typeof p.url === 'string' &&
      typeof p.headRefOid === 'string' &&
      p.headRefOid !== '' &&
      p.baseRefName === base &&
      p.headRepositoryOwner?.login?.toLowerCase() === owner.toLowerCase(),
  );
  matches.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
  return matches[0] ?? null;
}

/** Record a GitHub-found merged PR in the store (idempotent per ticket/repo/url). */
export function adoptMergedPr(
  store: Store,
  ticketId: number,
  repo: string,
  landed: MergedNothingNew,
): void {
  if (landed.source !== 'github' || landed.url === null) return;
  recordShippedPr(store, { ticketId, repo, number: landed.number, url: landed.url });
  updatePrStatus(store, { ticketId, repo, url: landed.url, status: 'merged' });
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
      const adoptions: [string, MergedNothingNew][] = [];
      for (const wt of worktrees) {
        const landed = await probeMergedNothingNew(deps, ticket.id, wt.repo, wt.path, {
          branch: wt.branch,
          baseRef: wt.baseRef,
        });
        if (landed) adoptions.push([wt.repo, landed]);
        const status = landed ? await git(['status', '--porcelain'], wt.path) : null;
        if (!landed || status?.exitCode !== 0 || status.stdout.trim() !== '') {
          allLanded = false;
          break;
        }
      }
      if (!allLanded) continue;
      for (const [repo, landed] of adoptions) adoptMergedPr(store, ticket.id, repo, landed);
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
