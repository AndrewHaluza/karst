import type { Manifest } from '../manifest/types.js';
import { resolveTicketType } from '../workflow/conventionContext.js';
import { renderBranchName } from './branchName.js';
import { worktreeSlug } from './slug.js';

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
