import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { StageKey } from '../model/types.js';
import type { GitRunner } from '../integrations/git.js';
import type { GhRunner, PrEditAttempt } from '../integrations/github.js';
import { updatePrBase } from '../integrations/github.js';
import { rebaseWorktreeOntoBase, type RebaseResult } from '../runtime/rebaseWorktree.js';
import { clearMergeCheck } from '../store/mergeChecks.js';
import { resolveTicketBaseRef } from './baseRef.js';
import { preShipState } from './rebaseState.js';
import { getTicket } from '../store/tickets.js';

export interface ChangeBaseRefOpts {
  store: Store;
  manifest: Manifest;
  ticketId: number;
  /** The WORKTREE's repoPath: base refs are per worktree, never per entry name. */
  repoPath: string;
  toBase: string;
  /** Rebase the branch onto the new base. Default true. */
  rebase?: boolean;
  git: GitRunner;
  gh?: GhRunner;
  debug?: (line: string) => void;
  /** Runs after a branch rewrite so a sandbox clone is recreated from the rebased branch. */
  afterRewrite?: () => Promise<void>;
  /** True when the sandbox clone holds commits the host branch lacks: refuses a rebase that would drop them. */
  sandboxUnsynced?: () => Promise<boolean>;
}

export interface ChangeBaseRefResult {
  ok: boolean;
  fromBase: string;
  toBase: string;
  rebase: RebaseResult | null;
  /** null when the ticket has no open PR for this repo. */
  prRetarget: (PrEditAttempt & { number: number }) | null;
  reason: string;
}

/**
 * Change a spun ticket's base branch for one repository.
 *
 * Order is the contract: the branch MOVES first, and `worktrees.base_ref` is
 * written only once git agrees. A stored base git never reached would make every
 * later diff, gate target and PR describe a merge that was never attempted.
 * The PR re-target and the merge-check invalidation come after, and neither can
 * fail the change: a refused `gh pr edit` is reported, not thrown.
 */
export async function changeBaseRef(opts: ChangeBaseRefOpts): Promise<ChangeBaseRefResult> {
  const { store, manifest, ticketId, repoPath, git, debug } = opts;
  const toBase = opts.toBase.trim();
  const fromBase = resolveTicketBaseRef(store, ticketId, repoPath, manifest);

  if (toBase === '') {
    return { ok: false, fromBase, toBase, rebase: null, prRetarget: null, reason: 'a base branch name is required' };
  }
  if (toBase === fromBase && opts.rebase === false) {
    return { ok: true, fromBase, toBase, rebase: null, prRetarget: null, reason: '' };
  }

  const row = store.db
    .prepare('SELECT path FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
    .get(ticketId, repoPath) as { path: string } | undefined;
  if (!row) {
    return {
      ok: false,
      fromBase,
      toBase,
      rebase: null,
      prRetarget: null,
      reason: `no worktree for ${repoPath} on this ticket`,
    };
  }

  debug?.(`[runtime] change base ${repoPath}: ${fromBase} -> ${toBase}`);
  const sameBase = toBase === fromBase;

  // Same base: the branch is rebased under no running agent, exactly like the
  // stage-menu "Rebase on base" (in-flight / landed refusals are shared).
  if (sameBase) {
    const guard = preShipState(store, ticketId, getTicket(store, ticketId).stageCurrent as StageKey);
    if (!guard.available && (guard.reason === 'in-flight' || guard.reason === 'landed')) {
      const reason =
        guard.reason === 'in-flight'
          ? 'an agent is working on this ticket — rebase when it is idle'
          : 'the ticket has already landed — nothing to rebase';
      return { ok: false, fromBase, toBase, rebase: null, prRetarget: null, reason };
    }
  }

  let rebase: RebaseResult | null = null;
  if (opts.rebase !== false) {
    if (opts.sandboxUnsynced && (await opts.sandboxUnsynced())) {
      return {
        ok: false,
        fromBase,
        toBase,
        rebase: null,
        prRetarget: null,
        reason: 'the sandbox has commits the host branch lacks — sync or carry them first',
      };
    }
    rebase = await rebaseWorktreeOntoBase({
      git,
      cwd: row.path,
      fromBase,
      toBase,
      debug,
      latest: sameBase,
    });
    if (rebase.outcome !== 'rebased' && rebase.outcome !== 'already-based') {
      debug?.(`[runtime] change base ${repoPath}: refused — ${rebase.outcome}`);
      return { ok: false, fromBase, toBase, rebase, prRetarget: null, reason: rebase.reason };
    }
  }

  // A rebase REWROTE every commit on this branch. If the branch is already on
  // origin — and for a ticket with an open PR it always is — the next ordinary
  // push is a non-fast-forward and will be REJECTED. Record it here, where the
  // rewrite is known, and let ship consume the flag (Task 11). Telling the user
  // in UI copy that they "will need a force-push" is not handling it.
  //
  // Both columns land in ONE statement: a crash between two separate UPDATEs
  // would leave the branch moved (git already did it) with the rewrite
  // unrecorded, so the next push is rejected with no flag to explain why.
  // `needs_force_push` is only ever ARMED here (never cleared): a call that
  // did not itself rebase (`rebase: false`, or outcome `already-based`) must
  // leave a flag some earlier change already armed exactly as it found it —
  // only `takeForcePushLease`/`armForcePushLease` (ship's push) ever clear it.
  const rebased = rebase?.outcome === 'rebased' ? 1 : 0;
  // Same base: base_ref is unchanged, so only the force-push flag is armed and
  // the PR is not re-targeted.
  store.db
    .prepare(
      `UPDATE worktrees
          SET base_ref = ?,
              needs_force_push = CASE WHEN ? = 1 THEN 1 ELSE needs_force_push END
        WHERE ticket_id = ? AND repo = ?`,
    )
    .run(toBase, rebased, ticketId, repoPath);
  clearMergeCheck(store, ticketId, repoPath);

  if (rebased && opts.afterRewrite) {
    try {
      await opts.afterRewrite();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return {
        ok: true,
        fromBase,
        toBase,
        rebase,
        prRetarget: null,
        reason: `rebased, but recreating the sandbox failed: ${why}`,
      };
    }
  }

  if (rebased) {
    debug?.(`[runtime] change base ${repoPath}: branch rewritten — force push armed`);
  }

  if (sameBase) return { ok: true, fromBase, toBase, rebase, prRetarget: null, reason: '' };

  let prRetarget: (PrEditAttempt & { number: number }) | null = null;
  const pr = store.db
    .prepare(
      `SELECT number FROM prs
        WHERE ticket_id = ? AND repo = ? AND status IN ('open', 'draft')
        LIMIT 1`,
    )
    .get(ticketId, repoPath) as { number: number } | undefined;
  if (pr && opts.gh) {
    const attempt = await updatePrBase(opts.gh, String(pr.number), row.path, toBase);
    prRetarget = { ...attempt, number: pr.number };
    debug?.(
      `[merge] change base ${repoPath}: PR #${pr.number} retarget ${attempt.ok ? 'ok' : 'refused'}`,
    );
  }

  return { ok: true, fromBase, toBase, rebase, prRetarget, reason: '' };
}

/**
 * Word a successful `changeBaseRef` outcome for a user-facing toast: rebased or
 * not, PR retargeted or not (a refusal is surfaced, never swallowed), merge
 * check cleared — never a generic "done". Shared by the dashboard's
 * change-base action and the detach operation's success report, so one branch
 * rewrite reads the same from both.
 */
export function describeChangeBaseRef(result: ChangeBaseRefResult): string {
  if (result.toBase === result.fromBase) {
    if (result.rebase === null) return `Base unchanged (${result.toBase}).`;
    const note = result.reason ? ` ${result.reason}.` : '';
    return result.rebase.outcome === 'rebased'
      ? `Rebased onto the latest ${result.toBase}.${note}`
      : `Already up to date with ${result.toBase}.`;
  }
  const parts: string[] = [
    result.rebase?.outcome === 'rebased'
      ? `Rebased onto ${result.toBase}.`
      : `Re-targeted to ${result.toBase} (not rebased).`,
  ];
  if (result.prRetarget) {
    parts.push(
      result.prRetarget.ok
        ? `PR #${result.prRetarget.number} re-targeted.`
        : `PR #${result.prRetarget.number} re-target refused.`,
    );
  }
  parts.push('Merge check cleared.');
  return parts.join(' ');
}
