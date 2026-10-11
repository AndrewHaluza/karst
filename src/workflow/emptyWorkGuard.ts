import type { Manifest } from '../manifest/types.js';
import type { GitRunner } from '../integrations/git.js';
import type { Store } from '../store/db.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { planUatTargets } from './uat/targets.js';

/**
 * Refuse the impl/fix done marker when the ticket's branch carries no work.
 *
 * UAT, review and ship all probe "does any repository differ from its base?" —
 * UAT and review pass an empty answer with a note, and only ship fails it, at
 * the stage with no way out. The marker is the last point where the agent is
 * still live and can commit (or ask the user), so the same probe runs here
 * (`planUatTargets`, which counts uncommitted work as a change, exactly like
 * the gates that follow).
 *
 * The refusal fires only when every worktree mapped to a manifest repository
 * AND none changed. Anything else — no manifest, no worktrees, an unmapped
 * worktree (UAT/review block it as `unmapped-repository`), or a probe karst
 * could not answer (environmental) — keeps today's behaviour: the marker goes
 * through.
 */
export async function assertTicketHasChanges(
  store: Store,
  ticketId: number,
  manifest: Manifest | undefined,
  git: GitRunner,
  debug?: (message: string) => void,
): Promise<void> {
  if (!manifest) return;
  const worktrees = listWorktreesByTicket(store, ticketId);
  if (worktrees.length === 0) return;
  const planned = await planUatTargets(manifest, worktrees, git, { store, ticketId }, debug);
  if (planned.kind === 'unavailable') {
    debug?.(`[driver] empty-work guard: ticket ${ticketId} probe unavailable — marker allowed`);
    return;
  }
  if (planned.unmapped.length > 0 || planned.targets.length > 0) return;
  debug?.(`[driver] empty-work guard: ticket ${ticketId} no target differs from its base — refusing`);
  const where = worktrees.map((w) => `${w.path} (branch ${w.branch ?? 'unknown'})`).join(', ');
  throw new Error(
    'cannot mark this stage done: no repository has changes from its base branch, ' +
      'so there is nothing to ship. Commit your work to the ticket branch in ' +
      `${where}. If the work already exists on the base (landed by another ticket), ` +
      'ask the user instead of marking done.',
  );
}
