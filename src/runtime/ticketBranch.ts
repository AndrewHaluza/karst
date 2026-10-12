import type { Manifest } from '../manifest/types.js';
import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import { resolveTicketType } from '../workflow/conventionContext.js';
import { renderBranchName, suffixBranchForCollision } from './branchName.js';
import { worktreeSlug } from './slug.js';

/** Git remote a worktree branch is published to. */
const REMOTE = 'origin';

/**
 * The distinct repository paths a set of hot manifest entries maps to. Entries
 * sharing a `repoPath` (a monorepo with several processes) collapse to one — the
 * same dedup the worktree loop performs, so a collision probe never repeats.
 */
export function distinctRepoPaths(manifest: Manifest, hot: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const name of hot) {
    const repo = manifest.repositories[name];
    if (repo) paths.add(repo.repoPath);
  }
  return [...paths];
}

/** The ticket fields both derivations need. */
export interface BranchTicket {
  id: number;
  key: string | null;
  title: string | null;
  type: string | null;
}

/**
 * The worktree slug (path leaf) and branch name for one ticket.
 *
 * Both are per-TICKET, never per-repository: every repo the ticket scopes gets
 * the same pair, which is what lets `spin`/`confirmScope`/`preflight` dedup their
 * loops by `repoPath`. Computed here once so those three can never disagree about
 * what branch a ticket is on.
 */
export function ticketWorktreeNames(
  ticket: BranchTicket,
  manifest?: Manifest,
): { slug: string; branch: string } {
  const slug = worktreeSlug(ticket);
  const branch = renderBranchName(manifest?.conventions?.branchName, {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    slug,
    type: resolveTicketType(ticket, manifest?.conventions),
  });
  return { slug, branch };
}

/**
 * True when a LIVE (non-archived) ticket's `worktrees` row already carries
 * `branch`. Such a branch is a real ticket's — this ticket resuming, or another
 * ticket still in flight — so it must never be suffixed; only a branch left on
 * `origin` by a since-archived ticket is safe to disambiguate (`T640`).
 */
export function branchOwnedByLiveTicket(store: Store, branch: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 FROM worktrees w
       JOIN tickets t ON t.id = w.ticket_id
       WHERE w.branch = ? AND t.archived_at IS NULL
       LIMIT 1`,
    )
    .get(branch);
  return row !== undefined;
}

/**
 * The branch a NEW worktree should be cut on: `renderedBranch` unless it collides
 * with an existing `origin` branch that no live ticket owns, in which case the
 * ticket id is appended (`suffixBranchForCollision`). Pure decision — the probe
 * and ownership read happen in `resolveWorktreeBranch`.
 */
export function decideWorktreeBranch(
  renderedBranch: string,
  ticketId: number,
  collision: { remoteExists: boolean; ownedByLiveTicket: boolean },
): string {
  if (!collision.remoteExists || collision.ownedByLiveTicket) return renderedBranch;
  return suffixBranchForCollision(renderedBranch, ticketId);
}

/**
 * Resolve the branch for a worktree about to be created, checking whether
 * `origin` already carries it. A branch a live ticket already owns (a resume) is
 * returned untouched without touching the network. A branch left on `origin` by
 * an older, archived ticket would make the eventual `git push` a non-fast-forward
 * (T640), so it is suffixed with this ticket's id.
 *
 * Best-effort by construction: a failed `ls-remote` (offline, no `origin`) is
 * reported and the rendered branch stands — never a reason worktree creation
 * cannot proceed.
 */
export async function resolveWorktreeBranch(
  store: Store,
  git: GitRunner,
  repoPaths: readonly string[],
  renderedBranch: string,
  ticketId: number,
  debug?: (message: string) => void,
): Promise<string> {
  if (branchOwnedByLiveTicket(store, renderedBranch)) return renderedBranch;

  let remoteExists = false;
  for (const repoPath of repoPaths) {
    const r = await git(['ls-remote', REMOTE, `refs/heads/${renderedBranch}`], repoPath);
    if (r.exitCode !== 0) {
      debug?.(
        `[runtime] branch collision check in ${repoPath} failed (exit ${r.exitCode}) — ` +
          `keeping '${renderedBranch}'`,
      );
      continue;
    }
    if (r.stdout.trim() !== '') {
      remoteExists = true;
      break;
    }
  }

  const resolved = decideWorktreeBranch(renderedBranch, ticketId, {
    remoteExists,
    ownedByLiveTicket: false,
  });
  if (resolved !== renderedBranch) {
    debug?.(
      `[runtime] branch '${renderedBranch}' exists on ${REMOTE} and is unowned — ` +
        `using '${resolved}'`,
    );
  }
  return resolved;
}
